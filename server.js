const path = require('path');
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');

const { detectPlatform } = require('./src/parsers/detect');
const { parseChatGptExport } = require('./src/parsers/chatgptParser');
const { parseClaudeExport } = require('./src/parsers/claudeParser');
const { parseGeminiExport } = require('./src/parsers/geminiParser');
const { ingestTurns } = require('./src/aggregator');
const { getStatsForPeriod } = require('./src/periods');
const { resetStore } = require('./src/store');
const { checkConnectivity } = require('./src/ecologits');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/ecologits-status', async (req, res) => {
  const reachable = await checkConnectivity();
  res.json({ reachable });
});

app.get('/api/stats', (req, res) => {
  const period = ['day', 'week', 'month', 'year'].includes(req.query.period)
    ? req.query.period
    : 'day';
  res.json(getStatsForPeriod(period));
});

app.post('/api/reset', (req, res) => {
  resetStore();
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('exportZip'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Attach a .zip export under field "exportZip".' });
  }

  let zip;
  try {
    zip = new AdmZip(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: 'Could not read the uploaded file as a zip archive.' });
  }

  const detection = detectPlatform(zip);

  try {
    let parsed;
    if (detection.platform === 'chatgpt') {
      const text = detection.conversationsEntry.getData().toString('utf8');
      parsed = parseChatGptExport(text);
    } else if (detection.platform === 'claude') {
      const text = detection.conversationsEntry.getData().toString('utf8');
      parsed = parseClaudeExport(text);
    } else if (detection.platform === 'gemini') {
      const text = detection.activityEntry.getData().toString('utf8');
      parsed = parseGeminiExport(text);
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
  console.log(`AI Sustainability Tracker running at http://localhost:${PORT}`);
});
