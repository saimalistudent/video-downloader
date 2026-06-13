'use strict';

/**
 * Central throughput / queue configuration.
 * Override any value via environment variables on Netlify or .env locally.
 */
module.exports = {
  CACHE_TTL_SEC: parseInt(process.env.LINK_CACHE_TTL_SEC || String(30 * 60), 10),
  USER_RATE_PER_SEC: parseInt(process.env.LINK_RATE_LIMIT_PER_SEC || '5', 10),
  USER_RATE_PER_HOUR: parseInt(process.env.LINK_RATE_LIMIT_PER_HOUR || '18000', 10),
  MAX_QUEUE_SIZE: parseInt(process.env.LOOKUP_QUEUE_MAX || '500', 10),
  MAX_QUEUE_OVERFLOW: parseInt(process.env.LOOKUP_QUEUE_OVERFLOW || '1000', 10),
  WORKER_COUNT: parseInt(process.env.LOOKUP_WORKER_COUNT || '20', 10),
  WORKER_RETRIES: parseInt(process.env.LOOKUP_WORKER_RETRIES || '3', 10),
  POLL_INTERVAL_MS: parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '2000', 10),
  JOB_TTL_MS: parseInt(process.env.QUEUE_JOB_TTL_MS || String(10 * 60 * 1000), 10),
  AVG_LOOKUP_MS: parseInt(process.env.LOOKUP_AVG_MS || '3500', 10),
  PRIORITY: {
    AD: 3,
    RETURNING: 2,
    NORMAL: 0,
    RATE_LIMITED: -1,
  },
  TARGET_REQUESTS_PER_SEC: parseInt(process.env.TARGET_REQUESTS_PER_SEC || '20', 10),
};
