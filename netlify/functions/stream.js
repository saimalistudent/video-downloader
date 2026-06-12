const {
  normalizeVideoUrl,
  preferDirectStream,
  PROXY_MAX_BYTES,
  upstreamHeaders,
} = require('./lib/api-proxy');
const { corsHeaders, jsonResponse, emptyResponse, queryParam } = require('./lib/http');
const { incrementDownloadCount } = require('./lib/stats-store');

async function probeContentLength(mediaUrl) {
  try {
    const head = await fetch(mediaUrl, { method: 'HEAD', headers: upstreamHeaders(mediaUrl) });
    if (head.ok) {
      const len = parseInt(head.headers.get('content-length') || '0', 10);
      if (len > 0) return len;
    }
  } catch (err) {
    /* HEAD not supported on some CDNs — fall through to GET */
  }
  return 0;
}

function directDownloadJson(mediaUrl, message) {
  return jsonResponse(200, {
    use_direct: true,
    direct_url: mediaUrl,
    message: message || 'Opening direct download…',
  });
}

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

    if (preferDirectStream(mediaUrl)) {
      try {
        await incrementDownloadCount();
      } catch (err) {
        console.error('[stream] stats increment skipped:', err.message);
      }
      return directDownloadJson(
        mediaUrl,
        'HD video — opening direct download (YouTube/Facebook/large file).'
      );
    }

    const knownLength = await probeContentLength(mediaUrl);
    if (knownLength > PROXY_MAX_BYTES) {
      try {
        await incrementDownloadCount();
      } catch (err) {
        console.error('[stream] stats increment skipped:', err.message);
      }
      return directDownloadJson(mediaUrl, 'Large file — opening direct download…');
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
      return jsonResponse(upstream.status, { error: `Upstream HTTP ${upstream.status}` });
    }

    const contentLengthHeader = upstream.headers.get('content-length');
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > PROXY_MAX_BYTES) {
      return directDownloadJson(mediaUrl);
    }

    try {
      await incrementDownloadCount();
    } catch (err) {
      console.error('[stream] stats increment skipped:', err.message);
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const buffer = Buffer.from(await upstream.arrayBuffer());

    if (buffer.length > PROXY_MAX_BYTES) {
      return directDownloadJson(mediaUrl);
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
