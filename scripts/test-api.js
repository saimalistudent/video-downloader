/**
 * Local API test — run: node scripts/test-api.js
 * Loads OMNI_BACKEND_URL / OMNI_API_TOKEN from .env in project root.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

process.env.NETLIFY = 'true';

const { ensureApiKey, hasExternalBackend, getBackendConfig, proxyDownload } = require('../netlify/functions/lib/api-proxy');
const { jsonResponse } = require('../netlify/functions/lib/http');

async function testDownloadHandler() {
  const keyCheck = ensureApiKey();
  if (!keyCheck.ok) {
    return { pass: false, step: 'ensureApiKey', detail: keyCheck.error.message };
  }

  const testUrl = 'https://www.tiktok.com/@tiktok/video/7234567890123456789';
  const { status, data } = await proxyDownload(testUrl);

  if (status === 200 && data && data.error !== true) {
    return { pass: true, step: 'proxyDownload', status, hasMedias: Boolean(data.medias || data.url) };
  }

  return {
    pass: false,
    step: 'proxyDownload',
    status,
    error: data && (data.message || data.error),
    hint: data && data.hint,
  };
}

async function testJsonResponse() {
  const res = jsonResponse(200, { ok: true });
  if (!res.body || typeof res.body !== 'string') {
    return { pass: false, step: 'jsonResponse', detail: 'empty body' };
  }
  return { pass: true, step: 'jsonResponse' };
}

async function main() {
  console.log('Omni Downloader — API test\n');

  const backend = getBackendConfig();
  console.log('Download API configured:', hasExternalBackend());
  console.log('Backend URL:', backend.url || '(missing)');

  const tests = [testJsonResponse, testDownloadHandler];
  let failed = 0;

  for (const test of tests) {
    const result = await test();
    const label = result.pass ? 'PASS' : 'FAIL';
    console.log(`[${label}] ${result.step}`, result.pass ? '' : JSON.stringify(result));
    if (!result.pass) failed += 1;
  }

  console.log(failed ? '\nSome tests failed.' : '\nAll tests passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Test crash:', err);
  process.exit(1);
});
