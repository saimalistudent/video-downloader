const { cors, sendJson, slotStats } = require('../lib/api-proxy');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return sendJson(res, 200, slotStats());
};
