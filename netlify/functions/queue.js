const { getLookupQueue } = require('./lib/lookup-queue');
const throughputConfig = require('./lib/throughput-config');
const { jsonResponse, emptyResponse, queryParam } = require('./lib/http');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const jobId = queryParam(event, 'job_id').trim();
  if (jobId) {
    try {
      const status = await getLookupQueue().getStatus(jobId);
      if (status.status === 'not_found') {
        return jsonResponse(404, status);
      }
      return jsonResponse(200, status);
    } catch (err) {
      return jsonResponse(502, { error: err.message || 'Queue status failed' });
    }
  }

  return jsonResponse(200, {
    ok: true,
    stats: getLookupQueue().getStats(),
    config: {
      workers: throughputConfig.WORKER_COUNT,
      max_queue: throughputConfig.MAX_QUEUE_SIZE,
      cache_ttl_sec: throughputConfig.CACHE_TTL_SEC,
      poll_interval_ms: throughputConfig.POLL_INTERVAL_MS,
    },
  });
};
