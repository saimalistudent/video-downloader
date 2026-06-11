const { handleOptions, sendJson } = require('../lib/api-proxy');
const { getDownloadCount } = require('../lib/stats-store');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return handleOptions(req, res);
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const stats = await getDownloadCount();
    return sendJson(res, 200, stats);
  } catch (err) {
    console.error('[stats] unhandled error:', err);
    return sendJson(res, 200, {
      total: 0,
      verified: true,
      persistent: false,
      live: false,
      storage: 'none',
      warning: 'Stats temporarily unavailable',
      message: err.message || String(err),
    });
  }
};
