/**
 * Turns a flat list of parsed conversation "turns" (one user prompt +
 * one assistant reply each) into per-day, per-assistant totals, calling
 * the EcoLogits estimator for each assistant reply along the way, then
 * merges those totals into the persistent store.
 *
 * Merge rule: for any (day, assistant) pair present in the newly ingested
 * turns, the new data fully replaces whatever was stored for that pair -
 * it does not add on top of it. Days/assistants NOT mentioned in this
 * batch are left completely untouched. This lets a re-uploaded export
 * (which may have re-parsed the same days more accurately) take priority
 * without silently doubling counts, while older imported days that the
 * new upload doesn't cover stay put.
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
  const store = await loadStore();

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
  const touched = new Set();

  turns.forEach((turn, i) => {
    const day = dateKey(turn.timestamp);
    if (!store.days[day]) store.days[day] = {};

    const touchKey = `${day}::${turn.assistant}`;
    if (!touched.has(touchKey)) {
      touched.add(touchKey);
      store.days[day][turn.assistant] = emptyAssistantBucket();
    }

    const bucket = store.days[day][turn.assistant];
    const impact = impacts[i];

    bucket.prompts += 1;
    bucket.tokensIn += turn.promptTokens;
    bucket.tokensOut += turn.completionTokens;
    bucket.energyKwh += impact.energyKwh;
    bucket.energyMin += impact.energyMin;
    bucket.energyMax += impact.energyMax;
    bucket.co2Kg += impact.co2Kg;
    bucket.co2Min += impact.co2Min;
    bucket.co2Max += impact.co2Max;
    if (impact.waterL !== null && impact.waterL !== undefined) {
      bucket.waterL += impact.waterL;
      bucket.waterMin += impact.waterMin;
      bucket.waterMax += impact.waterMax;
      bucket.waterCount += 1;
    }
    if (impact.mineralsKg !== null && impact.mineralsKg !== undefined) {
      bucket.mineralsKg += impact.mineralsKg;
      bucket.mineralsMin += impact.mineralsMin;
      bucket.mineralsMax += impact.mineralsMax;
      bucket.mineralsCount += 1;
    }
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

  await saveStore(store);

  return {
    turnsIngested: turns.length,
    ecologitsCount,
    fallbackCount,
    dateRange: minDate && maxDate ? { from: minDate, to: maxDate } : null,
  };
}

module.exports = { ingestTurns, dateKey };
