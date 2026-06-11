/**
 * Honest download counter — only real stream downloads are counted.
 * Does NOT use RAPIDAPI_KEY. Optional: UPSTASH_REDIS_REST_URL + TOKEN.
 */
const REDIS_KEY = 'omni:downloads:verified';

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

async function redisCommand(pathSuffix) {
  const cfg = redisConfig();
  if (!cfg) return null;

  try {
    const response = await fetch(`${cfg.url}${pathSuffix}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });

    if (!response.ok) {
      console.error('[stats-store] Redis HTTP', response.status, pathSuffix);
      return null;
    }

    return response.json();
  } catch (err) {
    console.error('[stats-store] Redis error:', err.message);
    return null;
  }
}

function buildStats(total, persistent, extra) {
  return {
    total: Math.max(0, total),
    verified: true,
    persistent,
    live: persistent,
    storage: persistent ? 'redis' : 'none',
    ...(extra || {}),
  };
}

async function getDownloadCount() {
  if (!redisConfig()) {
    return buildStats(0, false, {
      note: 'Counter is local-only without Upstash Redis. RAPIDAPI_KEY is not required for stats.',
    });
  }

  const data = await redisCommand(`/get/${REDIS_KEY}`);
  if (!data) {
    return buildStats(0, false, {
      warning: 'Upstash Redis configured but unreachable — check UPSTASH_REDIS_REST_URL and TOKEN.',
    });
  }

  if (data.result === null || data.result === undefined) {
    return buildStats(0, true);
  }

  return buildStats(parseInt(data.result, 10) || 0, true);
}

async function incrementDownloadCount() {
  if (!redisConfig()) {
    return buildStats(0, false);
  }

  try {
    const exists = await redisCommand(`/exists/${REDIS_KEY}`);
    if (!exists) return buildStats(0, false);

    if (!exists.result) {
      await redisCommand(`/set/${REDIS_KEY}/0`);
    }

    const data = await redisCommand(`/incr/${REDIS_KEY}`);
    if (!data) return buildStats(0, false);

    return buildStats(parseInt(data.result, 10) || 0, true);
  } catch (err) {
    console.error('[stats-store] increment failed:', err.message);
    return buildStats(0, false);
  }
}

module.exports = {
  getDownloadCount,
  incrementDownloadCount,
  redisConfig,
};
