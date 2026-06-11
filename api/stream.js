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
      return sendJson(res, upstream.status, { error: `Upstream HTTP ${upstream.status}` });
    }

    await incrementDownloadCount();

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const buffer = Buffer.from(await upstream.arrayBuffer());

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
