const { getDownloadCount } = require('./lib/stats-store');
const { jsonResponse, emptyResponse } = require('./lib/http');

exports.handler = async (event) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const stats = await getDownloadCount();
    return jsonResponse(200, stats);
  } catch (err) {
    console.error('[stats] unhandled error:', err);
    return jsonResponse(200, {
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
