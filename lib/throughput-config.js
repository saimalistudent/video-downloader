'use strict';

/**
 * Central throughput / queue configuration.
 * Override any value via environment variables on Netlify or .env locally.
 */
module.exports = {
  /** Link result cache TTL — 30 minutes default */
  CACHE_TTL_SEC: parseInt(process.env.LINK_CACHE_TTL_SEC || String(30 * 60), 10),

  /** Per-user spam guard (requests per second) — still queued, never hard-rejected */
  USER_RATE_PER_SEC: parseInt(process.env.LINK_RATE_LIMIT_PER_SEC || '5', 10),

  /** Hourly cap per IP (very high — queue handles load) */
  USER_RATE_PER_HOUR: parseInt(process.env.LINK_RATE_LIMIT_PER_HOUR || '18000', 10),

  /** FIFO queue — soft display threshold */
  MAX_QUEUE_SIZE: parseInt(process.env.LOOKUP_QUEUE_MAX || '500', 10),

  /** Hard cap — still accepted beyond MAX with overflow message (never 429 from queue) */
  MAX_QUEUE_OVERFLOW: parseInt(process.env.LOOKUP_QUEUE_OVERFLOW || '1000', 10),

  /** Parallel lookup workers */
  WORKER_COUNT: parseInt(process.env.LOOKUP_WORKER_COUNT || '20', 10),

  /** Retries per lookup inside worker */
  WORKER_RETRIES: parseInt(process.env.LOOKUP_WORKER_RETRIES || '1', 10),

  /** Frontend poll interval */
  POLL_INTERVAL_MS: parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '600', 10),

  /** Drop queued jobs with no poll heartbeat */
  JOB_TTL_MS: parseInt(process.env.QUEUE_JOB_TTL_MS || String(10 * 60 * 1000), 10),

  /** ETA calculation */
  AVG_LOOKUP_MS: parseInt(process.env.LOOKUP_AVG_MS || '2200', 10),

  /** Wait for inline lookup before returning 202 (position #1) */
  FAST_COMPLETE_MS: parseInt(process.env.LOOKUP_FAST_COMPLETE_MS || '60000', 10),

  /** Priority weights */
  PRIORITY: {
    AD: 3,
    RETURNING: 2,
    NORMAL: 0,
    RATE_LIMITED: -1,
  },

  TARGET_REQUESTS_PER_SEC: parseInt(process.env.TARGET_REQUESTS_PER_SEC || '20', 10),
};
