const { normalizeVideoUrl, probeMediaSize } = require('./lib/api-proxy');
const { jsonResponse, emptyResponse, queryParam } = require('./lib/http');

exports.handler = async (event) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();

  if (method === 'OPTIONS') return emptyResponse(204);
  if (method !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const mediaUrl = normalizeVideoUrl(queryParam(event, 'url'));
    if (!mediaUrl) {
      return jsonResponse(400, { error: 'Missing url parameter' });
    }

    const bytes = await probeMediaSize(mediaUrl);
    return jsonResponse(200, { ok: true, bytes: bytes, url: mediaUrl });
  } catch (err) {
    console.error('[size]', err);
    return jsonResponse(502, { error: err.message || 'Size probe failed', bytes: 0 });
  }
};
