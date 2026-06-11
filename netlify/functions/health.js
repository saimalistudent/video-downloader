const { getApiKey, slotStats } = require('./lib/api-proxy');
const { jsonResponse, emptyResponse } = require('./lib/http');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const apiKey = getApiKey();

  return jsonResponse(200, {
    ok: true,
    proxy: true,
    platform: 'netlify',
    mode: 'social-download-all-in-one',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube'],
    api_configured: Boolean(apiKey),
    key_length: apiKey ? apiKey.length : 0,
    queue: slotStats(),
  });
};
