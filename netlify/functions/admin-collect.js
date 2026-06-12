const {
  trackPageView,
  trackDownloadStart,
  trackDownloadSuccess,
  trackDownloadFail,
  trackFetchStart,
  trackFetchSuccess,
  trackFetchFail,
  trackClientError,
} = require('./lib/admin-track');
const { jsonResponse, emptyResponse, parseJsonBody } = require('./lib/http');

const ALLOWED = {
  page_view: trackPageView,
  download_start: trackDownloadStart,
  download_success: trackDownloadSuccess,
  download_fail: trackDownloadFail,
  fetch_start: trackFetchStart,
  fetch_success: trackFetchSuccess,
  fetch_fail: trackFetchFail,
  client_error: trackClientError,
};

exports.handler = async (event) => {
  const method = String(event.httpMethod || 'POST').toUpperCase();

  if (method === 'OPTIONS') return emptyResponse(204);
  if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const body = parseJsonBody(event);
    const eventType = String(body.event_type || body.type || '').trim();

    if (!ALLOWED[eventType]) {
      return jsonResponse(400, { error: 'Invalid event_type' });
    }

    await ALLOWED[eventType]({
      platform: body.platform,
      message: body.message,
      session_id: body.session_id,
      tier: body.tier,
      type: body.type,
      tab: body.tab,
      path: body.path,
      meta: body.meta,
    });

    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('[admin-collect]', err.message);
    return jsonResponse(200, { ok: false, note: 'Event skipped' });
  }
};
