const { trackEvent, incrementPlanUsage } = require('./admin-db');

async function trackPageView(payload) {
  return trackEvent({
    event_type: 'page_view',
    platform: payload.platform || 'all',
    message: 'Page visit',
    session_id: payload.session_id,
    meta: { tab: payload.tab || '', path: payload.path || '' },
  });
}

async function trackDownloadStart(payload) {
  return trackEvent({
    event_type: 'download_start',
    platform: payload.platform || '',
    message: payload.message || 'Download started',
    session_id: payload.session_id,
    meta: { tier: payload.tier || '', type: payload.type || 'video' },
  });
}

async function trackDownloadSuccess(payload) {
  await trackEvent({
    event_type: 'download_success',
    platform: payload.platform || '',
    message: payload.message || 'Download completed',
    session_id: payload.session_id,
    success: true,
    meta: { tier: payload.tier || '', type: payload.type || 'video' },
  });
}

async function trackDownloadFail(payload) {
  await trackEvent({
    event_type: 'download_fail',
    platform: payload.platform || '',
    message: payload.message || 'Download failed',
    session_id: payload.session_id,
    success: false,
    meta: payload.meta || {},
  });
}

async function trackFetchStart(payload) {
  return trackEvent({
    event_type: 'fetch_start',
    platform: payload.platform || '',
    message: payload.message || 'User clicked Download — fetching video',
    session_id: payload.session_id,
    meta: payload.meta || {},
  });
}

async function trackFetchSuccess(payload) {
  return trackEvent({
    event_type: 'fetch_success',
    platform: payload.platform || '',
    message: payload.message || 'Video metadata fetched — ready to save',
    session_id: payload.session_id,
    success: true,
    meta: payload.meta || {},
  });
}

async function trackFetchFail(payload) {
  await trackEvent({
    event_type: 'fetch_fail',
    platform: payload.platform || '',
    message: payload.message || 'Video fetch failed',
    session_id: payload.session_id,
    success: false,
    meta: payload.meta || {},
  });
}

async function trackClientError(payload) {
  await trackEvent({
    event_type: 'client_error',
    platform: payload.platform || '',
    message: payload.message || 'Client error',
    session_id: payload.session_id,
    success: false,
    meta: payload.meta || {},
  });
}

async function trackApiCall(payload) {
  try {
    await incrementPlanUsage('download-api', 1);
  } catch (err) {
    console.warn('[admin-track] plan usage skipped:', err.message);
  }
  return trackEvent({
    event_type: payload.success === false ? 'api_fail' : 'api_call',
    platform: payload.platform || '',
    message: payload.message || 'Download API call',
    success: payload.success !== false,
    meta: {
      status: payload.status || 0,
      duration_ms: payload.duration_ms || 0,
    },
  });
}

module.exports = {
  trackPageView,
  trackDownloadStart,
  trackDownloadSuccess,
  trackDownloadFail,
  trackFetchStart,
  trackFetchSuccess,
  trackFetchFail,
  trackClientError,
  trackApiCall,
};
