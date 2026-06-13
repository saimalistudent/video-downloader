const { cors, hasExternalBackend, getBackendConfig, sendJson } = require('../lib/api-proxy');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const backend = getBackendConfig();

  return sendJson(res, 200, {
    ok: true,
    proxy: true,
    locked: true,
    mode: 'omni-ytdlp',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube'],
    api_configured: hasExternalBackend(),
    download_api: hasExternalBackend(),
    backend_url: backend.url || null,
  });
};
