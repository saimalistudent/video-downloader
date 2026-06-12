const crypto = require('crypto');

function cleanEnv(value) {
  let v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function getAdminCredentials() {
  const username = cleanEnv(process.env.ADMIN_USERNAME || 'admin');
  const password = cleanEnv(process.env.ADMIN_PASSWORD || '');
  const secret = cleanEnv(process.env.ADMIN_JWT_SECRET || process.env.ADMIN_PASSWORD || 'omni-admin-secret');
  return { username, password, secret };
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signToken(payload, secret, ttlMs) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({
    ...payload,
    exp: Date.now() + (ttlMs || 24 * 60 * 60 * 1000),
  }));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }

  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!json.exp || Date.now() > json.exp) return null;
    return json;
  } catch {
    return null;
  }
}

function verifyLogin(username, password) {
  const creds = getAdminCredentials();
  if (!creds.password) {
    return { ok: false, error: 'ADMIN_PASSWORD not configured on server.' };
  }
  if (username !== creds.username || password !== creds.password) {
    return { ok: false, error: 'Invalid username or password.' };
  }
  const token = signToken({ sub: creds.username, role: 'admin' }, creds.secret);
  return { ok: true, token, username: creds.username };
}

function authFromEvent(event) {
  const creds = getAdminCredentials();
  const authHeader = String(
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || ''
  );
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const queryToken = event.queryStringParameters && event.queryStringParameters.token
    ? String(event.queryStringParameters.token)
    : '';
  const token = bearer || queryToken;
  const payload = verifyToken(token, creds.secret);
  if (!payload) return { ok: false, error: 'Unauthorized' };
  return { ok: true, user: payload.sub, token };
}

module.exports = {
  getAdminCredentials,
  verifyLogin,
  authFromEvent,
  signToken,
  verifyToken,
};
