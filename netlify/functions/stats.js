const { getDownloadCount } = require('./lib/stats-store');
const { jsonResponse, emptyResponse } = require('./lib/http');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const stats = await getDownloadCount();
    return jsonResponse(200, stats);
  } catch (err) {
    return jsonResponse(500, { error: `Stats error: ${err.message}` });
  }
};
