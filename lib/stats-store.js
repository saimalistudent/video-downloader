/**
 * Honest download counter — only real /api/stream downloads are counted.
 * Starts at 0. No fake seed numbers.
 */
const fs = require('fs');
const path = require('path');

const REDIS_KEY = 'omni:downloads:verified';

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

function isHostedServerless() {
  return Boolean(process.env.VERCEL || process.env.NETLIFY);
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

function localStatsPath() {
  return path.join(process.cwd(), 'data', 'downloads.json');
}

function readLocalCount() {
  try {
    const raw = fs.readFileSync(localStatsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const total = parseInt(parsed.total, 10);
    return Number.isFinite(total) && total >= 0 ? total : 0;
  } catch {
    return 0;
  }
}

function writeLocalCount(total) {
  const safeTotal = Math.max(0, total);
  const dir = path.dirname(localStatsPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(localStatsPath(), `${JSON.stringify({ total: safeTotal }, null, 2)}\n`);
  return safeTotal;
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

  if (isHostedServerless()) {
    return buildStats(0, false);
  }

  return buildStats(readLocalCount(), true);
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

  if (isHostedServerless()) {
    return buildStats(0, false);
  }

  return buildStats(writeLocalCount(readLocalCount() + 1), true);
}

module.exports = {
  getDownloadCount,
  incrementDownloadCount,
};
