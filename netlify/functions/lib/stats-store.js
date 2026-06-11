/**
 * Honest download counter — only real stream downloads are counted.
 */
const REDIS_KEY = 'omni:downloads:verified';

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

async function redisCommand(pathSuffix) {
  const cfg = redisConfig();
  if (!cfg) return null;

  const response = await fetch(`${cfg.url}${pathSuffix}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis request failed (${response.status})`);
  }

  return response.json();
}

function buildStats(total, persistent) {
  return {
    total: Math.max(0, total),
    verified: true,
    persistent,
    live: persistent,
  };
}

async function getDownloadCount() {
  if (redisConfig()) {
    const data = await redisCommand(`/get/${REDIS_KEY}`);
    if (data.result === null || data.result === undefined) {
      return buildStats(0, true);
    }
    return buildStats(parseInt(data.result, 10) || 0, true);
  }

  return buildStats(0, false);
}

async function incrementDownloadCount() {
  if (redisConfig()) {
    const exists = await redisCommand(`/exists/${REDIS_KEY}`);
    if (!exists.result) {
      await redisCommand(`/set/${REDIS_KEY}/0`);
    }
    const data = await redisCommand(`/incr/${REDIS_KEY}`);
    return buildStats(parseInt(data.result, 10) || 0, true);
  }

  return buildStats(0, false);
}

module.exports = {
  getDownloadCount,
  incrementDownloadCount,
};
