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
      if (upstream.status === 403 || upstream.status === 401) {
        return jsonResponse(403, {
          error: 'Download not allowed',
          message: 'The admin / creator has not allowed downloading this video.',
        });
      }
      return jsonResponse(upstream.status, { error: `Upstream HTTP ${upstream.status}` });
    }

    const MAX_PROXY_BYTES = 4 * 1024 * 1024;
    const contentLengthHeader = upstream.headers.get('content-length');
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > MAX_PROXY_BYTES) {
      return jsonResponse(413, {
        error: 'Video too large for server proxy',
        message: 'Opening direct download…',
        direct_url: mediaUrl,
        use_direct: true,
      });
    }

    try {
      await incrementDownloadCount();
    } catch (err) {
      console.error('[stream] stats increment skipped:', err.message);
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const buffer = Buffer.from(await upstream.arrayBuffer());

    if (buffer.length > MAX_PROXY_BYTES) {
      return jsonResponse(413, {
        error: 'Video too large for server proxy',
        message: 'Opening direct download…',
        direct_url: mediaUrl,
        use_direct: true,
      });
    }
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
