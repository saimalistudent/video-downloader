/**
 * Legacy stub — RapidAPI removed. Kept so admin-db imports do not break.
 */
function parseRateLimitHeaders() {
  return null;
}

function getRapidApiBaseline() {
  return parseFloat(String(process.env.OMNI_DOWNLOAD_API_BASELINE || '0').trim()) || 0;
}

async function fetchRapidApiUsageLive() {
  return null;
}

function mergeRapidUsageCounts(stored, eventTotal, live, baseline) {
  const fromEvents = parseFloat(eventTotal) || 0;
  const base = parseFloat(baseline) || 0;
  const current = parseFloat(stored) || 0;
  if (live && parseFloat(live.used) > 0) {
    return Math.max(current, parseFloat(live.used) || 0, fromEvents + base);
  }
  return Math.max(current, fromEvents + base);
}

module.exports = {
  parseRateLimitHeaders,
  getRapidApiBaseline,
  fetchRapidApiUsageLive,
  mergeRapidUsageCounts,
};
