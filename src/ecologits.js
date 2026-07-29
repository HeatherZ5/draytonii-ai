/**
 * Thin client for the public EcoLogits API (https://ecologits.ai), which
 * estimates the environmental impact of a single LLM inference request
 * given a provider, model name, and output token count.
 *
 *   POST https://api.ecologits.ai/v1beta/estimations
 *   { provider, model_name, output_token_count, electricity_mix_zone? }
 *
 * The API returns min/max ranges for several metrics; we use the midpoint
 * of "energy" (kWh) and "gwp" (kgCO2eq, Global Warming Potential) as our
 * point estimates.
 *
 * If the API can't be reached (offline, blocked network, unrecognized
 * model, etc.) we fall back to a rough local formula so the dashboard
 * still shows something, and we flag every number with its source
 * ("ecologits" vs "fallback") so the UI can be transparent about which
 * numbers are precise and which are rough approximations.
 */

const ECOLOGITS_BASE_URL = 'https://api.ecologits.ai/v1beta';
const REQUEST_TIMEOUT_MS = 8000;

const PROVIDER_BY_ASSISTANT = {
  chatgpt: 'openai',
  claude: 'anthropic',
  gemini: 'google_genai',
};

// --- Fallback formula (used only when the live API is unreachable) -------
// Order-of-magnitude figures drawn from published LLM-inference energy
// studies: on the order of 1-10 Wh (0.001-0.01 kWh) per 1,000 output
// tokens for mid-size models. We use a midpoint estimate here.
const FALLBACK_KWH_PER_1000_OUTPUT_TOKENS = 0.004;
// World-average grid carbon intensity, approx. kgCO2eq per kWh
// (order of magnitude consistent with IEA world-average electricity
// emission factors).
const FALLBACK_GRID_INTENSITY_KG_PER_KWH = 0.48;

function fallbackEstimate(outputTokens) {
  const energyKwh = (outputTokens / 1000) * FALLBACK_KWH_PER_1000_OUTPUT_TOKENS;
  const co2Kg = energyKwh * FALLBACK_GRID_INTENSITY_KG_PER_KWH;
  return { energyKwh, co2Kg, source: 'fallback' };
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
  const energy = data.impacts && data.impacts.energy && data.impacts.energy.value;
  const gwp = data.impacts && data.impacts.gwp && data.impacts.gwp.value;
  if (!energy || !gwp) throw new Error('EcoLogits API response missing impacts');

  const energyKwh = (energy.min + energy.max) / 2;
  const co2Kg = (gwp.min + gwp.max) / 2;
  return { energyKwh, co2Kg, source: 'ecologits' };
}

async function estimateImpact({ assistant, model, outputTokens }) {
  const provider = PROVIDER_BY_ASSISTANT[assistant];
  const tokens = Math.max(1, outputTokens || 1);

  if (!provider) return fallbackEstimate(tokens);

  const key = cacheKey(provider, model, tokens);
  if (cache.has(key)) {
    const cached = cache.get(key);
    // Rescale cached per-token rate to this exact token count.
    const ratio = tokens / cached.tokens;
    return { energyKwh: cached.energyKwh * ratio, co2Kg: cached.co2Kg * ratio, source: cached.source };
  }

  try {
    const result = await callEcologitsApi(provider, model, tokens);
    cache.set(key, { ...result, tokens });
    return result;
  } catch (err) {
    const result = fallbackEstimate(tokens);
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
