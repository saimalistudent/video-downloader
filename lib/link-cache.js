'use strict';

const crypto = require('crypto');
const config = require('./throughput-config');

const CACHE_PREFIX = 'omni:link:';
const RATE_PREFIX = 'omni:rl:';
const DEFAULT_CACHE_TTL_SEC = config.CACHE_TTL_SEC;
const DEFAULT_RATE_LIMIT = config.USER_RATE_PER_HOUR;
const RATE_PER_SEC = config.USER_RATE_PER_SEC;
const RATE_PER_MIN = parseInt(process.env.LINK_RATE_LIMIT_PER_MIN || '300', 10);
const RATE_WINDOW_SEC = 3600;

const memCache = new Map();
const memRate = new Map();
const memRateSec = new Map();
const memRateMin = new Map();
const inflightLookups = new Map();
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

function memWindowCount(map, key, windowMs) {
  const now = Date.now();
  const row = map.get(key);
  if (!row || now > row.expiresAt) {
    map.set(key, { count: 1, expiresAt: now + windowMs });
    return 1;
  }
  row.count += 1;
  return row.count;
}

async function checkUserRateLimit(clientIp) {
  const ip = String(clientIp || 'unknown').slice(0, 64);
  const redis = getRedis();
  const secSlot = Math.floor(Date.now() / 1000);
  const minSlot = Math.floor(Date.now() / 60000);

  if (redis) {
    try {
      const secKey = RATE_PREFIX + 'sec:' + ip + ':' + secSlot;
      const secCount = await redis.incr(secKey);
      if (secCount === 1) await redis.expire(secKey, 3);
      if (secCount > RATE_PER_SEC) {
        return { ok: false, remaining: 0, retryAfter: 1, reason: 'per_second' };
      }

      const minKey = RATE_PREFIX + 'min:' + ip + ':' + minSlot;
      const minCount = await redis.incr(minKey);
      if (minCount === 1) await redis.expire(minKey, 120);
      if (minCount > RATE_PER_MIN) {
        return { ok: false, remaining: 0, retryAfter: 60, reason: 'per_minute' };
      }

      return { ok: true, remaining: RATE_PER_SEC - secCount };
    } catch (err) {
      console.warn('[link-cache] user rate limit failed:', err.message);
    }
  }

  const secCount = memWindowCount(memRateSec, ip + ':' + secSlot, 1500);
  if (secCount > RATE_PER_SEC) {
    return { ok: false, remaining: 0, retryAfter: 1, reason: 'per_second' };
  }

  const minCount = memWindowCount(memRateMin, ip + ':' + minSlot, 65000);
  if (minCount > RATE_PER_MIN) {
    return { ok: false, remaining: 0, retryAfter: 60, reason: 'per_minute' };
  }

  return { ok: true, remaining: RATE_PER_SEC - secCount };
}

async function checkRateLimit(clientIp) {
  return checkUserRateLimit(clientIp);
}

function isSuccessfulApiPayload(status, data) {
  if (!data || typeof data !== 'object') return false;
  if (status < 200 || status >= 400) return false;
  if (data.error) return false;
  if (data.success === false) return false;
  return true;
}

function isQuotaExceeded(status, data) {
  if (status === 429) return true;
  const msg = String((data && (data.message || data.error)) || '').toLowerCase();
  return /quota|exceeded|monthly.*limit|upgrade your plan/i.test(msg);
}

async function resolveDownloadWithCache(videoUrl, options) {
  const { getLookupQueue } = require('./lookup-queue');
  const queue = getLookupQueue();
  const result = await queue.submit(videoUrl, options || {});
  if (result.immediate) {
    return {
      status: result.status || 200,
      data: result.data,
      rateLimit: null,
      fromCache: Boolean(result.fromCache),
      durationMs: 0,
    };
  }
  return {
    status: 202,
    data: result,
    rateLimit: null,
    fromCache: false,
    queued: true,
    durationMs: 0,
  };
}

module.exports = {
  getCachedLink,
  setCachedLink,
  invalidateCachedLink,
  checkRateLimit,
  checkUserRateLimit,
  resolveDownloadWithCache,
  clientIpFromRequest,
  isSuccessfulApiPayload,
  isQuotaExceeded,
  getRedis,
  CACHE_TTL_SEC: DEFAULT_CACHE_TTL_SEC,
  RATE_PER_SEC: RATE_PER_SEC,
};
