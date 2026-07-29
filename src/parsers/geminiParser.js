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

const { estimateTokens } = require('../tokenizer');

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
// Rough assumed average reply length, since Takeout doesn't include it.
const ASSUMED_COMPLETION_TOKENS = 220;

function extractPromptText(title) {
  if (!title) return '';
  const match = title.match(/with\s+"?(.*?)"?$/i);
  if (match && match[1]) return match[1].trim();
  return title.replace(/^Asked Gemini Apps\s*/i, '').trim();
}

function parseGeminiExport(activityJsonText) {
  const records = JSON.parse(activityJsonText);
  const turns = [];
  let promptCount = 0;

  for (const record of records) {
    const isGemini =
      record.header && /gemini/i.test(record.header) ||
      (Array.isArray(record.products) && record.products.some((p) => /gemini/i.test(p)));
    if (!isGemini) continue;

    const promptText = extractPromptText(record.title);
    if (!promptText) continue;

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

module.exports = { parseGeminiExport, DEFAULT_GEMINI_MODEL, ASSUMED_COMPLETION_TOKENS };
