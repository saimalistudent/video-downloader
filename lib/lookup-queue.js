'use strict';

const crypto = require('crypto');
const config = require('./throughput-config');
const {
  getCachedLink,
  setCachedLink,
  invalidateCachedLink,
  isSuccessfulApiPayload,
  isQuotaExceeded,
  checkUserRateLimit,
  getRedis,
} = require('./link-cache');

const JOB_PREFIX = 'omni:lookup:job:';
const QUEUE_KEY = 'omni:lookup:queue';
const URL_JOB_PREFIX = 'omni:lookup:url:';
const ACTIVE_KEY = 'omni:lookup:active';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newJobId() {
  return crypto.randomBytes(10).toString('hex');
}

function estimateWaitSec(position) {
  const pos = Math.max(1, position);
  const batches = Math.ceil(pos / Math.max(1, config.WORKER_COUNT));
  return Math.max(1, Math.ceil(batches * (config.AVG_LOOKUP_MS / 1000)));
}

function queueMessage(position, waitSec) {
  if (position > config.MAX_QUEUE_SIZE) {
    const mins = Math.max(1, Math.ceil(waitSec / 60));
    return 'You are #' + position + ' — high traffic, wait ~' + mins + ' min';
  }
  return 'You are #' + position + ' in line — ~' + waitSec + ' sec';
}

class LookupQueueManager {
  constructor() {
    this.jobs = new Map();
    this.queue = [];
    this.urlJobs = new Map();
    this.activeWorkers = 0;
    this.cleanupTimer = setInterval(() => this.cleanupStaleJobs(), 30000);
  }

  async submit(videoUrl, options) {
    options = options || {};
    const refresh = options.refresh === true;
    const clientIp = options.clientIp || 'unknown';
    const urlKey = String(videoUrl || '').trim();
    if (!urlKey) {
      return { immediate: true, status: 400, data: { error: 'Missing url' } };
    }

    if (!refresh) {
      const cached = await getCachedLink(urlKey);
      if (cached) {
        return {
          immediate: true,
          status: cached.status,
          data: cached.data,
          fromCache: true,
        };
      }
    } else {
      await invalidateCachedLink(urlKey);
    }

    const existingId = this.urlJobs.get(urlKey);
    if (!refresh && existingId) {
      const existing = await this.getJobRecord(existingId);
      if (existing && (existing.status === 'queued' || existing.status === 'processing')) {
        return this.buildQueuedResponse(existing);
      }
    }

    const userRate = await checkUserRateLimit(clientIp);
    let priority = parseInt(options.priority, 10) || config.PRIORITY.NORMAL;
    if (!userRate.ok) {
      priority = config.PRIORITY.RATE_LIMITED;
    }

    const jobId = newJobId();
    const job = {
      id: jobId,
      videoUrl: urlKey,
      refresh: refresh,
      clientIp: clientIp,
      priority: priority,
      status: 'queued',
      position: 0,
      createdAt: Date.now(),
      lastPollAt: Date.now(),
      retries: 0,
      fromCache: false,
      result: null,
      error: null,
    };

    await this.persistJob(job);
    this.jobs.set(jobId, job);
    this.urlJobs.set(urlKey, jobId);
    this.insertByPriority(jobId, priority);
    await this.syncQueueToRedis();
    this.updatePositions();

    const refreshed = this.jobs.get(jobId);
    this.pumpWorkers();

    const maybeDone = await this.tryFastComplete(jobId, 2500);
    if (maybeDone) return maybeDone;

    return this.buildQueuedResponse(refreshed || job);
  }

  insertByPriority(jobId, priority) {
    let idx = this.queue.length;
    for (let i = 0; i < this.queue.length; i += 1) {
      const other = this.jobs.get(this.queue[i]);
      if (other && other.priority < priority) {
        idx = i;
        break;
      }
    }
    this.queue.splice(idx, 0, jobId);
  }

  updatePositions() {
    this.queue.forEach((id, index) => {
      const job = this.jobs.get(id);
      if (job) job.position = index + 1;
    });
  }

