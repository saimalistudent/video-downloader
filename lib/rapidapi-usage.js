/**
 * Parse RapidAPI billing / rate-limit headers and probe live quota usage.
 */
function cleanEnv(value) {
  let v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
  return headers[name] || headers[name.toLowerCase()] || '';
}

function parseRateLimitHeaders(headers) {
  if (!headers) return null;

  const pairs = [
    ['x-ratelimit-requests-limit', 'x-ratelimit-requests-remaining', 'x-ratelimit-requests-reset'],
    ['x-rapidapi-requests-limit', 'x-rapidapi-requests-remaining', 'x-rapidapi-requests-reset'],
  ];

  for (let i = 0; i < pairs.length; i++) {
    const limit = parseInt(headerValue(headers, pairs[i][0]), 10) || 0;
    const remaining = parseInt(headerValue(headers, pairs[i][1]), 10);
    const reset = headerValue(headers, pairs[i][2]) || null;
    if (limit > 0 && !Number.isNaN(remaining)) {
      return {
        limit: limit,
        remaining: Math.max(0, remaining),
        used: Math.max(0, limit - remaining),
        reset: reset,
      };
    }
  }

  if (typeof headers.forEach === 'function') {
    let limit = 0;
    let remaining = null;
    headers.forEach(function (val, key) {
      const k = String(key).toLowerCase();
      if (/requests.*limit/i.test(k) && !/remaining|reset/i.test(k)) {
        const n = parseInt(val, 10);
        if (n > 0) limit = n;
      }
      if (/requests.*remaining/i.test(k)) {
        const n = parseInt(val, 10);
        if (!Number.isNaN(n)) remaining = n;
      }
    });
    if (limit > 0 && remaining != null) {
      return { limit: limit, remaining: remaining, used: Math.max(0, limit - remaining), reset: null };
    }
  }

  return null;
}

function getRapidApiBaseline() {
  return parseFloat(cleanEnv(process.env.RAPIDAPI_USAGE_BASELINE) || '0') || 0;
}

let usageCache = { at: 0, data: null };
const CACHE_MS = 5 * 60 * 1000;

async function fetchRapidApiUsageLive(force) {
  if (cleanEnv(process.env.RAPIDAPI_LIVE_PROBE).toLowerCase() !== 'true') {
    return usageCache.data || null;
  }

  if (!force && usageCache.data && Date.now() - usageCache.at < CACHE_MS) {
    return usageCache.data;
  }

  const apiKey = cleanEnv(process.env.DOWNLOAD_API_KEY || process.env.RAPIDAPI_KEY);
  if (!apiKey) return usageCache.data || null;

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;

    const res = await fetch('https://social-download-all-in-one.p.rapidapi.com/v1/social/autolink', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'social-download-all-in-one.p.rapidapi.com',
        Accept: 'application/json',
      },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }),
      signal: controller ? controller.signal : undefined,
    });

    if (timer) clearTimeout(timer);

    const rateLimit = parseRateLimitHeaders(res.headers);
    if (rateLimit && rateLimit.limit > 0) {
      usageCache = { at: Date.now(), data: rateLimit };
      return rateLimit;
    }
  } catch (err) {
    console.warn('[rapidapi-usage] live probe:', err.message);
  }

  return usageCache.data || null;
}

function mergeRapidUsageCounts(storedUsed, eventUsed, liveUsage, baseline) {
  const liveUsed = liveUsage && liveUsage.used > 0 ? liveUsage.used : 0;
  return Math.max(
    parseFloat(storedUsed) || 0,
    parseFloat(eventUsed) || 0,
    liveUsed,
    baseline || 0
  );
}

module.exports = {
  parseRateLimitHeaders,
  fetchRapidApiUsageLive,
  getRapidApiBaseline,
  mergeRapidUsageCounts,
};
