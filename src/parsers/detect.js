/**
 * Figures out which AI platform a zip export came from by inspecting the
 * file names inside the archive and, when needed, peeking at the shape of
 * conversations.json (both ChatGPT and Claude exports use that exact file
 * name, so name-matching alone isn't enough).
 *
 * Entries here are plain objects { entryName, readText() } - readText()
 * returns a Promise<string> - so this module doesn't care which zip
 * library produced them.
 */

function findEntry(entries, matcher) {
  return entries.find((e) => matcher.test(e.entryName)) || null;
}

function findAllEntries(entries, matcher) {
  return entries.filter((e) => matcher.test(e.entryName));
}

// Matches "MyActivity.json" (any case) at any depth in the archive - Google
// Takeout exports one of these per product (Search, YouTube, Maps, Gemini,
// etc.), so a real-world "My Activity" folder can contain many of them
// scattered across sibling product folders. We deliberately don't try to
// pick the "right" one by path/folder name here - every match gets parsed
// and the actual Gemini records are picked out by content afterward, which
// is robust to whatever folder structure Takeout (or the user) produced.
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
    // conversations.json exists but shape is unrecognized - still worth a
    // best-effort attempt, default to whichever export also has telltale
    // sibling files.
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

/**
 * Used when the user tells us which platform the export came from via the
 * upload toggle, instead of guessing from conversations.json's shape.
 * ChatGPT and Claude both name their export file "conversations.json", so
 * shape-guessing is the main source of misdetection - trusting the user's
 * explicit choice avoids that ambiguity entirely.
 */
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

module.exports = { detectPlatform, detectPlatformExplicit };
