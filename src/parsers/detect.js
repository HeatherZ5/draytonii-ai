/**
 * Figures out which AI platform a zip export came from by inspecting the
 * file names inside the archive and, when needed, peeking at the shape of
 * conversations.json (both ChatGPT and Claude exports use that exact file
 * name, so name-matching alone isn't enough).
 */

function findEntry(entries, matcher) {
  return entries.find((e) => matcher.test(e.entryName)) || null;
}

function detectPlatform(zip) {
  const entries = zip.getEntries();
  const names = entries.map((e) => e.entryName);

  const conversationsEntry = findEntry(entries, /(^|\/)conversations\.json$/i);
  const geminiActivityEntry = findEntry(
    entries,
    /(gemini|bard)[^/]*[\\/].*MyActivity\.json$/i
  ) || findEntry(entries, /(^|\/)MyActivity\.json$/i);

  if (conversationsEntry) {
    let sample = null;
    try {
      const raw = JSON.parse(conversationsEntry.getData().toString('utf8'));
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

  if (geminiActivityEntry) {
    return { platform: 'gemini', activityEntry: geminiActivityEntry, names };
  }

  return { platform: 'unknown', names };
}

module.exports = { detectPlatform };
