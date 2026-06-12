const {
  ensureApiKey,
  extractQueryValue,
  handleOptions,
  normalizeVideoUrl,
  proxyDownload,
  readRequestBody,
  sendJson,
} = require('../lib/api-proxy');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return handleOptions(req, res);
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    let videoUrl = '';

    if (req.method === 'POST') {
      const payload = await readRequestBody(req);
      videoUrl = String(payload.url || '').trim();
    } else {
      const query = req.url.includes('?') ? req.url.split('?')[1] : '';
      videoUrl = extractQueryValue(query, 'url');
    }

    videoUrl = normalizeVideoUrl(videoUrl);
    if (!videoUrl) {
      return sendJson(res, 400, {
        error: 'Missing url parameter',
        message: 'Missing required parameters',
      });
    }

    const keyCheck = ensureApiKey();
    if (!keyCheck.ok) {
      return sendJson(res, 500, keyCheck.error);
    }

    const { status, data } = await proxyDownload(videoUrl);
    return sendJson(res, status, data);
  } catch (err) {
    if (err.message === 'Invalid JSON body') {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    return sendJson(res, 500, { error: `Proxy error: ${err.message}` });
  }
};
