const { normalizeVideoUrl, refererForUrl } = require('./lib/api-proxy');
const { corsHeaders, jsonResponse, emptyResponse, queryParam } = require('./lib/http');
const { incrementDownloadCount } = require('./lib/stats-store');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    let mediaUrl = queryParam(event, 'url').trim();
    const filename = queryParam(event, 'name').trim() || 'video.mp4';
    mediaUrl = normalizeVideoUrl(mediaUrl);

    if (!mediaUrl) {
      return jsonResponse(400, { error: 'Missing url parameter' });
    }

    const upstream = await fetch(mediaUrl, {
      headers: {
        Referer: refererForUrl(mediaUrl),
        Accept: '*/*',
        'User-Agent': 'OmniDownloader/1.0',
      },
    });

    if (!upstream.ok) {
      return jsonResponse(upstream.status, { error: `Upstream HTTP ${upstream.status}` });
    }

    await incrementDownloadCount();

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const safeName = filename.replace(/"/g, '');

    const headers = corsHeaders({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${safeName}"`,
    });
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    return {
      statusCode: 200,
      headers,
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return jsonResponse(502, { error: `Stream error: ${err.message}` });
  }
};
