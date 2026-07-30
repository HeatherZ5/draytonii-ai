/**
 * Best-effort parser for Gemini usage exported via Google Takeout
 * ("My Activity" -> "Gemini Apps" -> MyActivity.json).
 *
 * Unlike ChatGPT and Claude, Google Takeout does not export full
 * conversations - it exports an activity log with just the prompt text
 * ("Prompted Gemini Apps with '...'"), a timestamp, and no response text
 * and no model name. So this parser can only recover prompt counts and
 * prompt token estimates reliably; response length and model are filled
 * in with documented, clearly-flagged assumptions so the CO2/energy
 * numbers for Gemini should be read as rougher estimates than the
 * ChatGPT/Claude figures.
 */

const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  if (!text) return 0;
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
// Rough assumed average reply length, since Takeout doesn't include it.
const ASSUMED_COMPLETION_TOKENS = 220;

function extractPromptText(title) {
  if (!title) return '';
  const match = title.match(/with\s+"?(.*?)"?$/i);
  if (match && match[1]) return match[1].trim();
  return title.replace(/^Asked Gemini Apps\s*/i, '').trim();
}

/**
 * Runs over already-parsed activity records (possibly merged from several
 * MyActivity.json files found in the upload) and keeps only the ones that
 * are actually Gemini activity - everything else (Search, YouTube, Maps,
 * etc. also export a "MyActivity.json") is silently skipped here, which is
 * what lets callers merge records from multiple/unknown files without
 * needing to know in advance which file is the "real" Gemini one.
 */
function parseGeminiRecords(records) {
  const turns = [];
  let promptCount = 0;
  const seen = new Set();

  for (const record of records) {
    // Only records whose header is exactly "Gemini Apps" are real prompts
    // typed into the Gemini app/website. A loose substring match on
    // header/products also sweeps in Gemini-flavored features baked into
    // other Google products (Search, Workspace, etc.), which massively
    // overcounts.
    const isGemini = typeof record.header === 'string' && record.header.trim().toLowerCase() === 'gemini apps';
    if (!isGemini) continue;

    const promptText = extractPromptText(record.title);
    if (!promptText) continue;

    const dedupeKey = `${record.time || ''}::${record.title || ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    promptCount += 1;
    turns.push({
      assistant: 'gemini',
      model: DEFAULT_GEMINI_MODEL,
      timestamp: record.time || new Date().toISOString(),
      promptTokens: estimateTokens(promptText),
      completionTokens: ASSUMED_COMPLETION_TOKENS,
      responseEstimated: true,
    });
  }

  return { turns, conversationCount: promptCount, modelAssumed: true, responseTextUnavailable: true };
}

function parseGeminiExport(activityJsonText) {
  const records = JSON.parse(activityJsonText);
  return parseGeminiRecords(records);
}

module.exports = {
  parseGeminiExport,
  parseGeminiRecords,
  DEFAULT_GEMINI_MODEL,
  ASSUMED_COMPLETION_TOKENS,
};
