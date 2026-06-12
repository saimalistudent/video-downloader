const { authFromEvent } = require('./lib/admin-auth');
const { getDashboardStats, updatePlanLimit } = require('./lib/admin-db');
const { jsonResponse, emptyResponse, parseJsonBody } = require('./lib/http');

exports.handler = async (event) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();

  if (method === 'OPTIONS') return emptyResponse(204);

  const auth = authFromEvent(event);
  if (!auth.ok) return jsonResponse(401, { error: auth.error || 'Unauthorized' });

  try {
    if (method === 'GET') {
      const stats = await getDashboardStats();
      return jsonResponse(200, Object.assign({ ok: true }, stats));
    }

    if (method === 'POST') {
      const body = parseJsonBody(event);
      if (body.action === 'update_plan_limit') {
        const plan = await updatePlanLimit(String(body.plan_id || ''), body.limit_value);
        if (!plan) return jsonResponse(404, { error: 'Plan not found' });
        return jsonResponse(200, { ok: true, plan });
      }
      return jsonResponse(400, { error: 'Unknown action' });
    }

    return jsonResponse(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin-api]', err);
    return jsonResponse(500, { error: err.message || 'Dashboard error' });
  }
};
