const {
  normalizeVideoUrl,
  upstreamHeaders,
} = require('./lib/api-proxy');
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
    const expectedSize = parseInt(queryParam(event, 'size') || '0', 10) || 0;
    mediaUrl = normalizeVideoUrl(mediaUrl);

    if (!mediaUrl) {
      return jsonResponse(400, { error: 'Missing url parameter' });
    }

    const upstream = await fetch(mediaUrl, {
      headers: upstreamHeaders(mediaUrl),
    });

    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 401) {
        return jsonResponse(403, {
          error: 'Download not allowed',
          message: 'The admin / creator has not allowed downloading this video.',
        });
      }
      return jsonResponse(upstream.status, { error: 'Upstream HTTP ' + upstream.status });
    }

    try {
      await incrementDownloadCount();
    } catch (err) {
      console.error('[stream] stats increment skipped:', err.message);
    }

    const safeName = filename.replace(/"/g, '');
    const headers = corsHeaders({
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + safeName + '"',
    });
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    } else if (expectedSize > 0) {
      headers['Content-Length'] = String(expectedSize);
    }

    if (typeof Response !== 'undefined' && upstream.body) {
      return new Response(upstream.body, { status: 200, headers: headers });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return {
      statusCode: 200,
      headers: headers,
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return jsonResponse(502, { error: 'Stream error: ' + err.message });
  }
};
