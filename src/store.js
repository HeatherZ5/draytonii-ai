/**
 * Persistence via Supabase (a single row holding the whole aggregated
 * store as JSON), so data survives across serverless invocations instead
 * of relying on local disk, which Vercel resets between/within instances.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gktqfahsoaiyecoxczix.supabase.co';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrdHFmYWhzb2FpeWVjb3hjeml4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTM2ODkxOSwiZXhwIjoyMTAwOTQ0OTE5fQ.y_C1-CkJhH4wfyViDKomEDK8axDUTrZMkKn9zNn0-U0';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const EMPTY_STORE = { days: {} };

async function loadStore() {
  const { data, error } = await supabase.from('app_store').select('data').eq('id', 1).single();
  if (error || !data) return structuredClone(EMPTY_STORE);
  return data.data;
}

async function saveStore(store) {
  await supabase.from('app_store').upsert({ id: 1, data: store });
}

function emptyAssistantBucket() {
  return {
    prompts: 0,
    tokensIn: 0,
    tokensOut: 0,
    energyKwh: 0,
    energyMin: 0,
    energyMax: 0,
    co2Kg: 0,
    co2Min: 0,
    co2Max: 0,
    waterL: 0,
    waterMin: 0,
    waterMax: 0,
    waterCount: 0,
    mineralsKg: 0,
    mineralsMin: 0,
    mineralsMax: 0,
    mineralsCount: 0,
    ecologitsCount: 0,
    fallbackCount: 0,
  };
}

async function resetStore() {
  const empty = structuredClone(EMPTY_STORE);
  await saveStore(empty);
  return empty;
}

module.exports = { loadStore, saveStore, resetStore, emptyAssistantBucket };
