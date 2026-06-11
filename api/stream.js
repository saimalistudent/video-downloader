const {
  cors,
  extractQueryValue,
  normalizeVideoUrl,
  refererForUrl,
  sendJson,
} = require('../lib/api-proxy');
const { incrementDownloadCount } = require('../lib/stats-store');

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

    const upstream = await fetch(mediaUrl, {
      headers: {
        Referer: refererForUrl(mediaUrl),
        Accept: '*/*',
        'User-Agent': 'OmniDownloader/1.0',
      },
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

    const MAX_PROXY_BYTES = 4 * 1024 * 1024;
    const contentLengthHeader = upstream.headers.get('content-length');
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > MAX_PROXY_BYTES) {
      return sendJson(res, 413, {
        error: 'Video too large for server proxy',
        message: 'Opening direct download…',
        direct_url: mediaUrl,
        use_direct: true,
      });
    }

    await incrementDownloadCount();

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const buffer = Buffer.from(await upstream.arrayBuffer());

    if (buffer.length > MAX_PROXY_BYTES) {
      return sendJson(res, 413, {
        error: 'Video too large for server proxy',
        message: 'Opening direct download…',
        direct_url: mediaUrl,
        use_direct: true,
      });
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