  buildQueuedResponse(job) {
    const position = this.getPosition(job.id) || job.position || this.queue.length;
    const waitSec = estimateWaitSec(position);
    return {
      immediate: false,
      queued: true,
      job_id: job.id,
      status: job.status,
      position: position,
      estimated_wait_sec: waitSec,
      overflow: position > config.MAX_QUEUE_SIZE,
      message: queueMessage(position, waitSec),
      poll_url: '/api/queue/status?job_id=' + job.id,
    };
  }

  getPosition(jobId) {
    const idx = this.queue.indexOf(jobId);
    if (idx >= 0) return idx + 1;
    const job = this.jobs.get(jobId);
    if (job && job.status === 'processing') return 0;
    return 0;
  }

  async getStatus(jobId) {
    const job = await this.getJobRecord(jobId);
    if (!job) return { status: 'not_found', job_id: jobId };

    job.lastPollAt = Date.now();
    await this.persistJob(job);
    this.jobs.set(jobId, job);

    const position = job.status === 'queued' ? this.getPosition(jobId) : 0;
    const waitSec = estimateWaitSec(position || 1);
    let progress = 5;
    if (job.status === 'queued') progress = Math.min(65, Math.max(8, 100 - position * 2));
    if (job.status === 'processing') progress = 75;
    if (job.status === 'done') progress = 100;
    if (job.status === 'failed') progress = 100;

    return {
      job_id: jobId,
      status: job.status,
      position: position,
      estimated_wait_sec: job.status === 'queued' ? waitSec : 0,
      progress: progress,
      from_cache: Boolean(job.fromCache),
      message: job.status === 'queued' ? queueMessage(position, waitSec) : job.message,
      result: job.status === 'done' ? job.result : undefined,
      error: job.status === 'failed' ? job.error : undefined,
    };
  }

  async getJobRecord(jobId) {
    if (this.jobs.has(jobId)) return this.jobs.get(jobId);
    const redis = getRedis();
    if (!redis) return null;
    try {
      const raw = await redis.hgetall(JOB_PREFIX + jobId);
      if (!raw || !raw.id) return null;
      const job = Object.assign({}, raw);
      job.refresh = job.refresh === '1' || job.refresh === true;
      job.fromCache = job.fromCache === '1' || job.fromCache === true;
      job.priority = parseInt(job.priority, 10) || 0;
      job.retries = parseInt(job.retries, 10) || 0;
      job.position = parseInt(job.position, 10) || 0;
      job.createdAt = parseInt(job.createdAt, 10) || Date.now();
      job.lastPollAt = parseInt(job.lastPollAt, 10) || Date.now();
      if (job.result && typeof job.result === 'string') {
        try { job.result = JSON.parse(job.result); } catch (e) { /* ignore */ }
      }
      if (job.error && typeof job.error === 'string') {
        try { job.error = JSON.parse(job.error); } catch (e) { job.error = { message: job.error }; }
      }
      this.jobs.set(jobId, job);
      return job;
    } catch (err) {
      console.warn('[lookup-queue] redis get job failed:', err.message);
      return null;
    }
  }

  async persistJob(job) {
    const redis = getRedis();
    if (!redis) return;
    try {
      const payload = Object.assign({}, job, {
        refresh: job.refresh ? '1' : '0',
        fromCache: job.fromCache ? '1' : '0',
        result: job.result ? JSON.stringify(job.result) : '',
        error: job.error ? JSON.stringify(job.error) : '',
      });
      await redis.hset(JOB_PREFIX + job.id, payload);
      await redis.expire(JOB_PREFIX + job.id, Math.ceil(config.JOB_TTL_MS / 1000) + 120);
    } catch (err) {
      console.warn('[lookup-queue] redis persist failed:', err.message);
    }
  }

