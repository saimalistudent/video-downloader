const {
  cors,
  extractQueryValue,
  normalizeVideoUrl,
  sendJson,
  upstreamHeaders,
} = require('../lib/api-proxy');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
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
    const expectedSize = parseInt(extractQueryValue(query, 'size').trim() || '0', 10) || 0;
    mediaUrl = normalizeVideoUrl(mediaUrl);

    if (!mediaUrl) {
      return sendJson(res, 400, { error: 'Missing url parameter' });
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
      return sendJson(res, upstream.status, { error: 'Upstream HTTP ' + upstream.status });
    }

    await incrementDownloadCount();

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const safeName = filename.replace(/"/g, '');
    cors(res);
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    } else if (expectedSize > 0) {
      res.setHeader('Content-Length', String(expectedSize));
    }

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.end(buffer);
  } catch (err) {
    if (!res.headersSent) {
      return sendJson(res, 502, { error: 'Stream error: ' + err.message });
    }
  }
};
