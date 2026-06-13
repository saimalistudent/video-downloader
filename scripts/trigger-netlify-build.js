'use strict';

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
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

const token = process.env.NETLIFY_ACCESS_TOKEN;
const siteId = process.argv[2] || process.env.NETLIFY_SITE_ID;

if (!token) {
  console.error('Missing NETLIFY_ACCESS_TOKEN in .env');
  process.exit(1);
}

if (!siteId) {
  console.error('Usage: node trigger-netlify-build.js <site-id>');
  process.exit(1);
}

async function main() {
  const response = await fetch('https://api.netlify.com/api/v1/sites/' + siteId + '/builds', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clear_cache: 'clear' }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Deploy trigger failed:', data.message || response.status);
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    site_id: siteId,
    deploy_id: data.id,
    state: data.state,
    url: data.ssl_url || data.deploy_ssl_url || data.url || null,
  }, null, 2));
}

main().catch(function (err) {
  console.error(err.message || err);
  process.exit(1);
});