  async syncQueueToRedis() {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.del(QUEUE_KEY);
      if (this.queue.length) await redis.rpush(QUEUE_KEY, ...this.queue);
    } catch (err) {
      console.warn('[lookup-queue] redis sync queue failed:', err.message);
    }
  }

  pumpWorkers() {
    while (this.activeWorkers < config.WORKER_COUNT && this.queue.length > 0) {
      const jobId = this.queue[0];
      if (!jobId) break;
      this.activeWorkers += 1;
      this.runWorker(jobId).finally(() => {
        this.activeWorkers -= 1;
        this.pumpWorkers();
      });
    }
  }

  async runWorker(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'queued') return;

    const qIdx = this.queue.indexOf(jobId);
    if (qIdx >= 0) this.queue.splice(qIdx, 1);
    job.status = 'processing';
    job.message = 'Processing your link…';
    this.updatePositions();
    await this.persistJob(job);

    try {
      await this.executeLookup(job);
    } catch (err) {
      job.status = 'failed';
      job.error = { message: err.message || 'Lookup failed' };
      this.urlJobs.delete(job.videoUrl);
      await this.persistJob(job);
    }
  }

  async executeLookup(job) {
    const { proxyDownload } = require('./api-proxy');
    let lastPayload = null;

    for (let attempt = 0; attempt < config.WORKER_RETRIES; attempt += 1) {
      job.retries = attempt + 1;
      job.message = attempt > 0 ? ('Retrying… attempt ' + (attempt + 1)) : 'Fetching video info…';
      await this.persistJob(job);

      try {
        const { status, data, rateLimit } = await proxyDownload(job.videoUrl);
        lastPayload = { status, data, rateLimit };

        if (isSuccessfulApiPayload(status, data)) {
          await setCachedLink(job.videoUrl, status, data);
          job.status = 'done';
          job.result = { status: status, data: data, rateLimit: rateLimit };
          job.message = 'Ready!';
          this.urlJobs.delete(job.videoUrl);
          await this.persistJob(job);
          return;
        }

        if (isQuotaExceeded(status, data) && !job.refresh) {
          const cached = await getCachedLink(job.videoUrl);
          if (cached) {
            job.status = 'done';
            job.fromCache = true;
            job.result = { status: cached.status, data: cached.data, fromCache: true };
            job.message = 'Ready from cache!';
            this.urlJobs.delete(job.videoUrl);
            await this.persistJob(job);
            return;
          }
        }
      } catch (err) {
        lastPayload = { status: 502, data: { error: err.message } };
      }

      if (attempt < config.WORKER_RETRIES - 1) {
        await sleep(1200 * (attempt + 1));
      }
    }

    job.status = 'failed';
    job.error = lastPayload && lastPayload.data
      ? lastPayload.data
      : { message: 'Lookup failed after retries' };
    this.urlJobs.delete(job.videoUrl);
    await this.persistJob(job);
  }

  async tryFastComplete(jobId, maxWaitMs) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const job = this.jobs.get(jobId);
      if (!job) break;
      if (job.status === 'done' && job.result) {
        return {
          immediate: true,
          status: job.result.status || 200,
          data: job.result.data,
          fromCache: Boolean(job.fromCache),
        };
      }
      if (job.status === 'failed') {
        return {
          immediate: true,
          status: job.result && job.result.status ? job.result.status : 502,
          data: job.error || { error: 'Lookup failed' },
        };
      }
      await sleep(150);
    }
    return null;
  }

  cleanupStaleJobs() {
    const now = Date.now();
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status !== 'queued') continue;
      if (now - job.lastPollAt > config.JOB_TTL_MS) {
        const idx = this.queue.indexOf(jobId);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.jobs.delete(jobId);
        this.urlJobs.delete(job.videoUrl);
      }
    }
    this.updatePositions();
  }

  getStats() {
    return {
      queue_length: this.queue.length,
      active_workers: this.activeWorkers,
      max_workers: config.WORKER_COUNT,
      max_queue: config.MAX_QUEUE_SIZE,
      jobs_tracked: this.jobs.size,
      distributed_cache: Boolean(getRedis()),
    };
  }
}

let singleton = null;

function getLookupQueue() {
  if (!singleton) singleton = new LookupQueueManager();
  return singleton;
}

module.exports = {
  LookupQueueManager,
  getLookupQueue,
  estimateWaitSec,
};
