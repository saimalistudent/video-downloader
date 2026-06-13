const {
  ensureApiKey,
  normalizeVideoUrl,
} = require('./lib/api-proxy');
const { clientIpFromRequest, fetchMetadataDirect } = require('./lib/link-cache');
const throughputConfig = require('./lib/throughput-config');
const { jsonResponse, emptyResponse, parseJsonBody, queryParam } = require('./lib/http');

exports.handler = async (event) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();

  try {
    if (method === 'OPTIONS') {
      return emptyResponse(204);
    }

    if (method !== 'POST' && method !== 'GET') {
      return jsonResponse(405, { error: 'Method not allowed', message: 'Unsupported method: ' + method });
    }

    let videoUrl = '';
    let refresh = false;

    if (method === 'POST') {
      let payload;
      try {
        payload = parseJsonBody(event);
      } catch (err) {
        return jsonResponse(400, { error: 'Invalid JSON body', message: err.message });
      }
      videoUrl = String(payload.url || '').trim();
      refresh = Boolean(payload.refresh);
    } else {
      videoUrl = queryParam(event, 'url');
      refresh = queryParam(event, 'refresh') === '1';
    }

    if (!refresh) {
      const hdr = event.headers || {};
      refresh = String(hdr['x-omni-refresh'] || hdr['X-Omni-Refresh'] || '').trim() === '1';
    }

    videoUrl = normalizeVideoUrl(videoUrl);
    if (!videoUrl) {
      return jsonResponse(400, {
        error: 'Missing url parameter',
        message: 'Send POST JSON { "url": "https://..." } or GET ?url=...',
      });
    }

    const keyCheck = ensureApiKey();
    if (!keyCheck.ok) {
      return jsonResponse(500, keyCheck.error);
    }

    const hdr = event.headers || {};
    const clientIp = clientIpFromRequest(event);
    let priority = parseInt(String(hdr['x-omni-priority'] || hdr['X-Omni-Priority'] || '0'), 10) || 0;
    if (/omni_return=1/i.test(String(hdr.cookie || hdr.Cookie || ''))) {
      priority = Math.max(priority, throughputConfig.PRIORITY.RETURNING);
    }

    const result = await fetchMetadataDirect(videoUrl, { refresh, clientIp, priority });

    if (!result.immediate) {
      return {
        statusCode: 202,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Omni-Queue': 'WAIT',
        },
        body: JSON.stringify({
          queued: true,
          job_id: result.job_id,
          position: result.position,
          estimated_wait_sec: result.estimated_wait_sec,
          message: result.message,
          overflow: result.overflow,
          poll_url: '/api/queue/status?job_id=' + result.job_id,
        }),
      };
    }

    if (!result.fromCache) {
      try {
        const { trackApiCall } = require('./lib/admin-track');
        await trackApiCall({
          platform: 'api',
          success: (result.status || 200) >= 200 && (result.status || 200) < 400 && result.data && !result.data.error,
          status: result.status || 200,
          duration_ms: 0,
          message: (result.status || 200) >= 400 ? 'Download API error' : 'Download API metadata fetch',
        });
      } catch (trackErr) {
        console.warn('[download] admin track skipped:', trackErr.message);
      }
    }

    const cacheHeader = result.fromCache ? 'HIT' : (refresh ? 'REFRESH' : 'MISS');
    const data = result.data;

    if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
      return jsonResponse(result.status || 502, {
        error: 'Empty download API result',
        message: 'Download API returned no usable data for this URL.',
      });
    }

    return {
      statusCode: result.status || 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Omni-Cache': cacheHeader,
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error('[download] error:', err.message);
    return jsonResponse(502, {
      error: 'Download proxy failed',
      message: err.message || String(err),
    });
  }
};
