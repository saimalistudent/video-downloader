const {
  ensureApiKey,
  getApiKey,
  normalizeVideoUrl,
  proxyDownload,
} = require('./lib/api-proxy');
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

    if (method === 'POST') {
      let payload;
      try {
        payload = parseJsonBody(event);
      } catch (err) {
        return jsonResponse(400, { error: 'Invalid JSON body', message: err.message });
      }
      videoUrl = String(payload.url || '').trim();
    } else {
      videoUrl = queryParam(event, 'url');
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

    console.log('[download] fetching video metadata, key length:', getApiKey().length);
    const started = Date.now();
    const { status, data } = await proxyDownload(videoUrl);
    const durationMs = Date.now() - started;

    try {
      const { trackApiCall } = require('./lib/admin-track');
      await trackApiCall({
        platform: 'api',
        success: status >= 200 && status < 400 && data && !data.error,
        status: status,
        duration_ms: durationMs,
        message: status >= 400 ? 'RapidAPI error ' + status : 'RapidAPI metadata fetch',
      });
    } catch (trackErr) {
      console.warn('[download] admin track skipped:', trackErr.message);
    }

    if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
      return jsonResponse(status || 502, {
        error: 'Empty RapidAPI result',
        message: 'RapidAPI returned no usable data for this URL.',
        http_status: status,
      });
    }

    return jsonResponse(status, data);
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
