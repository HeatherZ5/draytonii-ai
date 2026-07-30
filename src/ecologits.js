/**
 * Thin client for the public EcoLogits API (https://ecologits.ai), which
 * estimates the environmental impact of a single LLM inference request
 * given a provider, model name, and output token count.
 *
 *   POST https://api.ecologits.ai/v1beta/estimations
 *   { provider, model_name, output_token_count, electricity_mix_zone? }
 *
 * The API returns min/max ranges for several metrics: energy (kWh), gwp
 * (kgCO2eq), wcf (water consumption footprint, L), and adpe (abiotic
 * depletion potential of elements - "minerals & metals", kgSbeq). We use
 * the midpoint of each as our point estimate but keep the min/max around
 * too, so the UI can show the real range EcoLogits reported.
 *
 * Minerals are only ever reported when the live EcoLogits call succeeds -
 * there is no local fallback for that metric, since no public per-query
 * bill-of-materials data exists for any of these assistants (see
 * fallbackEstimate below). Water has a fallback ONLY for Gemini, using
 * Google's own first-party measured figure; ChatGPT/Claude have no
 * comparably-sourced modern water number, so their water stays
 * unavailable when EcoLogits itself doesn't return it.
 */

const ECOLOGITS_BASE_URL = 'https://api.ecologits.ai/v1beta';
const REQUEST_TIMEOUT_MS = 8000;

const PROVIDER_BY_ASSISTANT = {
  chatgpt: 'openai',
  claude: 'anthropic',
  gemini: 'google_genai',
};

// --- Fallback formula (used only when the live API is unreachable) -------
//
// Per-assistant figures below are calibrated from published sources rather
// than a generic order-of-magnitude guess, since first-party measurement
// quality differs a lot by company:
//
//   Gemini:  Google's own production-measured figures for a median Gemini
//            Apps text prompt - 0.24 Wh energy, 0.03 gCO2e, 0.26 mL water.
//            "Measuring the Environmental Impact of Delivering AI at
//            Google Scale" (Aug 2025), arXiv:2508.15734. This is the only
//            one of the three with a first-party technical methodology
//            paper, so we use its energy/CO2/water numbers directly here
//            (not just energy, unlike ChatGPT/Claude below).
//
//   ChatGPT: Epoch AI's independent (non-OpenAI) 2025 estimate of ~0.3 Wh
//            per GPT-4o query - https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use
//            OpenAI itself has only given a public claim (Sam Altman,
//            0.34 Wh, June 2025), not a technical report, so we prefer
//            the independently-derived figure. No first-party CO2/water
//            number exists for ChatGPT, so those still derive from grid
//            carbon intensity below rather than a direct measurement.
//
//   Claude:  Anthropic has not published any per-query energy, carbon, or
//            water figure as of mid-2026 - confirmed absent across every
//            source surveyed. With no Claude-specific data to calibrate
//            against, we extrapolate by averaging the ChatGPT and Gemini
//            per-query energy figures as a "comparable frontier model"
//            estimate. This is explicitly an extrapolation, not sourced
//            data - flagged here so it isn't mistaken for one.
//
// Per-query figures are scaled by outputTokens relative to an assumed
// typical reply length, since the source numbers are flat per-prompt
// medians rather than per-token rates.
const FALLBACK_TYPICAL_OUTPUT_TOKENS = 500;

const FALLBACK_ENERGY_WH_PER_QUERY = {
  chatgpt: 0.3, // Epoch AI 2025, GPT-4o
  gemini: 0.24, // Google 2025, arXiv:2508.15734 (measured)
  claude: (0.3 + 0.24) / 2, // extrapolated average - no first-party Anthropic data exists
};

// Gemini's own measured CO2 figure implies a grid intensity far below the
// world average (reflecting Google's cleaner energy mix/RECs), so we use
// it directly instead of deriving CO2 from a generic intensity factor.
const FALLBACK_GEMINI_CO2_G_PER_QUERY = 0.03; // Google 2025, arXiv:2508.15734
const FALLBACK_GEMINI_WATER_ML_PER_QUERY = 0.26; // Google 2025, arXiv:2508.15734

// World-average grid carbon intensity, approx. kgCO2eq per kWh (IEA
// world-average electricity emission factors) - used for ChatGPT/Claude,
// which have no direct first-party CO2 measurement to use instead.
const FALLBACK_GRID_INTENSITY_KG_PER_KWH = 0.48;

