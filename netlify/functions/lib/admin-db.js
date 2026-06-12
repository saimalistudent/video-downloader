/**
 * Admin analytics — SQLite (sqlite3) + Upstash Redis fallback on Netlify serverless.
 */
const crypto = require('crypto');
const fs = require('fs');
const sqlite = require('./sqlite-db');
const { buildPlanDefinitions, getTierLabel } = require('./plan-config');
const {
  fetchRapidApiUsageLive,
  getRapidApiBaseline,
  mergeRapidUsageCounts,
} = require('./rapidapi-usage');

const REDIS_EVENTS_KEY = 'omni:admin:events';
const REDIS_PLANS_KEY = 'omni:admin:plans';
const BLOB_EVENTS_KEY = 'events';
const BLOB_PLANS_KEY = 'plans';

let usingRedis = false;
let usingBlobs = false;
let schemaReady = false;
let redisSdkClient = null;

function cleanEnv(value) {
  let v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function normalizeRedisUrl(raw) {
  const url = cleanEnv(raw);
  if (!url) return '';
  if (/^redis(s)?:\/\//i.test(url)) return '';
  if (!/^https?:\/\//i.test(url)) return 'https://' + url.replace(/^\/+/, '');
  return url.replace(/\/$/, '');
}

function redisConfig() {
  const rawUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const url = normalizeRedisUrl(rawUrl);
  const token = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  if (!url || !token) return null;
  return { url, token, rawUrl: cleanEnv(rawUrl) };
}

function isHosted() {
  return Boolean(
    process.env.NETLIFY ||
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT ||
    (process.env.CONTEXT && process.env.CONTEXT !== 'dev')
  );
}

function getRedisSdk() {
  if (redisSdkClient) return redisSdkClient;
  const cfg = redisConfig();
  if (!cfg) return null;
  try {
    const { Redis } = require('@upstash/redis');
    redisSdkClient = new Redis({ url: cfg.url, token: cfg.token });
    return redisSdkClient;
  } catch (err) {
    console.error('[admin-db] @upstash/redis load failed:', err.message);
    return null;
  }
}

function hgetallToArray(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  Object.keys(obj).forEach(function (k) {
    out.push(k, obj[k]);
  });
  return out;
}

async function upstashRest(command) {
  const cfg = redisConfig();
  if (!cfg) return null;
  const cmd = Array.isArray(command) ? command : [command];
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmd),
    });
    if (!res.ok) {
      const errText = await res.text().catch(function () { return ''; });
      console.error('[admin-db] Upstash REST HTTP', res.status, errText.slice(0, 200));
      return null;
    }
    const data = await res.json();
    if (data && data.error) {
      console.error('[admin-db] Upstash REST error:', data.error);
      return null;
    }
    return { result: data.result };
  } catch (err) {
    console.error('[admin-db] Upstash REST failed:', err.message);
    return null;
  }
}

async function redisExec(command) {
  const cmd = Array.isArray(command) ? command : [command];
  const name = String(cmd[0] || '').toUpperCase();

  const restResult = await upstashRest(cmd);
  if (restResult != null) {
    if (name === 'HGETALL' && restResult.result && typeof restResult.result === 'object' && !Array.isArray(restResult.result)) {
      return { result: hgetallToArray(restResult.result) };
    }
    return restResult;
  }

  const sdk = getRedisSdk();
  if (!sdk) return null;
  try {
    switch (name) {
      case 'PING':
        return { result: await sdk.ping() };
      case 'EXISTS':
        return { result: await sdk.exists(cmd[1]) ? 1 : 0 };
      case 'HSET': {
        const key = cmd[1];
        const fields = {};
        for (let i = 2; i < cmd.length; i += 2) fields[cmd[i]] = cmd[i + 1];
        await sdk.hset(key, fields);
        return { result: 1 };
      }
      case 'HGET':
        return { result: await sdk.hget(cmd[1], cmd[2]) };
      case 'HGETALL':
        return { result: hgetallToArray(await sdk.hgetall(cmd[1])) };
      case 'HINCRBY':
        return { result: await sdk.hincrby(cmd[1], cmd[2], parseFloat(cmd[3]) || 1) };
      case 'LPUSH':
        return { result: await sdk.lpush(cmd[1], cmd[2]) };
      case 'LTRIM':
        await sdk.ltrim(cmd[1], parseInt(cmd[2], 10), parseInt(cmd[3], 10));
        return { result: 'OK' };
      case 'LRANGE':
        return { result: await sdk.lrange(cmd[1], parseInt(cmd[2], 10), parseInt(cmd[3], 10)) };
      case 'SADD':
        return { result: await sdk.sadd(cmd[1], cmd[2]) };
      case 'SCARD':
        return { result: await sdk.scard(cmd[1]) };
      case 'EXPIRE':
        return { result: await sdk.expire(cmd[1], parseInt(cmd[2], 10)) };
      case 'DEL':
        return { result: await sdk.del(cmd[1]) };
      case 'DBSIZE':
        return { result: await sdk.dbsize() };
      default:
        console.error('[admin-db] unsupported redis command:', name);
        return null;
    }
  } catch (err) {
    console.error('[admin-db] redis cmd', name, err.message);
    return null;
  }
}

async function blobStore() {
  const { getStore } = require('@netlify/blobs');
  const siteId = cleanEnv(process.env.NETLIFY_SITE_ID || process.env.SITE_ID);
  const token = cleanEnv(process.env.NETLIFY_ACCESS_TOKEN || process.env.NETLIFY_AUTH_TOKEN);
  if (siteId && token) {
    return getStore({ name: 'omni-admin', siteID: siteId, token: token });
  }
  return getStore('omni-admin');
}

