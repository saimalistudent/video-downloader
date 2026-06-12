/**
 * Shared RapidAPI proxy — Netlify Functions only. Never import from frontend.
 */
const RAPIDAPI_HOST = 'social-download-all-in-one.p.rapidapi.com';
const RAPIDAPI_PATH = '/v1/social/autolink';
const RAPIDAPI_SUBSCRIBE_URL = 'https://rapidapi.com/aiovod/api/social-download-all-in-one';
const FETCH_TIMEOUT_MS = parseInt(process.env.RAPIDAPI_TIMEOUT_MS || '22000', 10);
const MAX_RETRIES = 1;

function getApiKey() {
  let key = String(process.env.RAPIDAPI_KEY || '').trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

function ensureApiKey() {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: {
        error: 'RAPIDAPI_KEY is not configured',
        message: 'Netlify → Site settings → Environment variables → RAPIDAPI_KEY → Save → Trigger deploy.',
        api_configured: false,
      },
    };
  }
  return { ok: true, apiKey };
}

function normalizeVideoUrl(videoUrl) {
  const trimmed = String(videoUrl || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
}

function refererForUrl(mediaUrl) {
  const host = new URL(mediaUrl).hostname.toLowerCase();
  if (host.includes('tiktok')) return 'https://www.tiktok.com/';
  if (host.includes('instagram') || host.includes('cdninstagram')) return 'https://www.instagram.com/';
  if (host.includes('facebook') || host.includes('fbcdn')) return 'https://www.facebook.com/';
  if (host.includes('googlevideo') || host.includes('youtube')) return 'https://www.youtube.com/';
  return 'https://www.google.com/';
}

const PROXY_MAX_BYTES = 4 * 1024 * 1024;

function preferDirectStream(mediaUrl) {
  try {
    const parsed = new URL(mediaUrl);
    const host = parsed.hostname.toLowerCase();
    const path = (parsed.pathname || '').toLowerCase();
    if (/googlevideo|youtube|gvt1\.com|ytimg/.test(host)) return true;
    if (/fbcdn|facebook\.com|fb\.watch/.test(host)) return true;
    if (/\.m3u8(\?|$)/.test(path)) return true;
  } catch {
    return false;
  }
  return false;
}

function upstreamHeaders(mediaUrl) {
  return {
    Referer: refererForUrl(mediaUrl),
    Accept: '*/*',
    'User-Agent': 'OmniDownloader/1.0',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`RapidAPI request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function rapidapiDownload(videoUrl) {
  const apiKey = getApiKey();
  let response;

  try {
    response = await fetchWithTimeout(`https://${RAPIDAPI_HOST}${RAPIDAPI_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
        Accept: 'application/json',
        'User-Agent': 'OmniDownloader/1.0',
      },
      body: JSON.stringify({ url: videoUrl }),
    });
  } catch (err) {
    return {
      status: 502,
      data: {
        error: 'RapidAPI fetch failed',
        message: err.message || 'Network error contacting RapidAPI',
      },
    };
  }

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    return {
      status: 502,
      data: {
        error: 'RapidAPI read failed',
        message: err.message || 'Could not read RapidAPI response body',
      },
    };
  }

  if (!text.trim()) {
    return {
      status: response.status || 502,
      data: {
        error: 'RapidAPI returned empty response',
        message: `HTTP ${response.status} — verify RAPIDAPI_KEY and subscription.`,
        http_status: response.status,
      },
    };
  }

  try {
    const data = JSON.parse(text);
    const rapidMsg = String(data.message || data.error || '').trim();

    if (response.status === 403) {
      return {
        status: 403,
        data: {
          error: rapidMsg || 'RapidAPI access denied (403)',
          message:
            'Fix: (1) New key from rapidapi.com/developer/security '
            + '(2) Subscribe to Social Download All In One '
            + '(3) Set RAPIDAPI_KEY on Netlify (4) Redeploy.',
          subscribe_url: RAPIDAPI_SUBSCRIBE_URL,
          rapidapi_message: rapidMsg || null,
          hint: /invalid api key/i.test(rapidMsg)
            ? 'Key wrong or expired — generate a new one.'
            : 'Subscribe to the API at subscribe_url.',
        },
      };
    }

    if (response.status === 401) {
      return {
        status: 401,
        data: {
          error: rapidMsg || 'RapidAPI unauthorized',
          message: 'RAPIDAPI_KEY missing or invalid on Netlify. Redeploy after updating env vars.',
          rapidapi_message: rapidMsg || null,
        },
      };
    }

    return { status: response.status, data };
  } catch (err) {
    return {
      status: 502,
      data: {
        error: 'RapidAPI returned non-JSON response',
        message: err.message,
        raw: text.slice(0, 200),
        http_status: response.status,
      },
    };
  }
}

async function proxyDownload(videoUrl) {
  let lastStatus = 502;
  let lastData = { error: 'Download failed', message: 'Unknown error' };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const { status, data } = await rapidapiDownload(videoUrl);
      lastStatus = status;
      lastData = data && typeof data === 'object' ? data : { error: 'Invalid RapidAPI payload', raw: data };

      if (status === 200 && lastData.error !== true) {
        return { status, data: lastData };
      }

      const msg = String(lastData.message || lastData.error || '').toLowerCase();
      if (status !== 502 && status !== 504 && status !== 429 && !msg.includes('timeout') && !msg.includes('try again')) {
        return { status, data: lastData };
      }
    } catch (err) {
      lastStatus = 502;
      lastData = {
        error: 'Proxy error',
        message: err.message || 'Unexpected error during download',
      };
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(1200 * (attempt + 1));
    }
  }

  return { status: lastStatus, data: lastData };
}

module.exports = {
  RAPIDAPI_HOST,
  RAPIDAPI_SUBSCRIBE_URL,
  getApiKey,
  ensureApiKey,
  normalizeVideoUrl,
  refererForUrl,
  preferDirectStream,
  PROXY_MAX_BYTES,
  upstreamHeaders,
  proxyDownload,
};
