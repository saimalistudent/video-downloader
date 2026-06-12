const {
  ensureApiKey,
  getApiKey,
  normalizeVideoUrl,
} = require('./lib/api-proxy');
const { resolveDownloadWithCache, clientIpFromRequest } = require('./lib/link-cache');
const { jsonResponse, emptyResponse, parseJsonBody, queryParam } = require('./lib/http');

exports.handler = async (event, context) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();

  try {
    if (method === 'OPTIONS') {
      return emptyResponse(204);
    }

    if (method !== 'POST' && method !== 'GET') {
      return jsonResponse(405, { error: 'Method not allowed', message: `Unsupported method: ${method}` });
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
      console.error('[download] RAPIDAPI_KEY missing — set in Netlify env vars and redeploy');
      return jsonResponse(500, keyCheck.error);
    }

    const clientIp = clientIpFromRequest(event);
    console.log('[download] fetch', refresh ? 'refresh' : 'lookup', 'key length:', getApiKey().length);

    const result = await resolveDownloadWithCache(videoUrl, { refresh, clientIp });

    if (!result.fromCache) {
      try {
        const { trackApiCall } = require('./lib/admin-track');
        await trackApiCall({
          platform: 'api',
          success: result.status >= 200 && result.status < 400 && result.data && !result.data.error,
          status: result.status,
          duration_ms: result.durationMs || 0,
          rateLimit: result.rateLimit,
          message: result.status >= 400 ? 'RapidAPI error ' + result.status : 'RapidAPI metadata fetch',
        });
      } catch (trackErr) {
        console.warn('[download] admin track skipped:', trackErr.message);
      }
    }

    const cacheHeader = result.fromCache ? 'HIT' : (refresh ? 'REFRESH' : 'MISS');

    if (!result.data || (typeof result.data === 'object' && !Object.keys(result.data).length)) {
      return {
        statusCode: result.status || 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Omni-Cache': cacheHeader,
        },
        body: JSON.stringify({
          error: 'Empty RapidAPI result',
          message: 'RapidAPI returned no usable data for this URL.',
          http_status: result.status,
        }),
      };
    }

    return {
      statusCode: result.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Omni-Cache': cacheHeader,
      },
      body: JSON.stringify(result.data),
    };
  } catch (err) {
    console.error('[download] error:', err);
    try {
      const { trackApiCall } = require('./lib/admin-track');
      await trackApiCall({
        platform: 'api',
        success: false,
        status: 502,
        message: err.message || 'Download proxy failed',
      });
    } catch (trackErr) { /* skip */ }
    return jsonResponse(502, {
      error: 'Download proxy failed',
      message: err.message || String(err),
    });
  }
};