function fallbackEstimate(assistant, outputTokens) {
  const scale = outputTokens / FALLBACK_TYPICAL_OUTPUT_TOKENS;
  const wattHoursPerQuery = FALLBACK_ENERGY_WH_PER_QUERY[assistant] ?? FALLBACK_ENERGY_WH_PER_QUERY.claude;
  const energyKwh = (wattHoursPerQuery / 1000) * scale;

  let co2Kg;
  let waterL = null;
  if (assistant === 'gemini') {
    co2Kg = (FALLBACK_GEMINI_CO2_G_PER_QUERY / 1000) * scale;
    waterL = (FALLBACK_GEMINI_WATER_ML_PER_QUERY / 1000) * scale;
  } else {
    co2Kg = energyKwh * FALLBACK_GRID_INTENSITY_KG_PER_KWH;
  }

  return {
    energyKwh, energyMin: energyKwh, energyMax: energyKwh,
    co2Kg, co2Min: co2Kg, co2Max: co2Kg,
    waterL, waterMin: waterL, waterMax: waterL,
    // No public bill-of-materials data exists per query/chip for any of
    // the three assistants, so minerals stay unavailable in fallback mode
    // regardless of assistant - fabricating a number here would be worse
    // than admitting it's unknown.
    mineralsKg: null, mineralsMin: null, mineralsMax: null,
    source: 'fallback',
  };
}

// Cache API results per (provider, model, tokenBucket) so we don't hammer
// the free public API with near-duplicate requests during one upload.
const cache = new Map();
const BUCKET_SIZE = 50;

function cacheKey(provider, model, outputTokens) {
  const bucket = Math.round(outputTokens / BUCKET_SIZE) * BUCKET_SIZE;
  return `${provider}::${model}::${bucket}`;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callEcologitsApi(provider, model, outputTokens) {
  const response = await fetchWithTimeout(`${ECOLOGITS_BASE_URL}/estimations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      model_name: model,
      output_token_count: outputTokens,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`EcoLogits API responded ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const impacts = data.impacts || {};
  const energy = impacts.energy && impacts.energy.value;
  const gwp = impacts.gwp && impacts.gwp.value;
  if (!energy || !gwp) throw new Error('EcoLogits API response missing impacts');

  const wcf = impacts.wcf && impacts.wcf.value;
  const adpe = impacts.adpe && impacts.adpe.value;

  return {
    energyKwh: (energy.min + energy.max) / 2,
    energyMin: energy.min,
    energyMax: energy.max,
    co2Kg: (gwp.min + gwp.max) / 2,
    co2Min: gwp.min,
    co2Max: gwp.max,
    waterL: wcf ? (wcf.min + wcf.max) / 2 : null,
    waterMin: wcf ? wcf.min : null,
    waterMax: wcf ? wcf.max : null,
    mineralsKg: adpe ? (adpe.min + adpe.max) / 2 : null,
    mineralsMin: adpe ? adpe.min : null,
    mineralsMax: adpe ? adpe.max : null,
    source: 'ecologits',
  };
}

function rescale(result, ratio) {
  const scaleField = (v) => (typeof v === 'number' ? v * ratio : v);
  return {
    energyKwh: scaleField(result.energyKwh), energyMin: scaleField(result.energyMin), energyMax: scaleField(result.energyMax),
    co2Kg: scaleField(result.co2Kg), co2Min: scaleField(result.co2Min), co2Max: scaleField(result.co2Max),
    waterL: scaleField(result.waterL), waterMin: scaleField(result.waterMin), waterMax: scaleField(result.waterMax),
    mineralsKg: scaleField(result.mineralsKg), mineralsMin: scaleField(result.mineralsMin), mineralsMax: scaleField(result.mineralsMax),
    source: result.source,
  };
}

async function estimateImpact({ assistant, model, outputTokens }) {
  const provider = PROVIDER_BY_ASSISTANT[assistant];
  const tokens = Math.max(1, outputTokens || 1);

  if (!provider) return fallbackEstimate(assistant, tokens);

  const key = cacheKey(provider, model, tokens);
  if (cache.has(key)) {
    const cached = cache.get(key);
    // Rescale cached per-token rate to this exact token count.
    const ratio = tokens / cached.tokens;
    return rescale(cached, ratio);
  }

  try {
    const result = await callEcologitsApi(provider, model, tokens);
    cache.set(key, { ...result, tokens });
    return result;
  } catch (err) {
    const result = fallbackEstimate(assistant, tokens);
    cache.set(key, { ...result, tokens });
    return { ...result, error: err.message };
  }
}

async function checkConnectivity() {
  try {
    const response = await fetchWithTimeout(`${ECOLOGITS_BASE_URL}/providers`, { method: 'GET' });
    return response.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { estimateImpact, checkConnectivity, PROVIDER_BY_ASSISTANT };
