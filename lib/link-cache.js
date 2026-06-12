'use strict';

const crypto = require('crypto');

const CACHE_PREFIX = 'omni:link:';
const RATE_PREFIX = 'omni:rl:';
const DEFAULT_CACHE_TTL_SEC = parseInt(process.env.LINK_CACHE_TTL_SEC || String(4 * 60 * 60), 10);
const DEFAULT_RATE_LIMIT = parseInt(process.env.LINK_RATE_LIMIT_PER_HOUR || '30', 10);
const RATE_WINDOW_SEC = 3600;

const memCache = new Map();
const memRate = new Map();
let redisClient = null;

function cleanEnv(value) {
  let v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function redisConfig() {
  const rawUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  let url = cleanEnv(rawUrl);
  if (!url) return null;
  if (/^redis(s)?:\/\//i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  url = url.replace(/\/$/, '');
  const token = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  if (!token) return null;
  return { url, token };
}

function getRedis() {
  if (redisClient !== null) return redisClient;
  const cfg = redisConfig();
  if (!cfg) {
    redisClient = false;
    return false;
  }
  try {
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({ url: cfg.url, token: cfg.token });
    return redisClient;
  } catch (err) {
    console.warn('[link-cache] Redis unavailable:', err.message);
    redisClient = false;
    return false;
  }
}

function cacheKeyForUrl(videoUrl) {
  const hash = crypto.createHash('sha256').update(String(videoUrl || '').trim()).digest('hex');
  return CACHE_PREFIX + hash;
}

function memCacheGet(key) {
  const row = memCache.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    memCache.delete(key);
    return null;
  }
  return row.payload;
}

function memCacheSet(key, payload, ttlSec) {
  memCache.set(key, { payload: payload, expiresAt: Date.now() + ttlSec * 1000 });
}

async function getCachedLink(videoUrl) {
  const key = cacheKeyForUrl(videoUrl);
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || !parsed.data) return null;
      return { status: parsed.status || 200, data: parsed.data };
    } catch (err) {
      console.warn('[link-cache] get failed:', err.message);
    }
  }
  const mem = memCacheGet(key);
  if (!mem || !mem.data) return null;
  return { status: mem.status || 200, data: mem.data };
}

async function setCachedLink(videoUrl, status, data) {
  if (!videoUrl || !data || typeof data !== 'object') return;
  if (data.error || data.success === false) return;

  const key = cacheKeyForUrl(videoUrl);
  const payload = { status: status || 200, data: data, cachedAt: Date.now() };
  const ttl = DEFAULT_CACHE_TTL_SEC;
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(payload), { ex: ttl });
      return;
    } catch (err) {
      console.warn('[link-cache] set failed:', err.message);
    }
  }
  memCacheSet(key, payload, ttl);
}

async function invalidateCachedLink(videoUrl) {
  const key = cacheKeyForUrl(videoUrl);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch (err) {
      console.warn('[link-cache] del failed:', err.message);
    }
  }
  memCache.delete(key);
}

function clientIpFromRequest(reqOrEvent) {
  if (reqOrEvent && reqOrEvent.headers) {
    const h = reqOrEvent.headers;
    const fwd = String(h['x-forwarded-for'] || h['X-Forwarded-For'] || '').split(',')[0].trim();
    if (fwd) return fwd;
    if (h['x-nf-client-connection-ip']) return String(h['x-nf-client-connection-ip']);
    if (h['client-ip']) return String(h['client-ip']);
    if (reqOrEvent.ip) return String(reqOrEvent.ip);
  }
  if (reqOrEvent && reqOrEvent.requestContext && reqOrEvent.requestContext.identity) {
    return String(reqOrEvent.requestContext.identity.sourceIp || 'unknown');
  }
  return 'unknown';
}

function memRateCheck(ip) {
  const now = Date.now();
  const row = memRate.get(ip);
  if (!row || now > row.expiresAt) {
    memRate.set(ip, { count: 1, expiresAt: now + RATE_WINDOW_SEC * 1000 });
    return { ok: true, remaining: DEFAULT_RATE_LIMIT - 1 };
  }
  if (row.count >= DEFAULT_RATE_LIMIT) {
    return { ok: false, remaining: 0 };
  }
  row.count += 1;
  return { ok: true, remaining: DEFAULT_RATE_LIMIT - row.count };
}

async function checkRateLimit(clientIp) {
  const ip = String(clientIp || 'unknown').slice(0, 64);
  const redis = getRedis();
  if (redis) {
    try {
      const key = RATE_PREFIX + ip;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, RATE_WINDOW_SEC);
      if (count > DEFAULT_RATE_LIMIT) {
        return { ok: false, remaining: 0 };
      }
      return { ok: true, remaining: DEFAULT_RATE_LIMIT - count };
    } catch (err) {
      console.warn('[link-cache] rate limit failed:', err.message);
    }
  }
  return memRateCheck(ip);
}

function isSuccessfulApiPayload(status, data) {
  if (!data || typeof data !== 'object') return false;
  if (status < 200 || status >= 400) return false;
  if (data.error) return false;
  if (data.success === false) return false;
  return true;
}

async function resolveDownloadWithCache(videoUrl, options) {
  options = options || {};
  const refresh = options.refresh === true;
  const clientIp = options.clientIp || 'unknown';

  if (!refresh) {
    const rate = await checkRateLimit(clientIp);
    if (!rate.ok) {
      return {
        status: 429,
        data: {
          error: 'Too many requests',
          message: 'You are fetching links very quickly. Please wait a minute and try again.',
        },
        rateLimit: null,
        fromCache: false,
      };
    }

    const cached = await getCachedLink(videoUrl);
    if (cached) {
      return {
        status: cached.status,
        data: cached.data,
        rateLimit: null,
        fromCache: true,
      };
    }
  } else {
    await invalidateCachedLink(videoUrl);
  }

  const { proxyDownload } = require('./api-proxy');
  const started = Date.now();
  const { status, data, rateLimit } = await proxyDownload(videoUrl);
  const durationMs = Date.now() - started;

  if (isSuccessfulApiPayload(status, data)) {
    await setCachedLink(videoUrl, status, data);
  }

  return {
    status: status,
    data: data,
    rateLimit: rateLimit,
    fromCache: false,
    durationMs: durationMs,
  };
}

module.exports = {
  getCachedLink,
  setCachedLink,
  invalidateCachedLink,
  checkRateLimit,
  resolveDownloadWithCache,
  clientIpFromRequest,
  isSuccessfulApiPayload,
  CACHE_TTL_SEC: DEFAULT_CACHE_TTL_SEC,
};
