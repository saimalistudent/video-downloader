/**
 * Wrap Vercel-style (req, res) handlers for Netlify Functions.
 */
function createNetlifyHandler(vercelHandler) {
  return async function netlifyHandler(event) {
    const req = {
      method: event.httpMethod,
      url: event.rawUrl || event.path + (event.rawQuery ? `?${event.rawQuery}` : ''),
      headers: event.headers || {},
      body: event.body,
    };

    let statusCode = 200;
    let headers = {};
    let body = '';
    let isBase64Encoded = false;

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      setHeader(key, value) {
        headers[key] = value;
        return this;
      },
      json(data) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        body = JSON.stringify(data);
        return this;
      },
      end(data) {
        if (Buffer.isBuffer(data)) {
          body = data.toString('base64');
          isBase64Encoded = true;
        } else if (data !== undefined && data !== null) {
          body = String(data);
        }
        return this;
      },
    };

    await vercelHandler(req, res);

    return {
      statusCode,
      headers,
      body,
      isBase64Encoded,
    };
  };
}

module.exports = { createNetlifyHandler };