async function blobGetPlansMap() {
  const store = await blobStore();
  const data = await store.get(BLOB_PLANS_KEY, { type: 'json' });
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

async function blobSavePlansMap(map) {
  const store = await blobStore();
  await store.setJSON(BLOB_PLANS_KEY, map);
}

async function blobGetEventsList() {
  const store = await blobStore();
  const data = await store.get(BLOB_EVENTS_KEY, { type: 'json' });
  return Array.isArray(data) ? data : [];
}

async function blobSaveEventsList(events) {
  const store = await blobStore();
  await store.setJSON(BLOB_EVENTS_KEY, events.slice(0, 500));
}

async function tryConnectBlobs() {
  if (!isHosted()) return false;
  try {
    const store = await blobStore();
    await store.setJSON('_health', { ok: true, t: Date.now() });
    usingBlobs = true;
    await seedBlobPlans();
    return true;
  } catch (err) {
    console.error('[admin-db] Netlify Blobs failed:', err.message);
    return false;
  }
}

function storageHelpMessage() {
  const cfg = redisConfig();
  const raw = cleanEnv(process.env.UPSTASH_REDIS_REST_URL || '');
  if (raw && /^redis(s)?:\/\//i.test(raw)) {
    return 'Wrong Upstash URL: use REST URL (https://xxxx.upstash.io) from Upstash console → REST API, not redis:// TCP link.';
  }
  if (!cfg) {
    return 'Upstash env missing. In Netlify add UPSTASH_REDIS_REST_URL (https://...) and UPSTASH_REDIS_REST_TOKEN, then Redeploy.';
  }
  return 'Upstash Redis PING failed. Copy fresh REST URL + token from console.upstash.com → your database → REST API tab, paste in Netlify env, Redeploy.';
}

async function seedBlobPlans() {
  const map = await blobGetPlansMap();
  if (Object.keys(map).length) return;
  defaultPlans().forEach(function (p) {
    map[p.plan_id] = p;
  });
  await blobSavePlansMap(map);
}

function defaultPlans() {
  return buildPlanDefinitions();
}

async function savePlan(plan) {
  const now = Date.now();
  plan.updated_at = now;
  if (usingRedis) {
    await redisExec(['HSET', REDIS_PLANS_KEY, plan.plan_id, JSON.stringify(plan)]);
    return plan;
  }
  if (usingBlobs) {
    const map = await blobGetPlansMap();
    map[plan.plan_id] = plan;
    await blobSavePlansMap(map);
    return plan;
  }
  await sqlite.run(
    'UPDATE plan_usage SET name = ?, provider = ?, used = ?, limit_value = ?, unit = ?, meta = ?, updated_at = ? WHERE plan_id = ?',
    [plan.name, plan.provider, plan.used, plan.limit_value, plan.unit, JSON.stringify(plan.meta || {}), now, plan.plan_id]
  );
  return plan;
}

async function syncPlanLimitsFromTier() {
  await ensureStore();
  const defs = buildPlanDefinitions();
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    let plan = await getPlan(def.plan_id);
    if (!plan) {
      if (usingRedis) {
        await redisExec(['HSET', REDIS_PLANS_KEY, def.plan_id, JSON.stringify(def)]);
      } else if (usingBlobs) {
        const map = await blobGetPlansMap();
        map[def.plan_id] = def;
        await blobSavePlansMap(map);
      } else {
        await sqlite.run(
          'INSERT INTO plan_usage (plan_id, name, provider, used, limit_value, unit, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [def.plan_id, def.name, def.provider, def.used, def.limit_value, def.unit, JSON.stringify(def.meta), def.updated_at]
        );
      }
      continue;
    }
    plan.name = def.name;
    plan.limit_value = def.limit_value;
    plan.unit = def.unit;
    plan.tier = def.tier;
    plan.meta = Object.assign({}, plan.meta || {}, def.meta, { tier_label: getTierLabel() });
    await savePlan(plan);
  }
}

