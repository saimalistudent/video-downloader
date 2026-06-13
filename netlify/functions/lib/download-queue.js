'use strict';

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.YT_DLP_CONCURRENCY || '10', 10));
const MAX_WAITING = Math.max(0, parseInt(process.env.YT_DLP_QUEUE_SIZE || '120', 10));
const QUEUE_TIMEOUT_MS = Math.max(30000, parseInt(process.env.YT_DLP_QUEUE_TIMEOUT_MS || '120000', 10));
const REDIS_SLOT_POLL_MS = parseInt(process.env.YT_DLP_SLOT_POLL_MS || '80', 10);

let running = 0;
const waiters = [];
let redisSlotsDisabled = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSharedRedis() {
  if (redisSlotsDisabled) return false;
  try {
    const { getRedis } = require('./link-cache');
    return getRedis();
  } catch (err) {
    return false;
  }
}

function disableRedisSlots(reason) {
  if (!redisSlotsDisabled) {
    redisSlotsDisabled = true;
    console.warn('[download-queue] Redis slots disabled:', reason || 'unknown');
  }
}

function dequeueLocal() {
  if (running >= MAX_CONCURRENT || !waiters.length) return;
  const next = waiters.shift();
  clearTimeout(next.timer);
  running += 1;
  next.execute();
}

function withLocalDownloadSlot(fn) {
  return new Promise((resolve, reject) => {
    const execute = () => {
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          dequeueLocal();
        });
    };

    if (running < MAX_CONCURRENT) {
      execute();
      return;
    }

    if (waiters.length >= MAX_WAITING) {
      const err = new Error('Server is busy — many people are downloading right now. Please try again in a moment.');
      err.status = 503;
      err.retryAfter = 5;
      reject(err);
      return;
    }

    const waiter = {
      execute,
      reject,
      timer: setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) {
          waiters.splice(idx, 1);
          const err = new Error('Download queue timed out — try again.');
          err.status = 504;
          reject(err);
        }
      }, QUEUE_TIMEOUT_MS),
    };

    waiters.push(waiter);
  });
}

async function withRedisDownloadSlot(fn) {
  const redis = getSharedRedis();
  if (!redis) return withLocalDownloadSlot(fn);

  const slotKey = 'omni:dl:slots';
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const active = await redis.incr(slotKey);
      if (active === 1) await redis.expire(slotKey, 600);

      if (active <= MAX_CONCURRENT) {
        try {
          return await fn();
        } finally {
          try {
            await redis.decr(slotKey);
          } catch (decErr) {
            disableRedisSlots(decErr.message);
          }
        }
      }

      await redis.decr(slotKey);
      await sleep(REDIS_SLOT_POLL_MS);
    }
  } catch (err) {
    disableRedisSlots(err.message);
    return withLocalDownloadSlot(fn);
  }

  const err = new Error('Server is busy — many people are downloading right now. Please try again in a moment.');
  err.status = 503;
  err.retryAfter = 5;
  throw err;
}

function withDownloadSlot(fn) {
  const redis = getSharedRedis();
  if (redis) return withRedisDownloadSlot(fn);
  return withLocalDownloadSlot(fn);
}

function getQueueStats() {
  return {
    running: running,
    waiting: waiters.length,
    maxConcurrent: MAX_CONCURRENT,
    maxWaiting: MAX_WAITING,
    distributed: Boolean(getSharedRedis()) && !redisSlotsDisabled,
    targetRps: parseInt(process.env.TARGET_REQUESTS_PER_SEC || '5', 10),
  };
}

module.exports = {
  withDownloadSlot,
  getQueueStats,
};
