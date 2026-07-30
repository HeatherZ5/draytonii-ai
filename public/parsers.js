/**
 * Browser port of the server-side export parsers (src/parsers/*.js).
 * Runs entirely client-side so the raw zip - which can be far larger than
 * Vercel's ~4.5MB serverless request body limit - never has to be uploaded.
 * Only the small derived numbers (token counts, timestamps) get sent to
 * the server afterward, via /api/ingest.
 */
(function (global) {
  const CHARS_PER_TOKEN = 4;

  function estimateTokens(text) {
    if (!text) return 0;
    const trimmed = String(text).trim();
    if (!trimmed) return 0;
    return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
  }

  // --- zip entry helpers -------------------------------------------------

  function findEntry(entries, matcher) {
    return entries.find((e) => matcher.test(e.entryName)) || null;
  }

  function findAllEntries(entries, matcher) {
    return entries.filter((e) => matcher.test(e.entryName));
  }

  const MY_ACTIVITY_FILE_PATTERN = /(^|\/)MyActivity\.json$/i;

  function findAllGeminiActivityEntries(entries) {
    return findAllEntries(entries, MY_ACTIVITY_FILE_PATTERN);
  }

  async function detectPlatform(entries) {
    const names = entries.map((e) => e.entryName);
    const conversationsEntry = findEntry(entries, /(^|\/)conversations\.json$/i);
    const geminiActivityEntries = findAllGeminiActivityEntries(entries);

    if (conversationsEntry) {
      let sample = null;
      try {
        const raw = JSON.parse(await conversationsEntry.readText());
        sample = Array.isArray(raw) && raw.length > 0 ? raw[0] : null;
      } catch (e) {
        sample = null;
      }
      if (sample && Object.prototype.hasOwnProperty.call(sample, 'mapping')) {
        return { platform: 'chatgpt', conversationsEntry, names };
      }
      if (sample && Object.prototype.hasOwnProperty.call(sample, 'chat_messages')) {
        return { platform: 'claude', conversationsEntry, names };
      }
      if (findEntry(entries, /(^|\/)chat\.html$/i)) {
        return { platform: 'chatgpt', conversationsEntry, names };
      }
      if (findEntry(entries, /(^|\/)users\.json$/i)) {
        return { platform: 'claude', conversationsEntry, names };
      }
      return { platform: 'unknown', conversationsEntry, names };
    }

    if (geminiActivityEntries.length > 0) {
      return { platform: 'gemini', activityEntries: geminiActivityEntries, names };
    }
    return { platform: 'unknown', names };
  }

  async function detectPlatformExplicit(entries, platform) {
    const names = entries.map((e) => e.entryName);
    if (platform === 'gemini') {
      const activityEntries = findAllGeminiActivityEntries(entries);
      if (activityEntries.length === 0) return { platform: 'unknown', names, expected: platform };
      return { platform: 'gemini', activityEntries, names };
    }
    const conversationsEntry = findEntry(entries, /(^|\/)conversations\.json$/i);
    if (!conversationsEntry) return { platform: 'unknown', names, expected: platform };
    return { platform, conversationsEntry, names };
  }

  // --- ChatGPT -------------------------------------------------------------

  function extractChatGptText(content) {
    if (!content) return '';
    const type = content.content_type;
    const parts = content.parts;
    if (type === 'text' || type === 'multimodal_text') {
      if (!Array.isArray(parts)) return '';
      return parts.filter((p) => typeof p === 'string').join('\n').trim();
    }
    return '';
  }

  function flattenChatGptConversation(conversation) {
    const mapping = conversation.mapping || {};
    const messages = [];
    for (const nodeId of Object.keys(mapping)) {
      const node = mapping[nodeId];
      const message = node && node.message;
      if (!message || !message.author) continue;
      const role = message.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractChatGptText(message.content);
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
      const messages = flattenChatGptConversation(conversation);
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

  // --- Claude ---------------------------------------------------------------

  const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';

  function extractClaudeText(message) {
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
        const text = extractClaudeText(msg);
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

  // --- Gemini ---------------------------------------------------------------

  const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
  const ASSUMED_COMPLETION_TOKENS = 220;

  function extractGeminiPromptText(title) {
    if (!title) return '';
    const match = title.match(/with\s+"?(.*?)"?$/i);
    if (match && match[1]) return match[1].trim();
    return title.replace(/^Asked Gemini Apps\s*/i, '').trim();
  }

  function parseGeminiRecords(records) {
    const turns = [];
    let promptCount = 0;
    const seen = new Set();
    for (const record of records) {
      // Only records whose header is exactly "Gemini Apps" are real prompts
      // typed into the Gemini app/website - a loose substring match on
      // header/products also sweeps in Gemini-flavored features baked into
      // other Google products (Search, Workspace, etc.), which overcounts.
      const isGemini = typeof record.header === 'string' && record.header.trim().toLowerCase() === 'gemini apps';
      if (!isGemini) continue;
      const promptText = extractGeminiPromptText(record.title);
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

  // --- Top-level: unzip + detect + parse in one call ------------------------

  async function parseExportZip(arrayBuffer, requestedPlatform) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const entries = Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => ({ entryName: f.name, readText: () => f.async('string') }));

    const detection = requestedPlatform
      ? await detectPlatformExplicit(entries, requestedPlatform)
      : await detectPlatform(entries);

    if (detection.platform === 'chatgpt') {
      const text = await detection.conversationsEntry.readText();
      return { detection, parsed: parseChatGptExport(text) };
    }
    if (detection.platform === 'claude') {
      const text = await detection.conversationsEntry.readText();
      return { detection, parsed: parseClaudeExport(text) };
    }
    if (detection.platform === 'gemini') {
      const records = [];
      for (const entry of detection.activityEntries) {
        try {
          const parsedJson = JSON.parse(await entry.readText());
          if (Array.isArray(parsedJson)) records.push(...parsedJson);
        } catch (e) {
          // Skip any MyActivity.json that isn't valid JSON.
        }
      }
      return { detection, parsed: parseGeminiRecords(records) };
    }
    return { detection, parsed: null };
  }

  global.DraytoniiParsers = { parseExportZip };
})(window);
