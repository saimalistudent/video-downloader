const { cors, getApiKey, sendJson } = require('../lib/api-proxy');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const apiKey = getApiKey();

  return sendJson(res, 200, {
    ok: true,
    proxy: true,
    locked: true,
    mode: 'social-download-all-in-one',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube'],
    api_configured: Boolean(apiKey),
    key_length: apiKey ? apiKey.length : 0,
  });
};
