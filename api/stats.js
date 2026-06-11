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
    return sendJson(res, 500, { error: `Stats error: ${err.message}` });
  }
};
