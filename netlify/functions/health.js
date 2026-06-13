const { hasExternalBackend, getBackendConfig } = require('./lib/api-proxy');
const { getLookupQueue } = require('./lib/lookup-queue');
const throughputConfig = require('./lib/throughput-config');
const { jsonResponse, emptyResponse } = require('./lib/http');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const backend = getBackendConfig();

  return jsonResponse(200, {
    ok: true,
    proxy: true,
    platform: 'netlify',
    mode: 'omni-ytdlp',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube'],
    api_configured: hasExternalBackend(),
    download_api: hasExternalBackend(),
    backend_url: backend.url || null,
    lookup_queue: getLookupQueue().getStats(),
    throughput: {
      workers: throughputConfig.WORKER_COUNT,
      cache_ttl_sec: throughputConfig.CACHE_TTL_SEC,
      user_rate_per_sec: throughputConfig.USER_RATE_PER_SEC,
      max_queue: throughputConfig.MAX_QUEUE_SIZE,
    },
  });
};
