/**
 * Turns a flat list of parsed conversation "turns" (one user prompt +
 * one assistant reply each) into per-day, per-assistant totals, calling
 * the EcoLogits estimator for each assistant reply along the way, then
 * merges those totals into the persistent store.
 */

const { loadStore, saveStore, emptyAssistantBucket } = require('./store');
const { estimateImpact } = require('./ecologits');

const CONCURRENCY = 6;

function dateKey(isoTimestamp) {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function ingestTurns(turns) {
  const store = loadStore();

  const impacts = await mapWithConcurrency(turns, CONCURRENCY, (turn) =>
    estimateImpact({
      assistant: turn.assistant,
      model: turn.model,
      outputTokens: turn.completionTokens,
    })
  );

  let ecologitsCount = 0;
  let fallbackCount = 0;
  let minDate = null;
  let maxDate = null;

  turns.forEach((turn, i) => {
    const day = dateKey(turn.timestamp);
    if (!store.days[day]) store.days[day] = {};
    if (!store.days[day][turn.assistant]) store.days[day][turn.assistant] = emptyAssistantBucket();

    const bucket = store.days[day][turn.assistant];
    const impact = impacts[i];

    bucket.prompts += 1;
    bucket.tokensIn += turn.promptTokens;
    bucket.tokensOut += turn.completionTokens;
    bucket.energyKwh += impact.energyKwh;
    bucket.co2Kg += impact.co2Kg;
    if (impact.source === 'ecologits') {
      bucket.ecologitsCount += 1;
      ecologitsCount += 1;
    } else {
      bucket.fallbackCount += 1;
      fallbackCount += 1;
    }

    if (!minDate || day < minDate) minDate = day;
    if (!maxDate || day > maxDate) maxDate = day;
  });

  saveStore(store);

  return {
    turnsIngested: turns.length,
    ecologitsCount,
    fallbackCount,
    dateRange: minDate && maxDate ? { from: minDate, to: maxDate } : null,
  };
}

module.exports = { ingestTurns, dateKey };
