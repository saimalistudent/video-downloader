/**
 * Download API proxy — server-side only. Never import from frontend.
 * Config: api.config.json + DOWNLOAD_API_KEY (or legacy RAPIDAPI_KEY) in env.
 */
const fs = require('fs');
const path = require('path');

(function loadDotenv() {
  if (process.env.DOWNLOAD_API_KEY || process.env.RAPIDAPI_KEY) return;
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

const { parseRateLimitHeaders } = require('./rapidapi-usage');

let apiConfigCache = null;

function loadApiConfig() {
  if (apiConfigCache) return apiConfigCache;
  const defaults = {
    host: 'social-download-all-in-one.p.rapidapi.com',
    path: '/v1/social/autolink',
    method: 'POST',
    body_key: 'url',
    subscribe_url: 'https://rapidapi.com/nguyenmanhict-MuTUtGWD7K/api/social-download-all-in-one',
  };
  try {
    const configPath = path.join(process.cwd(), 'api.config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      apiConfigCache = Object.assign({}, defaults, {
        host: raw.host || defaults.host,
        path: raw.path || defaults.path,
        method: String(raw.method || defaults.method).toUpperCase(),
        body_key: raw.body_key || defaults.body_key,
        subscribe_url: raw.subscribe_url || defaults.subscribe_url,
      });
      return apiConfigCache;
    }
  } catch (err) {
    console.warn('[api-proxy] api.config.json read failed:', err.message);
  }
  apiConfigCache = defaults;
  return apiConfigCache;
}

function getApiKey() {
  let key = String(process.env.DOWNLOAD_API_KEY || process.env.RAPIDAPI_KEY || '').trim();
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
        error: 'DOWNLOAD_API_KEY is not configured',
        message: 'Netlify → Site settings → Environment variables → add DOWNLOAD_API_KEY → Redeploy.',
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

const PROXY_MAX_BYTES = 4 * 1024 * 1024;

function preferDirectStream(mediaUrl) {
  try {
    const host = new URL(mediaUrl).hostname.toLowerCase();
    const pathName = (new URL(mediaUrl).pathname || '').toLowerCase();
    if (/googlevideo|youtube|gvt1\.com|ytimg/.test(host)) return true;
    if (/fbcdn|facebook\.com|fb\.watch/.test(host)) return true;
    if (/\.m3u8(\?|$)/.test(pathName)) return true;
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

async function upstreamDownload(videoUrl) {
  const apiKey = getApiKey();
  const cfg = loadApiConfig();
  let response;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'OmniDownloader/1.0',
    'X-RapidAPI-Key': apiKey,
    'X-RapidAPI-Host': cfg.host,
  };

  const fetchUrl = `https://${cfg.host}${cfg.path}`;

  try {
    if (cfg.method === 'GET') {
      const qs = new URLSearchParams();
      qs.set(cfg.body_key, videoUrl);
      response = await fetch(`${fetchUrl}?${qs.toString()}`, { method: 'GET', headers });
    } else {
      response = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ [cfg.body_key]: videoUrl }),
      });
    }
  } catch (err) {
    return {
      status: 502,
      data: {
        error: 'Download API fetch failed',
        message: err.message || 'Network error contacting download API',
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
        error: 'Download API returned empty response',
        message: `HTTP ${response.status} — verify DOWNLOAD_API_KEY and subscription.`,
        http_status: response.status,
      },
      rateLimit: rateLimit,
    };
  }

  try {
    const data = JSON.parse(text);
    const apiMsg = String(data.message || data.error || '').trim();

    if (response.status === 403) {
      return {
        status: 403,
        data: {
          error: apiMsg || 'Download API access denied (403)',
          message: 'Check DOWNLOAD_API_KEY in Netlify env vars and that your API plan is active, then redeploy.',
          subscribe_url: cfg.subscribe_url,
          api_message: apiMsg || null,
          hint: /invalid api key/i.test(apiMsg)
            ? 'Key is wrong or expired — copy a fresh key from your API dashboard.'
            : 'You may not be subscribed — open subscribe_url and activate the plan.',
        },
        rateLimit: rateLimit,
      };
    }

    if (response.status === 401) {
      return {
        status: 401,
        data: {
          error: apiMsg || 'Download API unauthorized',
          message: 'DOWNLOAD_API_KEY missing or invalid. Redeploy after updating env vars.',
          api_message: apiMsg || null,
        },
        rateLimit: rateLimit,
      };
    }

    return { status: response.status, data, rateLimit: parseRateLimitHeaders(response.headers) };
  } catch {
    return {
      status: 502,
      data: { error: 'Download API returned non-JSON response', raw: text.slice(0, 200) },
      rateLimit: parseRateLimitHeaders(response.headers),
    };
  }
}

async function proxyDownload(videoUrl, retries = 2) {
  let lastStatus = 502;
  let lastData = { error: 'Download failed' };
  let lastRateLimit = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const { status, data, rateLimit } = await upstreamDownload(videoUrl);
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

const cfg = loadApiConfig();

module.exports = {
  DOWNLOAD_API_HOST: cfg.host,
  DOWNLOAD_API_SUBSCRIBE_URL: cfg.subscribe_url,
  RAPIDAPI_HOST: cfg.host,
  RAPIDAPI_SUBSCRIBE_URL: cfg.subscribe_url,
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
  loadApiConfig,
};
