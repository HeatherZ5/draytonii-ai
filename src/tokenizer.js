/**
 * Very lightweight token estimator.
 *
 * None of the official export files (ChatGPT, Claude, Gemini) include real
 * token counts, so we approximate using the common rule of thumb that
 * 1 token is roughly 4 characters of English text (used widely as a fast
 * estimate for OpenAI/Anthropic-style tokenizers). This will not exactly
 * match a real tokenizer, but it is a reasonable, transparent approximation
 * for a personal usage dashboard.
 */

const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  if (!text) return 0;
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

module.exports = { estimateTokens, CHARS_PER_TOKEN };