async function initSchema() {
  if (schemaReady || usingRedis || usingBlobs) return;

  await sqlite.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      platform TEXT,
      message TEXT,
      meta TEXT,
      session_id TEXT,
      success INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);

  await sqlite.run(`
    CREATE TABLE IF NOT EXISTS plan_usage (
      plan_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      used REAL DEFAULT 0,
      limit_value REAL DEFAULT 0,
      unit TEXT DEFAULT '',
      meta TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  await sqlite.run('CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)');
  await sqlite.run('CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)');

  for (const plan of defaultPlans()) {
    const existing = await sqlite.get('SELECT plan_id FROM plan_usage WHERE plan_id = ?', [plan.plan_id]);
    if (existing) continue;
    await sqlite.run(
      'INSERT INTO plan_usage (plan_id, name, provider, used, limit_value, unit, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [plan.plan_id, plan.name, plan.provider, plan.used, plan.limit_value, plan.unit, JSON.stringify(plan.meta), plan.updated_at]
    );
  }

  schemaReady = true;
}

async function seedRedisPlans() {
  const existing = await redisExec(['EXISTS', REDIS_PLANS_KEY]);
  if (existing && existing.result) return;

  const plans = defaultPlans();
  const args = [REDIS_PLANS_KEY];
  plans.forEach(function (p) {
    args.push(p.plan_id, JSON.stringify(p));
  });
  await redisExec(['HSET'].concat(args));
}

async function ensureStore() {
  if (usingRedis) return 'redis';
  if (usingBlobs) return 'netlify-blobs';

  if (!isHosted() && sqlite.isAvailable()) {
    await initSchema();
    return 'sqlite3';
  }

  if (redisConfig()) {
    const ping = await redisExec(['PING']);
    if (ping && String(ping.result || '').toUpperCase() === 'PONG') {
      usingRedis = true;
      await seedRedisPlans();
      return 'redis';
    }
    console.error('[admin-db] Redis PING failed —', storageHelpMessage());
  }

  if (isHosted() && await tryConnectBlobs()) {
    return 'netlify-blobs';
  }

  if (isHosted()) {
    throw new Error(storageHelpMessage());
  }

  if (sqlite.isAvailable()) {
    await initSchema();
    return 'sqlite3';
  }

  throw new Error('No storage available — configure Upstash Redis (Netlify) or sqlite3 (local).');
}

function hashSession(sessionId) {
  if (!sessionId) return '';
  return crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
}

async function trackEvent(event) {
  await ensureStore();
  const now = Date.now();
  const row = {
    id: now + '-' + Math.random().toString(36).slice(2, 8),
    event_type: String(event.event_type || 'unknown'),
    platform: String(event.platform || ''),
    message: String(event.message || '').slice(0, 500),
    meta: event.meta || {},
    session_id: hashSession(event.session_id),
    success: event.success === false ? 0 : 1,
    created_at: now,
  };

  if (usingRedis) {
    await redisExec(['LPUSH', REDIS_EVENTS_KEY, JSON.stringify(row)]);
    await redisExec(['LTRIM', REDIS_EVENTS_KEY, 0, 2999]);
    const dayStr = new Date(now).toISOString().slice(0, 10);
    const dayKey = 'omni:admin:day:' + dayStr;
    await redisExec(['HINCRBY', dayKey, row.event_type, 1]);
    await redisExec(['EXPIRE', dayKey, 60 * 60 * 24 * 45]);
    if (row.event_type === 'page_view' && row.session_id) {
      const visKey = 'omni:admin:visitors:' + dayStr;
      await redisExec(['SADD', visKey, row.session_id]);
      await redisExec(['EXPIRE', visKey, 60 * 60 * 24 * 45]);
    }
    if (!row.success || row.event_type === 'client_error' || /fail/i.test(row.event_type)) {
      const errDayKey = 'omni:admin:errors:' + dayStr;
      const errMsg = normalizeErrorMessage(row.message);
      await redisExec(['HINCRBY', errDayKey, errMsg, 1]);
      await redisExec(['EXPIRE', errDayKey, 60 * 60 * 24 * 45]);
    }
    return { ok: true, storage: 'redis' };
  }

  if (usingBlobs) {
    const events = await blobGetEventsList();
    events.unshift(row);
    await blobSaveEventsList(events);
    return { ok: true, storage: 'netlify-blobs' };
  }

  await sqlite.run(
    'INSERT INTO events (event_type, platform, message, meta, session_id, success, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.event_type, row.platform, row.message, JSON.stringify(row.meta), row.session_id, row.success, row.created_at]
  );
  return { ok: true, storage: 'sqlite3' };
}

async function updateRapidApiFromLiveQuota(rateLimit) {
  if (!rateLimit || !(parseFloat(rateLimit.limit) > 0)) return null;
  await ensureStore().catch(function () {});
  const now = Date.now();
  const used = Math.max(0, parseFloat(rateLimit.used) || 0);
  const limit = parseFloat(rateLimit.limit) || 0;
  const plan = await getPlan('rapidapi');
  if (!plan) return null;

  plan.used = Math.max(parseFloat(plan.used) || 0, used, getRapidApiBaseline());
  if (limit > 0) plan.limit_value = limit;
  plan.updated_at = now;
  plan.meta = Object.assign({}, plan.meta || {}, {
    live_quota: true,
    remaining: rateLimit.remaining,
    reset: rateLimit.reset || null,
    source: 'RapidAPI billing headers (live)',
  });

  if (usingRedis) {
    await redisExec(['HSET', REDIS_PLANS_KEY, 'rapidapi', JSON.stringify(plan)]);
    return plan;
  }
  if (usingBlobs) {
    const map = await blobGetPlansMap();
    map.rapidapi = plan;
    await blobSavePlansMap(map);
    return plan;
  }
  await sqlite.run(
    'UPDATE plan_usage SET used = ?, limit_value = ?, meta = ?, updated_at = ? WHERE plan_id = ?',
    [plan.used, plan.limit_value, JSON.stringify(plan.meta), now, 'rapidapi']
  );
  return plan;
}

async function incrementPlanUsage(planId, amount) {
  await ensureStore();
  const delta = parseFloat(amount) || 1;
  const now = Date.now();

  if (usingRedis) {
    const raw = await redisExec(['HGET', REDIS_PLANS_KEY, planId]);
    if (!raw || raw.result == null) return null;
    const plan = JSON.parse(raw.result);
    plan.used = (parseFloat(plan.used) || 0) + delta;
    plan.updated_at = now;
    await redisExec(['HSET', REDIS_PLANS_KEY, planId, JSON.stringify(plan)]);
    return plan;
  }

  if (usingBlobs) {
    const map = await blobGetPlansMap();
    const plan = map[planId];
    if (!plan) return null;
    plan.used = (parseFloat(plan.used) || 0) + delta;
    plan.updated_at = now;
    map[planId] = plan;
    await blobSavePlansMap(map);
    return plan;
  }

  await sqlite.run('UPDATE plan_usage SET used = used + ?, updated_at = ? WHERE plan_id = ?', [delta, now, planId]);
  return getPlan(planId);
}

async function getPlan(planId) {
  await ensureStore();
  if (usingRedis) {
    const raw = await redisExec(['HGET', REDIS_PLANS_KEY, planId]);
    if (!raw || raw.result == null) return null;
    return JSON.parse(raw.result);
  }

  if (usingBlobs) {
    const map = await blobGetPlansMap();
    return map[planId] || null;
  }

  const r = await sqlite.get(
    'SELECT plan_id, name, provider, used, limit_value, unit, meta, updated_at FROM plan_usage WHERE plan_id = ?',
    [planId]
  );
  if (!r) return null;
  return {
    plan_id: r.plan_id,
    name: r.name,
    provider: r.provider,
    used: r.used,
    limit_value: r.limit_value,
    unit: r.unit,
    meta: JSON.parse(r.meta || '{}'),
    updated_at: r.updated_at,
  };
}

async function updatePlanLimit(planId, limitValue) {
  await ensureStore();
  const limit = parseFloat(limitValue) || 0;
  const now = Date.now();
  const plan = await getPlan(planId);
  if (!plan) return null;
  plan.limit_value = limit;
  plan.updated_at = now;

  if (usingRedis) {
    await redisExec(['HSET', REDIS_PLANS_KEY, planId, JSON.stringify(plan)]);
    return plan;
  }

  if (usingBlobs) {
    const map = await blobGetPlansMap();
    map[planId] = plan;
    await blobSavePlansMap(map);
    return plan;
  }

  await sqlite.run('UPDATE plan_usage SET limit_value = ?, updated_at = ? WHERE plan_id = ?', [limit, now, planId]);
  return plan;
}

async function getRecentEvents(limit) {
  const max = Math.min(parseInt(limit, 10) || 50, 500);
  await ensureStore();

  if (usingRedis) {
    const raw = await redisExec(['LRANGE', REDIS_EVENTS_KEY, 0, max - 1]);
    if (!raw || !raw.result) return [];
    return raw.result.map(function (item) {
      try { return JSON.parse(item); } catch (e) { return null; }
    }).filter(Boolean);
  }

  if (usingBlobs) {
    return (await blobGetEventsList()).slice(0, max);
  }

  const rows = await sqlite.all(
    'SELECT id, event_type, platform, message, meta, session_id, success, created_at FROM events ORDER BY created_at DESC LIMIT ?',
    [max]
  );

  return rows.map(function (r) {
    return {
      id: r.id,
      event_type: r.event_type,
      platform: r.platform,
      message: r.message,
      meta: JSON.parse(r.meta || '{}'),
      session_id: r.session_id,
      success: r.success,
      created_at: r.created_at,
    };
  });
}

function dayStartMs(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

function dayStrOffset(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function normalizeErrorMessage(msg) {
  let s = String(msg || '').trim();
  if (!s) return 'Unknown error';
  s = s
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b[0-9a-f]{8,}\b/gi, '[id]')
    .replace(/\d+\.?\d*\s*(mb|gb|kb|bytes?)/gi, '[size]')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  return s || 'Unknown error';
}

function parseRedisHash(raw) {
  const out = {};
  if (!raw || !raw.result) return out;
  const arr = raw.result;
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i += 2) {
      out[arr[i]] = parseInt(arr[i + 1], 10) || 0;
    }
  }
  return out;
}

async function getEventsSince(sinceMs, limit) {
  const max = Math.min(parseInt(limit, 10) || 3000, 5000);
  await ensureStore();

  if (usingRedis) {
    const raw = await redisExec(['LRANGE', REDIS_EVENTS_KEY, 0, max - 1]);
    if (!raw || !raw.result) return [];
    return raw.result.map(function (item) {
      try { return JSON.parse(item); } catch (e) { return null; }
    }).filter(function (e) {
      return e && e.created_at >= sinceMs;
    });
  }

  if (usingBlobs) {
    return (await blobGetEventsList()).filter(function (e) {
      return e.created_at >= sinceMs;
    }).slice(0, max);
  }

  const rows = await sqlite.all(
    'SELECT id, event_type, platform, message, meta, session_id, success, created_at FROM events WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?',
    [sinceMs, max]
  );

  return rows.map(function (r) {
    return {
      id: r.id,
      event_type: r.event_type,
      platform: r.platform,
      message: r.message,
      meta: JSON.parse(r.meta || '{}'),
      session_id: r.session_id,
      success: r.success,
      created_at: r.created_at,
    };
  });
}

function computePeriodStats(events) {
  const sessions = {};
  let downloads = 0;
  let download_clicks = 0;
  let errors = 0;
  let fetch_attempts = 0;
  let fetch_success = 0;

  events.forEach(function (e) {
    if (e.event_type === 'page_view' && e.session_id) sessions[e.session_id] = true;
    if (e.event_type === 'download_success') downloads++;
    if (e.event_type === 'download_start') download_clicks++;
    if (e.event_type === 'download_fail' || e.event_type === 'fetch_fail' || e.event_type === 'client_error' || e.event_type === 'api_fail') {
      errors++;
    }
    if (e.event_type === 'fetch_start') fetch_attempts++;
    if (e.event_type === 'fetch_success') fetch_success++;
  });

  return {
    visitors: Object.keys(sessions).length,
    downloads: downloads,
    download_clicks: download_clicks,
    errors: errors,
    fetch_attempts: fetch_attempts,
    fetch_success: fetch_success,
    fetch_rate: fetch_attempts > 0 ? Math.round((fetch_success / fetch_attempts) * 1000) / 10 : null,
    download_rate: download_clicks > 0 ? Math.round((downloads / download_clicks) * 1000) / 10 : null,
  };
}

function buildDailyBreakdown(events, days) {
  const map = {};
  for (let i = days - 1; i >= 0; i--) {
    const key = dayStrOffset(-i);
    map[key] = { date: key, visitors: 0, downloads: 0, errors: 0, _sessions: {} };
  }

  events.forEach(function (e) {
    const key = new Date(e.created_at).toISOString().slice(0, 10);
    if (!map[key]) return;
    if (e.event_type === 'page_view' && e.session_id) map[key]._sessions[e.session_id] = true;
    if (e.event_type === 'download_success') map[key].downloads++;
    if (e.event_type === 'download_fail' || e.event_type === 'fetch_fail' || e.event_type === 'client_error') {
      map[key].errors++;
    }
  });

  return Object.keys(map).sort().map(function (k) {
    const row = map[k];
    row.visitors = Object.keys(row._sessions).length;
    delete row._sessions;
    return row;
  });
}

function computeTopErrors(events, limit) {
  const counts = {};
  events.forEach(function (e) {
    const isError = !e.success || /fail|client_error/i.test(e.event_type);
    if (!isError) return;
    const key = normalizeErrorMessage(e.message);
    if (!counts[key]) {
      counts[key] = { message: key, count: 0, last_at: 0, types: {} };
    }
    counts[key].count++;
    counts[key].last_at = Math.max(counts[key].last_at, e.created_at);
    counts[key].types[e.event_type] = (counts[key].types[e.event_type] || 0) + 1;
  });

  return Object.values(counts)
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, limit || 12);
}

async function getAnalyticsBundle() {
  const now = Date.now();
  const todayStart = dayStartMs(0);
  const weekStart = dayStartMs(-6);
  const monthStart = dayStartMs(-29);
  const events30 = await getEventsSince(monthStart, 2000);

  const todayEvents = events30.filter(function (e) { return e.created_at >= todayStart; });
  const weekEvents = events30.filter(function (e) { return e.created_at >= weekStart; });

  return {
    periods: {
      today: computePeriodStats(todayEvents),
      last_7_days: computePeriodStats(weekEvents),
      last_30_days: computePeriodStats(events30),
    },
    daily: buildDailyBreakdown(events30, 30),
    top_errors: computeTopErrors(events30, 12),
    updated_at: now,
  };
}

async function countEventsSince(eventType, sinceMs, successOnly) {
  await ensureStore();

  if (usingRedis) {
    const events = await getRecentEvents(500);
    return events.filter(function (e) {
      if (e.created_at < sinceMs) return false;
      if (eventType && e.event_type !== eventType) return false;
      if (successOnly === true && !e.success) return false;
      if (successOnly === false && e.success) return false;
      return true;
    }).length;
  }

  if (usingBlobs) {
    const events = await blobGetEventsList();
    return events.filter(function (e) {
      if (e.created_at < sinceMs) return false;
      if (eventType && e.event_type !== eventType) return false;
      if (successOnly === true && !e.success) return false;
      if (successOnly === false && e.success) return false;
      return true;
    }).length;
  }

  let sql = 'SELECT COUNT(*) as c FROM events WHERE created_at >= ?';
  const params = [sinceMs];
  if (eventType) { sql += ' AND event_type = ?'; params.push(eventType); }
  if (successOnly === true) sql += ' AND success = 1';
  if (successOnly === false) sql += ' AND success = 0';

  const row = await sqlite.get(sql, params);
  return row ? row.c || 0 : 0;
}

async function getUniqueVisitorsSince(sinceMs) {
  await ensureStore();

  if (usingRedis) {
    const events = await getRecentEvents(500);
    const sessions = {};
    events.forEach(function (e) {
      if (e.created_at >= sinceMs && e.event_type === 'page_view' && e.session_id) {
        sessions[e.session_id] = true;
      }
    });
    return Object.keys(sessions).length;
  }

  if (usingBlobs) {
    const events = await blobGetEventsList();
    const sessions = {};
    events.forEach(function (e) {
      if (e.created_at >= sinceMs && e.event_type === 'page_view' && e.session_id) {
        sessions[e.session_id] = true;
      }
    });
    return Object.keys(sessions).length;
  }

  const row = await sqlite.get(
    "SELECT COUNT(DISTINCT session_id) as c FROM events WHERE created_at >= ? AND event_type = 'page_view' AND session_id != ''",
    [sinceMs]
  );
  return row ? row.c || 0 : 0;
}

async function getAllPlans() {
  await ensureStore();
  if (usingRedis) {
    const raw = await redisExec(['HGETALL', REDIS_PLANS_KEY]);
    if (!raw || !raw.result || !raw.result.length) return defaultPlans();
    const plans = [];
    for (let i = 0; i < raw.result.length; i += 2) {
      try { plans.push(JSON.parse(raw.result[i + 1])); } catch (e) { /* skip */ }
    }
    return plans.length ? plans : defaultPlans();
  }

  if (usingBlobs) {
    const map = await blobGetPlansMap();
    const plans = Object.keys(map).map(function (k) { return map[k]; });
    return plans.length ? plans : defaultPlans();
  }

  const rows = await sqlite.all(
    'SELECT plan_id, name, provider, used, limit_value, unit, meta, updated_at FROM plan_usage ORDER BY plan_id'
  );
  if (!rows.length) return defaultPlans();

  return rows.map(function (r) {
    return {
      plan_id: r.plan_id,
      name: r.name,
      provider: r.provider,
      used: r.used,
      limit_value: r.limit_value,
      unit: r.unit,
      meta: JSON.parse(r.meta || '{}'),
      updated_at: r.updated_at,
    };
  });
}

async function fetchNetlifyBandwidth() {
  const token = cleanEnv(process.env.NETLIFY_ACCESS_TOKEN || process.env.NETLIFY_PAT);
  const siteId = cleanEnv(process.env.NETLIFY_SITE_ID);
  if (!token || !siteId) return null;
  try {
    const response = await fetch('https://api.netlify.com/api/v1/sites/' + siteId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!response.ok) return null;
    const site = await response.json();
    return { name: site.name, url: site.ssl_url || site.url, bandwidthUsedBytes: site.bandwidth || 0 };
  } catch (err) {
    return null;
  }
}

function planPercent(plan) {
  const used = parseFloat(plan.used) || 0;
  const limit = parseFloat(plan.limit_value) || 0;
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 1000) / 10);
}

async function fetchUpstashUsage() {
  if (redisConfig() && usingRedis) {
    try {
      const info = await redisExec(['INFO', 'memory']);
      const text = info && info.result ? String(info.result) : '';
      const memMatch = text.match(/used_memory:(\d+)/);
      const bytes = memMatch ? parseInt(memMatch[1], 10) : 0;
      const dbsize = await redisExec(['DBSIZE']);
      const keys = dbsize && dbsize.result != null ? parseInt(dbsize.result, 10) : 0;
      return {
        storage_mb: Math.round((bytes / (1024 * 1024)) * 100) / 100,
        storage_bytes: bytes,
        keys: keys,
        source: 'Live Upstash Redis',
      };
    } catch (err) {
      return null;
    }
  }

  try {
    const dbPath = sqlite.dbPath();
    if (fs.existsSync(dbPath)) {
      const bytes = fs.statSync(dbPath).size;
      return {
        storage_mb: Math.round((bytes / (1024 * 1024)) * 100) / 100,
        storage_bytes: bytes,
        keys: null,
        source: 'Local SQLite file',
      };
    }
  } catch (err) { /* skip */ }
  return null;
}

function enrichDomainPlan(plan) {
  const meta = plan.meta || {};
  plan.display_mode = 'validity';

  if (meta.purchased === false || meta.purchased === 'false') {
    plan.used = null;
    plan.limit_value = null;
    plan.percent = null;
    plan.health_bar = null;
    plan.badge_label = 'Not purchased';
    plan.status = 'ok';
    plan.unit = meta.note || 'No custom domain — Netlify subdomain is free';
    return plan;
  }

  const isNetlifySub = /\.netlify\.app$/i.test(String(plan.name || ''));
  if (isNetlifySub) {
    plan.used = null;
    plan.limit_value = null;
    plan.percent = null;
    plan.health_bar = null;
    plan.badge_label = 'Free subdomain';
    plan.status = 'ok';
    plan.unit = 'omnidownloader.netlify.app — no purchase needed';
    return plan;
  }

  if (meta.expires) {
    const expires = new Date(meta.expires).getTime();
    const daysLeft = Math.max(0, Math.ceil((expires - Date.now()) / 86400000));
    plan.used = daysLeft;
    plan.limit_value = meta.expires;
    plan.unit = 'days until renewal';
    plan.percent = null;
    plan.health_bar = Math.min(100, Math.round((daysLeft / 365) * 100));
    plan.badge_label = daysLeft > 0 ? daysLeft + ' days left' : 'Expired';
    plan.status = daysLeft <= 0 ? 'critical' : daysLeft < 30 ? 'warning' : 'ok';
  } else {
    plan.badge_label = 'Active';
    plan.unit = 'Custom domain — add DOMAIN_EXPIRES in env';
  }
  return plan;
}

function monthStartMs() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function countAllEventsSince(sinceMs) {
  await ensureStore();
  if (usingRedis) {
    const events = await getRecentEvents(500);
    return events.filter(function (e) { return e.created_at >= sinceMs; }).length;
  }
  if (usingBlobs) {
    const events = await blobGetEventsList();
    return events.filter(function (e) { return e.created_at >= sinceMs; }).length;
  }
  const row = await sqlite.get('SELECT COUNT(*) as c FROM events WHERE created_at >= ?', [sinceMs]);
  return row ? row.c || 0 : 0;
}

async function syncRapidApiUsageFromEvents() {
  const since = monthStartMs();
  const apiOk = await countEventsSince('api_call', since, true);
  const apiFail = await countEventsSince('api_fail', since, false);
  const eventTotal = apiOk + apiFail;
  const baseline = getRapidApiBaseline();
  const now = Date.now();

  if (usingRedis) {
    const raw = await redisExec(['HGET', REDIS_PLANS_KEY, 'rapidapi']);
    if (raw && raw.result != null) {
      const plan = JSON.parse(raw.result);
      plan.used = mergeRapidUsageCounts(plan.used, eventTotal, null, baseline);
      plan.updated_at = now;
      plan.meta = Object.assign({}, plan.meta || {}, { synced_from_events: true, api_ok: apiOk, api_fail: apiFail });
      await redisExec(['HSET', REDIS_PLANS_KEY, 'rapidapi', JSON.stringify(plan)]);
    }
    return eventTotal;
  }

  if (usingBlobs) {
    const map = await blobGetPlansMap();
    if (map.rapidapi) {
      map.rapidapi.used = mergeRapidUsageCounts(map.rapidapi.used, eventTotal, null, baseline);
      map.rapidapi.updated_at = now;
      map.rapidapi.meta = Object.assign({}, map.rapidapi.meta || {}, { synced_from_events: true, api_ok: apiOk, api_fail: apiFail });
      await blobSavePlansMap(map);
    }
    return eventTotal;
  }

  const existing = await getPlan('rapidapi');
  const merged = mergeRapidUsageCounts(existing && existing.used, eventTotal, null, baseline);
  await sqlite.run(
    'UPDATE plan_usage SET used = ?, updated_at = ? WHERE plan_id = ?',
    [merged, now, 'rapidapi']
  );
  return eventTotal;
}

function buildFallbackDashboard(storageError, rapidLive, netlifyLive) {
  const plans = defaultPlans().map(function (plan) {
    const copy = Object.assign({}, plan, {
      percent: planPercent(plan),
      status: 'ok',
      display_mode: plan.provider === 'domain' ? 'validity' : 'usage',
      live: false,
    });
    if (plan.provider === 'domain') enrichDomainPlan(copy);
    if (plan.provider === 'rapidapi') {
      enrichRapidApiPlan(copy, rapidLive, 0);
    }
    if (plan.provider === 'netlify' && netlifyLive && netlifyLive.bandwidthUsedBytes) {
      copy.used = Math.round(netlifyLive.bandwidthUsedBytes / (1024 * 1024));
      copy.percent = planPercent(copy);
      copy.live = true;
      copy.meta = Object.assign({}, copy.meta || {}, { source: 'Live Netlify API', site_url: netlifyLive.url });
    }
    return copy;
  });

  const hasRapidLive = rapidLive && rapidLive.limit > 0;

  return {
    live: hasRapidLive || Boolean(netlifyLive),
    verified: !storageError,
    storage: 'none',
    storage_error: storageError || null,
    plan_tier: getTierLabel(),
    auto_tier: cleanEnv(process.env.OMNI_PLAN_TIER || 'free'),
    upgrade_hint: 'Netlify → Site settings → Environment variables → UPSTASH_REDIS_REST_URL + TOKEN → Redeploy',
    updated_at: Date.now(),
    analytics: {
      periods: {
        today: computePeriodStats([]),
        last_7_days: computePeriodStats([]),
        last_30_days: computePeriodStats([]),
      },
      daily: buildDailyBreakdown([], 30),
      top_errors: [],
      updated_at: Date.now(),
    },
    summary: {
      visitors_today: 0,
      visitors_week: 0,
      visitors_month: 0,
      downloads_today: 0,
      downloads_week: 0,
      downloads_month: 0,
      download_clicks_today: 0,
      download_failures_today: 0,
      fetch_attempts_today: 0,
      fetch_success_today: 0,
      fetch_failures_today: 0,
      events_today: 0,
      errors_today: 0,
      success_rate: null,
      success_rate_note: storageError ? 'Fix storage to track visitors & downloads' : 'No data yet',
      fetch_rate: null,
      fetch_rate_note: 'No video fetch attempts today',
    },
    plans: plans,
    recent_activity: [],
    recent_errors: [],
  };
}

function enrichRapidApiPlan(plan, rapidLive, eventUsed) {
  const baseline = getRapidApiBaseline();
  if (rapidLive && rapidLive.limit > 0) {
    plan.limit_value = rapidLive.limit;
    plan.used = mergeRapidUsageCounts(plan.used, eventUsed, rapidLive, baseline);
    plan.percent = planPercent(plan);
    plan.live = true;
    plan.badge_label = null;
    plan.meta = Object.assign({}, plan.meta || {}, {
      source: 'Live RapidAPI quota — full billing period usage',
      remaining: rapidLive.remaining,
      reset: rapidLive.reset || null,
    });
    if (plan.percent >= 90) plan.status = 'critical';
    else if (plan.percent >= 75) plan.status = 'warning';
    else plan.status = 'ok';
    return plan;
  }
  if (baseline > 0) {
    plan.used = Math.max(parseFloat(plan.used) || 0, baseline);
    plan.percent = planPercent(plan);
    plan.live = true;
    plan.meta = Object.assign({}, plan.meta || {}, { source: 'RAPIDAPI_USAGE_BASELINE env' });
  } else {
    plan.meta = Object.assign({}, plan.meta || {}, { source: 'Waiting for storage connection' });
  }
  return plan;
}

async function getDashboardStats() {
  const rapidLivePromise = fetchRapidApiUsageLive().catch(function () { return null; });
  const netlifyLivePromise = fetchNetlifyBandwidth().catch(function () { return null; });

  let storageError = null;
  try {
    await ensureStore();
  } catch (err) {
    storageError = err.message;
    console.error('[admin-db] ensureStore:', err.message);
  }

  const rapidLive = await rapidLivePromise;
  const netlifyLiveEarly = await netlifyLivePromise;

  if (rapidLive && rapidLive.limit > 0) {
    try {
      await updateRapidApiFromLiveQuota(rapidLive);
    } catch (err) {
      console.warn('[admin-db] rapid quota save:', err.message);
    }
  }

  if (storageError) {
    return buildFallbackDashboard(storageError, rapidLive, netlifyLiveEarly);
  }

  try {
    await syncPlanLimitsFromTier();
    await syncRapidApiUsageFromEvents();
  } catch (err) {
    console.error('[admin-db] sync:', err.message);
  }

  const todayStart = dayStartMs(0);
  const weekStart = dayStartMs(-7);

  let visitorsToday = 0;
  let visitorsWeek = 0;
  let downloadsSuccessToday = 0;
  let downloadsFailToday = 0;
  let downloadStartsToday = 0;
  let fetchStartsToday = 0;
  let fetchSuccessToday = 0;
  let fetchFailToday = 0;
  let clientErrorsToday = 0;
  let eventsToday = 0;
  let recentEvents = [];
  let plans = defaultPlans();
  let netlifyLive = null;
  let upstashLive = null;

  try {
    [
      visitorsToday,
      visitorsWeek,
      downloadsSuccessToday,
      downloadsFailToday,
      downloadStartsToday,
      fetchStartsToday,
      fetchSuccessToday,
      fetchFailToday,
      clientErrorsToday,
      eventsToday,
      recentEvents,
      plans,
      netlifyLive,
      upstashLive,
    ] = await Promise.all([
      getUniqueVisitorsSince(todayStart),
      getUniqueVisitorsSince(weekStart),
      countEventsSince('download_success', todayStart, true),
      countEventsSince('download_fail', todayStart, false),
      countEventsSince('download_start', todayStart, null),
      countEventsSince('fetch_start', todayStart, null),
      countEventsSince('fetch_success', todayStart, true),
      countEventsSince('fetch_fail', todayStart, false),
      countEventsSince('client_error', todayStart, false),
      countAllEventsSince(todayStart),
      getRecentEvents(50),
      getAllPlans(),
      Promise.resolve(netlifyLiveEarly),
      fetchUpstashUsage().catch(function () { return null; }),
    ]);
  } catch (err) {
    console.error('[admin-db] stats query:', err.message);
    const fallback = buildFallbackDashboard(err.message, rapidLive, netlifyLiveEarly);
    fallback.storage = usingRedis ? 'redis' : usingBlobs ? 'netlify-blobs' : 'sqlite3';
    return fallback;
  }

  let successRate = null;
  let successRateNote = 'No download button clicks today';

  if (downloadStartsToday > 0) {
    successRate = Math.round((downloadsSuccessToday / downloadStartsToday) * 1000) / 10;
    successRateNote = downloadsSuccessToday + ' saved of ' + downloadStartsToday + ' download clicks (your actions today)';
  }

  let fetchRate = null;
  let fetchRateNote = 'No video fetch attempts today';
  const fetchAttempts = fetchStartsToday;
  if (fetchAttempts > 0) {
    fetchRate = Math.round((fetchSuccessToday / fetchAttempts) * 1000) / 10;
    fetchRateNote = fetchSuccessToday + ' of ' + fetchAttempts + ' video link fetches succeeded';
  } else if (fetchFailToday > 0) {
    fetchRate = 0;
    fetchRateNote = fetchFailToday + ' fetch failed — no successful fetches today';
  }

  const enrichedPlans = plans.map(function (plan) {
    const copy = Object.assign({}, plan, { percent: planPercent(plan), status: 'ok', display_mode: 'usage' });
    if (plan.provider === 'domain') enrichDomainPlan(copy);
    if (plan.provider === 'rapidapi') {
      enrichRapidApiPlan(copy, rapidLive, copy.used);
    }
    if (plan.provider === 'netlify') {
      if (netlifyLive && netlifyLive.bandwidthUsedBytes) {
        copy.used = Math.round(netlifyLive.bandwidthUsedBytes / (1024 * 1024));
        copy.percent = planPercent(copy);
        copy.live = true;
        copy.meta = Object.assign({}, copy.meta || {}, {
          site_url: netlifyLive.url,
          source: 'Live Netlify API',
          tier: getTierLabel(),
        });
      } else {
        copy.live = false;
        copy.percent = copy.used > 0 ? planPercent(copy) : null;
        copy.badge_label = copy.percent != null ? copy.percent + '% used' : 'Free tier';
        copy.meta = Object.assign({}, copy.meta || {}, {
          source: 'Set NETLIFY_ACCESS_TOKEN for live bandwidth (limit from free plan)',
          tier: getTierLabel(),
        });
      }
    }
    if (plan.provider === 'upstash') {
      if (upstashLive && upstashLive.storage_mb != null) {
        copy.used = upstashLive.storage_mb;
        copy.percent = planPercent(copy);
        copy.live = true;
        copy.meta = Object.assign({}, copy.meta || {}, {
          source: upstashLive.source,
          keys: upstashLive.keys,
          bytes: upstashLive.storage_bytes,
          tier: getTierLabel(),
        });
        copy.unit = 'MB storage used (admin data)';
        if (copy.percent >= 90) copy.status = 'critical';
        else if (copy.percent >= 75) copy.status = 'warning';
      } else {
        copy.live = false;
        copy.badge_label = 'No data yet';
        copy.meta = Object.assign({}, copy.meta || {}, { tier: getTierLabel() });
      }
    }
    if (copy.display_mode !== 'validity' && copy.live !== false) {
      if (copy.percent >= 90) copy.status = 'critical';
      else if (copy.percent >= 75) copy.status = 'warning';
    }
    return copy;
  });

  const errorEvents = recentEvents.filter(function (e) {
    return !e.success || e.event_type === 'client_error' || e.event_type === 'fetch_fail' || e.event_type === 'download_fail';
  }).slice(0, 20);

  let analytics = {
    periods: {
      today: computePeriodStats([]),
      last_7_days: computePeriodStats([]),
      last_30_days: computePeriodStats([]),
    },
    daily: buildDailyBreakdown([], 30),
    top_errors: [],
    updated_at: Date.now(),
  };

  try {
    analytics = await getAnalyticsBundle();
  } catch (err) {
    console.warn('[admin-db] analytics bundle:', err.message);
  }

  const storage = usingRedis ? 'redis' : usingBlobs ? 'netlify-blobs' : 'sqlite3';
  const storageWarning = usingBlobs && redisConfig() ? storageHelpMessage() : null;

  return {
    live: true,
    verified: true,
    storage: storage,
    storage_warning: storageWarning,
    plan_tier: getTierLabel(),
    auto_tier: cleanEnv(process.env.OMNI_PLAN_TIER || 'free'),
    updated_at: Date.now(),
    analytics: analytics,
    summary: {
      visitors_today: analytics.periods.today.visitors,
      visitors_week: analytics.periods.last_7_days.visitors,
      visitors_month: analytics.periods.last_30_days.visitors,
      downloads_today: analytics.periods.today.downloads,
      downloads_week: analytics.periods.last_7_days.downloads,
      downloads_month: analytics.periods.last_30_days.downloads,
      download_clicks_today: analytics.periods.today.download_clicks,
      download_failures_today: downloadsFailToday,
      fetch_attempts_today: fetchAttempts,
      fetch_success_today: fetchSuccessToday,
      fetch_failures_today: fetchFailToday,
      events_today: eventsToday,
      errors_today: analytics.periods.today.errors,
      success_rate: analytics.periods.today.download_rate,
      success_rate_note: successRateNote,
      fetch_rate: analytics.periods.today.fetch_rate,
      fetch_rate_note: fetchRateNote,
    },
    plans: enrichedPlans,
    recent_activity: recentEvents,
    recent_errors: errorEvents,
  };
}

module.exports = {
  ensureStore,
  trackEvent,
  incrementPlanUsage,
  updatePlanLimit,
  updateRapidApiFromLiveQuota,
  getDashboardStats,
  getRecentEvents,
  getAllPlans,
};
