/**
 * Admin analytics — SQLite (sqlite3) + Upstash Redis fallback on Netlify serverless.
 */
const crypto = require('crypto');
const fs = require('fs');
const sqlite = require('./sqlite-db');
const { buildPlanDefinitions, getTierLabel } = require('./plan-config');

const REDIS_EVENTS_KEY = 'omni:admin:events';
const REDIS_PLANS_KEY = 'omni:admin:plans';

let usingRedis = false;
let schemaReady = false;

function cleanEnv(value) {
  let v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function redisConfig() {
  const url = cleanEnv(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
  const token = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

function isHosted() {
  return Boolean(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function redisExec(command) {
  const cfg = redisConfig();
  if (!cfg) return null;
  try {
    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(Array.isArray(command) ? command : [command]),
    });
    if (!response.ok) return null;
    return response.json();
  } catch (err) {
    console.error('[admin-db] redis error:', err.message);
    return null;
  }
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
  if (schemaReady || usingRedis) return;

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

  if (sqlite.isAvailable() && !isHosted()) {
    await initSchema();
    return 'sqlite3';
  }

  if (redisConfig()) {
    const ping = await redisExec(['PING']);
    if (ping && ping.result === 'PONG') {
      usingRedis = true;
      await seedRedisPlans();
      return 'redis';
    }
  }

  if (sqlite.isAvailable()) {
    await initSchema();
    return 'sqlite3';
  }

  throw new Error('No storage available — install sqlite3 or configure Upstash Redis.');
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
    await redisExec(['LTRIM', REDIS_EVENTS_KEY, 0, 499]);
    const dayKey = 'omni:admin:day:' + new Date(now).toISOString().slice(0, 10);
    await redisExec(['HINCRBY', dayKey, row.event_type, 1]);
    return { ok: true, storage: 'redis' };
  }

  await sqlite.run(
    'INSERT INTO events (event_type, platform, message, meta, session_id, success, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.event_type, row.platform, row.message, JSON.stringify(row.meta), row.session_id, row.success, row.created_at]
  );
  return { ok: true, storage: 'sqlite3' };
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

  await sqlite.run('UPDATE plan_usage SET limit_value = ?, updated_at = ? WHERE plan_id = ?', [limit, now, planId]);
  return plan;
}

async function getRecentEvents(limit) {
  const max = Math.min(parseInt(limit, 10) || 50, 200);
  await ensureStore();

  if (usingRedis) {
    const raw = await redisExec(['LRANGE', REDIS_EVENTS_KEY, 0, max - 1]);
    if (!raw || !raw.result) return [];
    return raw.result.map(function (item) {
      try { return JSON.parse(item); } catch (e) { return null; }
    }).filter(Boolean);
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
  const row = await sqlite.get('SELECT COUNT(*) as c FROM events WHERE created_at >= ?', [sinceMs]);
  return row ? row.c || 0 : 0;
}

async function syncRapidApiUsageFromEvents() {
  const since = monthStartMs();
  const apiOk = await countEventsSince('api_call', since, true);
  const apiFail = await countEventsSince('api_fail', since, false);
  const total = apiOk + apiFail;
  const now = Date.now();

  if (usingRedis) {
    const raw = await redisExec(['HGET', REDIS_PLANS_KEY, 'rapidapi']);
    if (raw && raw.result != null) {
      const plan = JSON.parse(raw.result);
      plan.used = total;
      plan.updated_at = now;
      plan.meta = Object.assign({}, plan.meta || {}, { synced_from_events: true, api_ok: apiOk, api_fail: apiFail });
      await redisExec(['HSET', REDIS_PLANS_KEY, 'rapidapi', JSON.stringify(plan)]);
    }
    return total;
  }

  await sqlite.run(
    'UPDATE plan_usage SET used = ?, updated_at = ? WHERE plan_id = ?',
    [total, now, 'rapidapi']
  );
  return total;
}

async function getDashboardStats() {
  await ensureStore();
  await syncPlanLimitsFromTier();
  await syncRapidApiUsageFromEvents();

  const todayStart = dayStartMs(0);
  const weekStart = dayStartMs(-7);

  const [
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
    getRecentEvents(40),
    getAllPlans(),
    fetchNetlifyBandwidth(),
    fetchUpstashUsage(),
  ]);

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
      copy.live = true;
      copy.meta = Object.assign({}, copy.meta || {}, { source: 'Counted from real API calls this month' });
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

  const storage = usingRedis ? 'redis' : 'sqlite3';

  return {
    live: true,
    verified: true,
    storage: storage,
    plan_tier: getTierLabel(),
    auto_tier: cleanEnv(process.env.OMNI_PLAN_TIER || 'free'),
    upgrade_hint: 'Jab plan upgrade karo: Netlify env mein OMNI_PLAN_TIER=starter set karo — limits khud update ho jayengi',
    updated_at: Date.now(),
    summary: {
      visitors_today: visitorsToday,
      visitors_week: visitorsWeek,
      downloads_today: downloadsSuccessToday,
      download_clicks_today: downloadStartsToday,
      download_failures_today: downloadsFailToday,
      fetch_attempts_today: fetchAttempts,
      fetch_success_today: fetchSuccessToday,
      fetch_failures_today: fetchFailToday,
      events_today: eventsToday,
      errors_today: clientErrorsToday + fetchFailToday + downloadsFailToday,
      success_rate: successRate,
      success_rate_note: successRateNote,
      fetch_rate: fetchRate,
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
  getDashboardStats,
  getRecentEvents,
  getAllPlans,
};
