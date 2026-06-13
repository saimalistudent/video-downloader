/**
 * Shared RapidAPI proxy — server-side only. Never import from frontend.
 */
const fs = require('fs');
const path = require('path');

(function loadDotenv() {
  if (process.env.RAPIDAPI_KEY) return;
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

const RAPIDAPI_HOST = 'social-download-all-in-one.p.rapidapi.com';
const RAPIDAPI_PATH = '/v1/social/autolink';
const RAPIDAPI_SUBSCRIBE_URL = 'https://rapidapi.com/aiovod/api/social-download-all-in-one';
const { parseRateLimitHeaders } = require('./rapidapi-usage');

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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}

function sendJson(res, status, data) {
  cors(res);
  res.status(status).json(data);
}

function ensureApiKey() {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: {
        error: 'RAPIDAPI_KEY is not configured',
        message: 'Vercel → Project → Settings → Environment Variables → add RAPIDAPI_KEY → Redeploy (Production).',
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

function extractQueryValue(queryString, key, stopBefore) {
  const prefix = `${key}=`;
  const idx = queryString.indexOf(prefix);
  if (idx === -1) return '';
  const start = idx + prefix.length;
  let end = queryString.length;
  if (stopBefore) {
    const marker = `&${stopBefore}=`;
    const stopIdx = queryString.indexOf(marker, start);
    if (stopIdx !== -1) end = stopIdx;
  }
  try {
    return decodeURIComponent(queryString.slice(start, end));
  } catch {
    return queryString.slice(start, end);
  }
}

function refererForUrl(mediaUrl) {
  const host = new URL(mediaUrl).hostname.toLowerCase();
  if (host.includes('tiktok')) return 'https://www.tiktok.com/';
  if (host.includes('instagram') || host.includes('cdninstagram')) return 'https://www.instagram.com/';
  if (host.includes('facebook') || host.includes('fbcdn')) return 'https://www.facebook.com/';
  if (host.includes('googlevideo') || host.includes('youtube')) return 'https://www.youtube.com/';
  return 'https://www.google.com/';
}

/** Netlify/Vercel cannot proxy multi‑MB video bodies — use direct CDN link instead */
const PROXY_MAX_BYTES = 4 * 1024 * 1024;

function preferDirectStream(mediaUrl) {
  try {
    const host = new URL(mediaUrl).hostname.toLowerCase();
    const path = (new URL(mediaUrl).pathname || '').toLowerCase();
    if (/googlevideo|youtube|gvt1\.com|ytimg/.test(host)) return true;
    if (/fbcdn|facebook\.com|fb\.watch/.test(host)) return true;
    if (/\.m3u8(\?|$)/.test(path)) return true;
  } catch {
    return false;
  }
  return false;
}

function upstreamHeaders(mediaUrl) {
  if (/googlevideo\.com|gvt1\.com/i.test(String(mediaUrl || ''))) {
    return {
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'com.google.android.youtube/19.45.36 (Linux; U; Android 12; en_US) gzip',
      Range: 'bytes=0-',
    };
  }
  return {
    Referer: refererForUrl(mediaUrl),
    Accept: '*/*',
    'User-Agent': 'OmniDownloader/1.0',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rapidapiDownload(videoUrl) {
  const apiKey = getApiKey();
  let response;

  try {
    response = await fetch(`https://${RAPIDAPI_HOST}${RAPIDAPI_PATH}`, {
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
      rateLimit: null,
    };
  }

  const rateLimit = parseRateLimitHeaders(response.headers);
  const text = await response.text();
  if (!text.trim()) {
    return {
      status: response.status || 502,
      data: {
        error: 'RapidAPI returned empty response',
        message: `HTTP ${response.status} — verify RAPIDAPI_KEY and subscription.`,
        http_status: response.status,
      },
      rateLimit: rateLimit,
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
            'Fix: (1) Copy a fresh key from rapidapi.com/developer/security '
            + '(2) Subscribe to Social Download All In One API '
            + '(3) Set RAPIDAPI_KEY in Vercel for Production (4) Redeploy.',
          subscribe_url: RAPIDAPI_SUBSCRIBE_URL,
          rapidapi_message: rapidMsg || null,
          hint: /invalid api key/i.test(rapidMsg)
            ? 'Key is wrong or expired — generate a new one on RapidAPI.'
            : 'You may not be subscribed to this API — open subscribe_url and click Subscribe.',
        },
        rateLimit: rateLimit,
      };
    }

    if (response.status === 401) {
      return {
        status: 401,
        data: {
          error: rapidMsg || 'RapidAPI unauthorized',
          message: 'RAPIDAPI_KEY missing or invalid on Vercel. Redeploy after updating env vars.',
          rapidapi_message: rapidMsg || null,
        },
        rateLimit: rateLimit,
      };
    }

    return { status: response.status, data, rateLimit: parseRateLimitHeaders(response.headers) };
  } catch {
    return {
      status: 502,
      data: { error: 'RapidAPI returned non-JSON response', raw: text.slice(0, 200) },
      rateLimit: parseRateLimitHeaders(response.headers),
    };
  }
}

async function proxyDownload(videoUrl, retries = 3) {
  let lastStatus = 502;
  let lastData = { error: 'Download failed' };
  let lastRateLimit = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const { status, data, rateLimit } = await rapidapiDownload(videoUrl);
      lastStatus = status;
      lastData = data;
      if (rateLimit) lastRateLimit = rateLimit;

      if (status === 200 && data.error !== true) {
        return { status, data, rateLimit: lastRateLimit };
      }

      const msg = String(data.message || data.error || '').toLowerCase();
      if (/quota|exceeded|monthly limit|upgrade your plan|too many requests/i.test(msg)) {
        return { status, data, rateLimit: lastRateLimit };
      }
      if (status === 429) {
        return { status, data, rateLimit: lastRateLimit };
      }
      if (status !== 502 && status !== 504 && !msg.includes('timeout') && !msg.includes('try again')) {
        return { status, data, rateLimit: lastRateLimit };
      }
    } catch (err) {
      lastStatus = 502;
      lastData = { error: `Network error: ${err.message}` };
    }

    if (attempt < retries - 1) {
      await sleep(1500 * (attempt + 1));
    }
  }

  return { status: lastStatus, data: lastData, rateLimit: lastRateLimit };
}

async function probeMediaSize(mediaUrl) {
  const url = normalizeVideoUrl(mediaUrl);
  if (!url) return 0;

  const headers = upstreamHeaders(url);

  try {
    const head = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' });
    if (head.ok) {
      const cl = parseInt(head.headers.get('content-length') || '0', 10);
      if (cl > 0) return cl;
    }
  } catch (err) {
    /* HEAD blocked — try Range GET */
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: Object.assign({}, headers, { Range: 'bytes=0-0' }),
      redirect: 'follow',
    });
    if (res.ok || res.status === 206) {
      const range = res.headers.get('content-range') || '';
      const totalMatch = range.match(/\/(\d+)\s*$/);
      if (totalMatch) return parseInt(totalMatch[1], 10) || 0;
      const cl = parseInt(res.headers.get('content-length') || '0', 10);
      if (cl > 0) return cl;
    }
  } catch (err) {
    console.warn('[probeMediaSize]', err.message);
  }

  return 0;
}

async function readRequestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    return req.body;
  }

  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function handleOptions(req, res) {
  cors(res);
  res.status(204).end();
}

module.exports = {
  RAPIDAPI_HOST,
  RAPIDAPI_SUBSCRIBE_URL,
  getApiKey,
  cors,
  sendJson,
  ensureApiKey,
  normalizeVideoUrl,
  extractQueryValue,
  refererForUrl,
  preferDirectStream,
  PROXY_MAX_BYTES,
  upstreamHeaders,
  probeMediaSize,
  proxyDownload,
  readRequestBody,
  handleOptions,
};
