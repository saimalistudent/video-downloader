const { slotStats } = require('./lib/api-proxy');
const { jsonResponse, emptyResponse } = require('./lib/http');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  return jsonResponse(200, slotStats());
};
