'use strict';

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.YT_DLP_CONCURRENCY || '4', 10));
const MAX_WAITING = Math.max(0, parseInt(process.env.YT_DLP_QUEUE_SIZE || '32', 10));
const QUEUE_TIMEOUT_MS = Math.max(30000, parseInt(process.env.YT_DLP_QUEUE_TIMEOUT_MS || '120000', 10));

let running = 0;
const waiters = [];

function dequeue() {
  if (running >= MAX_CONCURRENT || !waiters.length) return;
  const next = waiters.shift();
  clearTimeout(next.timer);
  running += 1;
  next.execute();
}

function withDownloadSlot(fn) {
  return new Promise((resolve, reject) => {
    const execute = () => {
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          dequeue();
        });
    };

    if (running < MAX_CONCURRENT) {
      execute();
      return;
    }

    if (waiters.length >= MAX_WAITING) {
      const err = new Error('Server is busy — many people are downloading right now. Please try again in a moment.');
      err.status = 503;
      err.retryAfter = 15;
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

function getQueueStats() {
  return {
    running: running,
    waiting: waiters.length,
    maxConcurrent: MAX_CONCURRENT,
    maxWaiting: MAX_WAITING,
  };
}

module.exports = {
  withDownloadSlot,
  getQueueStats,
};
