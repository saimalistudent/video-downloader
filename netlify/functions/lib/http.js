function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...(extra || {}),
  };
}

function jsonResponse(statusCode, data) {
  let body;
  try {
    body = typeof data === 'string' ? data : JSON.stringify(data != null ? data : { error: 'Empty payload' });
  } catch (err) {
    body = JSON.stringify({ error: 'Response serialization failed', message: err.message });
  }

  return {
    statusCode,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    body,
  };
}

function emptyResponse(statusCode) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: '',
  };
}

function parseJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err.message}`);
  }
}

function queryParam(event, key) {
  const params = event.queryStringParameters || {};
  return params[key] ? String(params[key]) : '';
}

module.exports = {
  corsHeaders,
  jsonResponse,
  emptyResponse,
  parseJsonBody,
  queryParam,
};
