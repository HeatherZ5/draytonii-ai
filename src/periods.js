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
const SUM_FIELDS = [
  'prompts', 'tokensIn', 'tokensOut',
  'energyKwh', 'energyMin', 'energyMax',
  'co2Kg', 'co2Min', 'co2Max',
  'waterL', 'waterMin', 'waterMax', 'waterCount',
  'mineralsKg', 'mineralsMin', 'mineralsMax', 'mineralsCount',
  'ecologitsCount', 'fallbackCount',
];

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

async function getStatsForPeriod(period) {
  const store = await loadStore();
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
      for (const field of SUM_FIELDS) {
        byAssistant[assistant][field] += bucket[field] || 0;
      }
    }
  }

  const totals = {};
  for (const field of SUM_FIELDS) totals[field] = 0;
  for (const bucket of Object.values(byAssistant)) {
    for (const field of SUM_FIELDS) totals[field] += bucket[field];
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

/**
 * Per-day prompt counts (all-time, all days present in the store) broken
 * down by assistant, for the calendar carousel. Kept small and simple -
 * the client groups these into months and computes its own color tiers.
 */
async function getCalendarData() {
  const store = await loadStore();
  const days = {};
  for (const [day, assistants] of Object.entries(store.days)) {
    const perAssistant = {};
    let total = 0;
    for (const key of ASSISTANTS) {
      const prompts = (assistants[key] && assistants[key].prompts) || 0;
      perAssistant[key] = prompts;
      total += prompts;
    }
    days[day] = { ...perAssistant, total };
  }
  return { days };
}

module.exports = { getStatsForPeriod, getCalendarData, ASSISTANTS, WINDOW_DAYS };
