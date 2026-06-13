/**
 * Deploy site + serverless functions to Netlify (uses netlify-cli).
 * Loads NETLIFY_ACCESS_TOKEN + NETLIFY_SITE_ID from .env
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env');

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

const TOKEN = process.env.NETLIFY_ACCESS_TOKEN;
const SITE_ID = process.env.NETLIFY_SITE_ID || 'e5996379-7317-4294-8207-43d5948de94e';
const SITE_NAME = (process.env.DOMAIN_NAME || '').replace(/\.netlify\.app$/i, '') || 'omnidownloader';

if (!TOKEN || !SITE_ID) {
  console.error('Missing NETLIFY_ACCESS_TOKEN or NETLIFY_SITE_ID in .env');
  process.exit(1);
}

process.env.NETLIFY_AUTH_TOKEN = TOKEN;

const netlifyBin = path.join(ROOT, 'node_modules', 'netlify-cli', 'bin', 'run.js');
if (!fs.existsSync(netlifyBin)) {
  console.error('netlify-cli not installed. Run: npm install netlify-cli --no-save');
  process.exit(1);
}

console.log('Running netlify-cli deploy (site + functions)...');

const result = spawnSync(
  process.execPath,
  [
    netlifyBin,
    'deploy',
    '--prod',
    '--dir',
    '.',
    '--functions',
    'netlify/functions',
    '--site',
    SITE_ID,
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  }
);

if (result.status !== 0) {
  console.error('Deploy failed with exit code', result.status);
  process.exit(result.status || 1);
}

console.log('Done.');
