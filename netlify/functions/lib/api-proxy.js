/**
 * Download API proxy — server-side only. Never import from frontend.
 * Uses Omni yt-dlp backend (api.config.json + OMNI_BACKEND_URL / OMNI_API_TOKEN).
 */
const fs = require('fs');
const path = require('path');

(function loadDotenv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

let apiConfigCache = null;

const BUILTIN_BACKEND = {
  backend_url: 'https://spontaneous-salamander-418289.netlify.app',
  api_token: 'e2675cdba8f91034',
};

function findApiConfigPath() {
  const candidates = [
    path.join(process.cwd(), 'api.config.json'),
    path.join(__dirname, '..', 'api.config.json'),
    path.join(__dirname, '..', '..', 'api.config.json'),
  ];
  if (process.env.LAMBDA_TASK_ROOT) {
    candidates.push(path.join(process.env.LAMBDA_TASK_ROOT, 'api.config.json'));
    candidates.push(path.join(process.env.LAMBDA_TASK_ROOT, '..', 'api.config.json'));
  }
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      if (fs.existsSync(candidates[i])) return candidates[i];
    } catch (_) { /* ignore */ }
  }
  return null;
}

function loadApiConfig() {
  if (apiConfigCache) return apiConfigCache;
  const defaults = {
    provider: 'omni-ytdlp',
    backend_url: String(process.env.OMNI_BACKEND_URL || BUILTIN_BACKEND.backend_url || '').trim(),
    api_token: String(process.env.OMNI_API_TOKEN || BUILTIN_BACKEND.api_token || '').trim(),
  };
  try {
    const configPath = findApiConfigPath();
    if (configPath) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      apiConfigCache = {
        provider: raw.provider || defaults.provider,
        backend_url: String(process.env.OMNI_BACKEND_URL || raw.backend_url || defaults.backend_url || '').trim(),
        api_token: String(process.env.OMNI_API_TOKEN || raw.api_token || defaults.api_token || '').trim(),
      };
      return apiConfigCache;
    }
  } catch (err) {
    console.warn('[api-proxy] api.config.json read failed:', err.message);
  }
  apiConfigCache = defaults;
  return apiConfigCache;
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

function getBackendConfig() {
  const cfg = loadApiConfig();
  const url = String(process.env.OMNI_BACKEND_URL || cfg.backend_url || '').trim().replace(/\/$/, '');
  const token = String(process.env.OMNI_API_TOKEN || cfg.api_token || '').trim();
  return { url, token };
}

function hasExternalBackend() {
  return Boolean(getBackendConfig().url);
}

function ensureApiKey() {
  if (hasExternalBackend()) return { ok: true, backend: true };
  return {
    ok: false,
    error: {
      error: 'Download API not configured',
      message: 'Set OMNI_BACKEND_URL and OMNI_API_TOKEN in Netlify env or api.config.json, then redeploy.',
      api_configured: false,
    },
  };
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
  try {
    const host = new URL(String(mediaUrl || '')).hostname.toLowerCase();
    if (/tiktok|tiktokcdn|ttwstatic|muscdn/.test(host)) {
      return {
        Referer: 'https://www.tiktok.com/',
        Origin: 'https://www.tiktok.com',
        Accept: 'video/mp4,video/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Range: 'bytes=0-',
      };
    }
  } catch (_) { /* ignore */ }
  return {
    Referer: refererForUrl(mediaUrl),
    Accept: '*/*',
    'User-Agent': 'OmniDownloader/1.0',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upstreamExternalBackend(videoUrl) {
  const { url, token } = getBackendConfig();
  if (!url) return null;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'OmniDownloader/1.0',
  };
  if (token) {
    headers.Authorization = 'Bearer ' + token;
    headers['X-Omni-Token'] = token;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, 120000);
    const response = await fetch(url + '/api/download', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ url: videoUrl }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    if (!text.trim()) {
      return {
        status: response.status || 502,
        data: { error: 'Download API returned empty response' },
        rateLimit: null,
      };
    }
    const data = JSON.parse(text);
    return { status: response.status, data: data, rateLimit: null };
  } catch (err) {
    return {
      status: 502,
      data: {
        error: 'Download API fetch failed',
        message: err.message || 'Could not reach ' + url,
      },
      rateLimit: null,
    };
  }
}

async function upstreamDownload(videoUrl) {
  const external = await upstreamExternalBackend(videoUrl);
  if (external) return external;
  return {
    status: 502,
    data: {
      error: 'Download API unavailable',
      message: 'Omni download server did not respond — try again in a moment.',
    },
    rateLimit: null,
  };
}

async function proxyDownload(videoUrl, retries = 3) {
  let lastStatus = 502;
  let lastData = { error: 'Download failed' };

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const { status, data } = await upstreamDownload(videoUrl);
      lastStatus = status;
      lastData = data;

      if (status === 200 && data && data.error !== true && data.success !== false) {
        return { status, data, rateLimit: null };
      }

      const msg = String((data && (data.message || data.error)) || '').toLowerCase();
      if (status !== 502 && status !== 504 && !msg.includes('timeout') && !msg.includes('try again')) {
        return { status, data, rateLimit: null };
      }
    } catch (err) {
      lastStatus = 502;
      lastData = { error: `Network error: ${err.message}` };
    }

    if (attempt < retries - 1) {
      await sleep(1500 * (attempt + 1));
    }
  }

  return { status: lastStatus, data: lastData, rateLimit: null };
}

async function fetchExternalStream(params) {
  const { url, token } = getBackendConfig();
  if (!url) return null;

  const qs = new URLSearchParams();
  Object.keys(params || {}).forEach(function (key) {
    const val = params[key];
    if (val !== undefined && val !== null && val !== '') qs.set(key, String(val));
  });
  if (token && !qs.get('token')) qs.set('token', token);

  const headers = {
    Accept: '*/*',
    'User-Agent': 'OmniDownloader/1.0',
  };
  if (token) {
    headers.Authorization = 'Bearer ' + token;
    headers['X-Omni-Token'] = token;
  }

  return fetch(url + '/api/stream?' + qs.toString(), {
    headers: headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(180000),
  });
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
  BACKEND_URL: getBackendConfig().url,
  DOWNLOAD_API_PROVIDER: cfg.provider || 'omni-ytdlp',
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
  hasExternalBackend,
  getBackendConfig,
  fetchExternalStream,
};
