/**
 * Builds the numbers the dashboard needs for a given period toggle
 * (day / week / month / year). Windows are rolling and anchored to the
 * most recent date present in the data (not necessarily "today"), so
 * imported historical chat exports show up immediately instead of the
 * dashboard looking empty just because the export is older than today.
 */

const { loadStore, emptyAssistantBucket } = require('./store');

const WINDOW_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const ASSISTANTS = ['chatgpt', 'claude', 'gemini'];

function toDate(dayKey) {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

function formatDay(date) {
  return date.toISOString().slice(0, 10);
}

function latestDay(store) {
  const days = Object.keys(store.days);
  if (days.length === 0) return formatDay(new Date());
  return days.sort().at(-1);
}

function getStatsForPeriod(period) {
  const store = loadStore();
  const windowDays = WINDOW_DAYS[period] || WINDOW_DAYS.day;
  const anchor = toDate(latestDay(store));
  const rangeEnd = formatDay(anchor);
  const rangeStartDate = new Date(anchor);
  rangeStartDate.setUTCDate(rangeStartDate.getUTCDate() - (windowDays - 1));
  const rangeStart = formatDay(rangeStartDate);

  const byAssistant = {};
  for (const a of ASSISTANTS) byAssistant[a] = emptyAssistantBucket();

  for (const [day, assistants] of Object.entries(store.days)) {
    if (day < rangeStart || day > rangeEnd) continue;
    for (const [assistant, bucket] of Object.entries(assistants)) {
      if (!byAssistant[assistant]) byAssistant[assistant] = emptyAssistantBucket();
      byAssistant[assistant].prompts += bucket.prompts;
      byAssistant[assistant].tokensIn += bucket.tokensIn;
      byAssistant[assistant].tokensOut += bucket.tokensOut;
      byAssistant[assistant].energyKwh += bucket.energyKwh;
      byAssistant[assistant].co2Kg += bucket.co2Kg;
      byAssistant[assistant].ecologitsCount += bucket.ecologitsCount;
      byAssistant[assistant].fallbackCount += bucket.fallbackCount;
    }
  }

  const totals = { prompts: 0, tokensIn: 0, tokensOut: 0, energyKwh: 0, co2Kg: 0 };
  for (const bucket of Object.values(byAssistant)) {
    totals.prompts += bucket.prompts;
    totals.tokensIn += bucket.tokensIn;
    totals.tokensOut += bucket.tokensOut;
    totals.energyKwh += bucket.energyKwh;
    totals.co2Kg += bucket.co2Kg;
  }

  const hasAnyData = Object.keys(store.days).length > 0;

  return {
    period,
    rangeStart,
    rangeEnd,
    hasAnyData,
    totals,
    byAssistant,
  };
}

module.exports = { getStatsForPeriod, ASSISTANTS, WINDOW_DAYS };
