/**
 * Parser for Claude.ai's official data export ("conversations.json" from
 * Settings -> Account -> Export Data).
 *
 * Each conversation has a flat, already-ordered "chat_messages" array with
 * sender "human" or "assistant", so pairing is much simpler than ChatGPT's
 * tree structure. Note: Claude's export does not currently include the
 * specific model used per message, so we fall back to a documented default
 * model name for the EcoLogits estimate.
 */

const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  if (!text) return 0;
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';

function extractText(message) {
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text.trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block && (block.type === 'text' || typeof block.text === 'string'))
      .map((block) => block.text || '')
      .join('\n')
      .trim();
  }
  return '';
}

function parseClaudeExport(conversationsJsonText) {
  const conversations = JSON.parse(conversationsJsonText);
  const turns = [];
  let conversationCount = 0;

  for (const conversation of conversations) {
    conversationCount += 1;
    const messages = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [];
    const model = conversation.model || DEFAULT_CLAUDE_MODEL;

    let pendingUser = null;
    const flushUnanswered = () => {
      if (!pendingUser) return;
      turns.push({
        assistant: 'claude',
        model,
        timestamp: pendingUser.createdAt || new Date().toISOString(),
        promptTokens: estimateTokens(pendingUser.text),
        completionTokens: 0,
      });
      pendingUser = null;
    };

    for (const msg of messages) {
      const text = extractText(msg);
      if (!text) continue;
      const sender = msg.sender;

      if (sender === 'human') {
        flushUnanswered();
        pendingUser = { text, createdAt: msg.created_at };
      } else if (sender === 'assistant' && pendingUser) {
        turns.push({
          assistant: 'claude',
          model: msg.model || model,
          timestamp: msg.created_at || pendingUser.createdAt || new Date().toISOString(),
          promptTokens: estimateTokens(pendingUser.text),
          completionTokens: estimateTokens(text),
        });
        pendingUser = null;
      }
    }
    flushUnanswered();
  }

  return { turns, conversationCount, modelAssumed: true };
}

module.exports = { parseClaudeExport, DEFAULT_CLAUDE_MODEL };
