/**
 * Minimal JSON-file "database". This is a personal, single-user demo app,
 * so a plain JSON file on disk (data/store.json) stands in for a real
 * database. Data is aggregated per calendar day (UTC) per assistant.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const EMPTY_STORE = { days: {} };

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) return structuredClone(EMPTY_STORE);
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.days) return structuredClone(EMPTY_STORE);
    return parsed;
  } catch (e) {
    return structuredClone(EMPTY_STORE);
  }
}

function saveStore(store) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function emptyAssistantBucket() {
  return {
    prompts: 0,
    tokensIn: 0,
    tokensOut: 0,
    energyKwh: 0,
    co2Kg: 0,
    ecologitsCount: 0,
    fallbackCount: 0,
  };
}

function resetStore() {
  const empty = structuredClone(EMPTY_STORE);
  saveStore(empty);
  return empty;
}

module.exports = { loadStore, saveStore, resetStore, emptyAssistantBucket, STORE_PATH };
