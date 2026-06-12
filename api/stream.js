const {
  cors,
  extractQueryValue,
  normalizeVideoUrl,
  preferDirectStream,
  PROXY_MAX_BYTES,
  sendJson,
  upstreamHeaders,
} = require('../lib/api-proxy');
const { incrementDownloadCount } = require('../lib/stats-store');

async function probeContentLength(mediaUrl) {
  try {
    const head = await fetch(mediaUrl, { method: 'HEAD', headers: upstreamHeaders(mediaUrl) });
    if (head.ok) {
      const len = parseInt(head.headers.get('content-length') || '0', 10);
      if (len > 0) return len;
    }
  } catch (err) {
    /* HEAD not supported — fall through */
  }
  return 0;
}

function sendDirectJson(res, mediaUrl, message) {
  return sendJson(res, 200, {
    use_direct: true,
    direct_url: mediaUrl,
    message: message || 'Opening direct download…',
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const query = req.url.includes('?') ? req.url.split('?')[1] : '';
    let mediaUrl = extractQueryValue(query, 'url', 'name').trim();
    const filename = extractQueryValue(query, 'name').trim() || 'video.mp4';
    mediaUrl = normalizeVideoUrl(mediaUrl);

    if (!mediaUrl) {
      return sendJson(res, 400, { error: 'Missing url parameter' });
    }

    if (preferDirectStream(mediaUrl)) {
      await incrementDownloadCount();
      return sendDirectJson(
        res,
        mediaUrl,
        'HD video — opening direct download (YouTube/Facebook/large file).'
      );
    }

    const knownLength = await probeContentLength(mediaUrl);
    if (knownLength > PROXY_MAX_BYTES) {
      await incrementDownloadCount();
      return sendDirectJson(res, mediaUrl, 'Large file — opening direct download…');
    }

    const upstream = await fetch(mediaUrl, {
      headers: upstreamHeaders(mediaUrl),
    });

    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 401) {
        return sendJson(res, 403, {
          error: 'Download not allowed',
          message: 'The admin / creator has not allowed downloading this video.',
        });
      }
      return sendJson(res, upstream.status, { error: `Upstream HTTP ${upstream.status}` });
    }

    const contentLengthHeader = upstream.headers.get('content-length');
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > PROXY_MAX_BYTES) {
      return sendDirectJson(res, mediaUrl);
    }

    await incrementDownloadCount();

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const buffer = Buffer.from(await upstream.arrayBuffer());

    if (buffer.length > PROXY_MAX_BYTES) {
      return sendDirectJson(res, mediaUrl);
    }

    cors(res);
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    return res.end(buffer);
  } catch (err) {
    return sendJson(res, 502, { error: `Stream error: ${err.message}` });
  }
};
