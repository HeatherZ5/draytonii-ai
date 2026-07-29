/**
 * Parser for OpenAI's official ChatGPT data export ("conversations.json"
 * inside the zip from Settings -> Data Controls -> Export Data).
 *
 * ChatGPT stores each conversation as a tree ("mapping") of nodes rather
 * than a flat message list, because branches are created whenever a
 * message is edited or regenerated. We flatten each conversation to its
 * messages (sorted by create_time) and pair up consecutive
 * user -> assistant text messages into "turns".
 */

const { estimateTokens } = require('../tokenizer');

function extractText(content) {
  if (!content) return '';
  const { content_type: type, parts } = content;
  if (type === 'text' || type === 'multimodal_text') {
    if (!Array.isArray(parts)) return '';
    return parts
      .filter((p) => typeof p === 'string')
      .join('\n')
      .trim();
  }
  return '';
}

function flattenConversation(conversation) {
  const mapping = conversation.mapping || {};
  const messages = [];

  for (const nodeId of Object.keys(mapping)) {
    const node = mapping[nodeId];
    const message = node && node.message;
    if (!message || !message.author) continue;
    const role = message.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractText(message.content);
    if (!text) continue;
    messages.push({
      role,
      text,
      createTime: message.create_time || conversation.create_time || 0,
      model: message.metadata && message.metadata.model_slug,
    });
  }

  messages.sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
  return messages;
}

function parseChatGptExport(conversationsJsonText) {
  const conversations = JSON.parse(conversationsJsonText);
  const turns = [];
  let conversationCount = 0;

  for (const conversation of conversations) {
    conversationCount += 1;
    const messages = flattenConversation(conversation);

    let pendingUser = null;
    for (const msg of messages) {
      if (msg.role === 'user') {
        pendingUser = msg;
      } else if (msg.role === 'assistant' && pendingUser) {
        turns.push({
          assistant: 'chatgpt',
          model: msg.model || 'gpt-4o-mini',
          timestamp: new Date((msg.createTime || pendingUser.createTime || 0) * 1000).toISOString(),
          promptTokens: estimateTokens(pendingUser.text),
          completionTokens: estimateTokens(msg.text),
        });
        pendingUser = null;
      }
    }
  }

  return { turns, conversationCount };
}

module.exports = { parseChatGptExport };
