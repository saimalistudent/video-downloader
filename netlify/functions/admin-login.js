const { verifyLogin } = require('./lib/admin-auth');
const { jsonResponse, emptyResponse, parseJsonBody } = require('./lib/http');

exports.handler = async (event) => {
  const method = String(event.httpMethod || 'POST').toUpperCase();

  if (method === 'OPTIONS') return emptyResponse(204);
  if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const body = parseJsonBody(event);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    const result = verifyLogin(username, password);
    if (!result.ok) {
      return jsonResponse(401, { error: result.error || 'Login failed' });
    }

    return jsonResponse(200, {
      ok: true,
      token: result.token,
      username: result.username,
      expires_in: 86400,
    });
  } catch (err) {
    return jsonResponse(500, { error: err.message || 'Login error' });
  }
};
