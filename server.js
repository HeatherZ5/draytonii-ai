const path = require('path');
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');

const { detectPlatform, detectPlatformExplicit } = require('./src/parsers/detect');
const { parseChatGptExport } = require('./src/parsers/chatgptParser');
const { parseClaudeExport } = require('./src/parsers/claudeParser');
const { parseGeminiRecords } = require('./src/parsers/geminiParser');
const { ingestTurns } = require('./src/aggregator');
const { getStatsForPeriod, getCalendarData } = require('./src/periods');
const { resetStore } = require('./src/store');
const { checkConnectivity } = require('./src/ecologits');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/ecologits-status', async (req, res) => {
  const reachable = await checkConnectivity();
  res.json({ reachable });
});

app.get('/api/stats', async (req, res) => {
  const period = ['day', 'week', 'month', 'year'].includes(req.query.period)
    ? req.query.period
    : 'day';
  res.json(await getStatsForPeriod(period));
});

app.get('/api/calendar', async (req, res) => {
  res.json(await getCalendarData());
});

app.post('/api/reset', async (req, res) => {
  await resetStore();
  res.json({ ok: true });
});

// Preferred path: the browser unzips and parses the export itself (see
// public/parsers.js) and only posts the small derived numbers here. This
// avoids Vercel's ~4.5MB serverless request body limit, which raw export
// zips can easily exceed.
app.post('/api/ingest', async (req, res) => {
  const { platform, turns, conversationCount, modelAssumed, responseTextUnavailable, resetKeys } = req.body || {};

  if (!['chatgpt', 'claude', 'gemini'].includes(platform)) {
    return res.status(400).json({ error: 'Missing or invalid "platform".' });
  }
  if (!Array.isArray(turns) || turns.length === 0) {
    return res.status(422).json({
      error: `Recognized this as a ${platform} export, but found no readable conversation turns inside it.`,
    });
  }

  try {
    const ingestSummary = await ingestTurns(turns, resetKeys);
    res.json({
      platform,
      conversationsFound: conversationCount,
      modelAssumed: !!modelAssumed,
      responseTextUnavailable: !!responseTextUnavailable,
      ...ingestSummary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Failed to process the export: ${err.message}` });
  }
});

// Legacy path: uploads the raw zip for server-side parsing. Kept for local
// use (npm start) where there's no serverless body-size limit; the
// deployed dashboard uses /api/ingest instead.
app.post('/api/upload', upload.single('exportZip'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Attach a .zip export under field "exportZip".' });
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: 'Could not read the uploaded file as a zip archive.' });
  }

  const entries = Object.values(zip.files)
    .filter((f) => !f.dir)
    .map((f) => ({ entryName: f.name, readText: () => f.async('string') }));

  const requestedPlatform = ['chatgpt', 'claude', 'gemini'].includes(req.body.platform)
    ? req.body.platform
    : null;
  const detection = requestedPlatform
    ? await detectPlatformExplicit(entries, requestedPlatform)
    : await detectPlatform(entries);

  try {
    let parsed;
    if (detection.platform === 'chatgpt') {
      const text = await detection.conversationsEntry.readText();
      parsed = parseChatGptExport(text);
    } else if (detection.platform === 'claude') {
      const text = await detection.conversationsEntry.readText();
      parsed = parseClaudeExport(text);
    } else if (detection.platform === 'gemini') {
      const records = [];
      for (const entry of detection.activityEntries) {
        try {
          const parsedJson = JSON.parse(await entry.readText());
          if (Array.isArray(parsedJson)) records.push(...parsedJson);
        } catch (e) {
          // Skip any MyActivity.json that isn't valid JSON - other product
          // folders in a full Takeout export shouldn't block Gemini parsing.
        }
      }
      parsed = parseGeminiRecords(records);
    } else if (requestedPlatform) {
      const expectedFile = requestedPlatform === 'gemini' ? 'MyActivity.json' : 'conversations.json';
      return res.status(422).json({
        error:
          `You selected ${requestedPlatform}, but this zip doesn't contain the expected ` +
          `${expectedFile} file for that platform. Double-check the toggle matches the ` +
          'export you are uploading.',
        filesInZip: detection.names,
      });
    } else {
      return res.status(422).json({
        error:
          "Couldn't recognize this zip as a ChatGPT, Claude, or Gemini export. " +
          'Expected a conversations.json (ChatGPT/Claude) or a Google Takeout ' +
          "'Gemini Apps' MyActivity.json.",
      });
    }

    if (!parsed.turns || parsed.turns.length === 0) {
      return res.status(422).json({
        error: `Recognized this as a ${detection.platform} export, but found no readable conversation turns inside it.`,
      });
    }

    const ingestSummary = await ingestTurns(parsed.turns);

    res.json({
      platform: detection.platform,
      conversationsFound: parsed.conversationCount,
      modelAssumed: !!parsed.modelAssumed,
      responseTextUnavailable: !!parsed.responseTextUnavailable,
      ...ingestSummary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Failed to process the export: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Project Draytonii running at http://localhost:${PORT}`);
});
