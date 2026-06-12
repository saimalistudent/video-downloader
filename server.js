/**
 * Omni Downloader — local Node.js server
 * Express + sqlite3 + express-session for admin panel & API
 */
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

require('./lib/load-env').loadEnvFile();

const {
  ensureApiKey,
  getApiKey,
  normalizeVideoUrl,
  proxyDownload,
  preferDirectStream,
  PROXY_MAX_BYTES,
  upstreamHeaders,
  probeMediaSize,
} = require('./lib/api-proxy');
const { verifyLogin, authFromEvent } = require('./lib/admin-auth');
const { getDashboardStats, updatePlanLimit } = require('./lib/admin-db');
const {
  trackPageView,
  trackDownloadStart,
  trackDownloadSuccess,
  trackDownloadFail,
  trackFetchStart,
  trackFetchSuccess,
  trackFetchFail,
  trackClientError,
  trackApiCall,
} = require('./lib/admin-track');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: DATA_DIR,
    table: 'sessions',
  }),
  name: 'omni_admin_sid',
  secret: process.env.SESSION_SECRET || process.env.ADMIN_JWT_SECRET || process.env.ADMIN_PASSWORD || 'omni-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
  },
}));

function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

app.use('/api', cors);

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminUser) return next();

  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const fakeEvent = {
    headers: { authorization: bearer ? 'Bearer ' + bearer : '' },
    queryStringParameters: req.query,
  };
  const auth = authFromEvent(fakeEvent);
  if (auth.ok) {
    req.adminUser = auth.user;
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized — please login again.' });
}

app.get('/api/health', function (req, res) {
  res.json({
    ok: true,
    service: 'omni-downloader',
    rapidapi_configured: Boolean(getApiKey()),
    admin_configured: Boolean(process.env.ADMIN_PASSWORD),
    storage: 'sqlite3',
  });
});

app.post('/api/admin/login', function (req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const result = verifyLogin(username, password);

  if (!result.ok) {
    return res.status(401).json({ error: result.error || 'Login failed' });
  }

  req.session.adminUser = result.username;
  req.session.save(function (err) {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.json({
      ok: true,
      token: result.token,
      username: result.username,
      session: true,
      expires_in: 86400,
    });
  });
});

app.post('/api/admin/logout', function (req, res) {
  req.session.destroy(function () {
    res.json({ ok: true });
  });
});

app.get('/api/admin/dashboard', requireAdmin, async function (req, res) {
  try {
    const stats = await getDashboardStats();
    res.json(Object.assign({ ok: true }, stats));
  } catch (err) {
    console.error('[admin/dashboard]', err);
    res.status(500).json({ error: err.message || 'Dashboard error' });
  }
});

app.post('/api/admin/dashboard', requireAdmin, async function (req, res) {
  try {
    if (req.body.action === 'update_plan_limit') {
      const plan = await updatePlanLimit(String(req.body.plan_id || ''), req.body.limit_value);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      return res.json({ ok: true, plan: plan });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const COLLECT_HANDLERS = {
  page_view: trackPageView,
  download_start: trackDownloadStart,
  download_success: trackDownloadSuccess,
  download_fail: trackDownloadFail,
  fetch_start: trackFetchStart,
  fetch_success: trackFetchSuccess,
  fetch_fail: trackFetchFail,
  client_error: trackClientError,
};

app.post('/api/admin/collect', async function (req, res) {
  try {
    const eventType = String(req.body.event_type || req.body.type || '').trim();
    const handler = COLLECT_HANDLERS[eventType];
    if (!handler) return res.status(400).json({ error: 'Invalid event_type' });
    await handler(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, note: 'Event skipped' });
  }
});

async function handleDownload(req, res) {
  try {
    const videoUrl = normalizeVideoUrl(String((req.body && req.body.url) || req.query.url || '').trim());
    if (!videoUrl) {
      return res.status(400).json({ error: 'Missing url parameter', message: 'Send JSON { "url": "https://..." }' });
    }

    const keyCheck = ensureApiKey();
    if (!keyCheck.ok) return res.status(500).json(keyCheck.error);

    const started = Date.now();
    const { status, data } = await proxyDownload(videoUrl);
    const durationMs = Date.now() - started;

    await trackApiCall({
      platform: 'api',
      success: status >= 200 && status < 400 && data && !data.error,
      status: status,
      duration_ms: durationMs,
      message: status >= 400 ? 'RapidAPI error ' + status : 'RapidAPI metadata fetch',
    }).catch(function () {});

    if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
      return res.status(status || 502).json({
        error: 'Empty RapidAPI result',
        message: 'RapidAPI returned no usable data for this URL.',
      });
    }

    res.status(status).json(data);
  } catch (err) {
    console.error('[download]', err);
    await trackApiCall({ platform: 'api', success: false, status: 502, message: err.message }).catch(function () {});
    res.status(502).json({ error: 'Download proxy failed', message: err.message });
  }
}

app.post('/api/download', handleDownload);
app.get('/api/download', handleDownload);

app.get('/api/size', async function (req, res) {
  try {
    const mediaUrl = normalizeVideoUrl(String(req.query.url || '').trim());
    if (!mediaUrl) return res.status(400).json({ error: 'Missing url parameter' });
    const bytes = await probeMediaSize(mediaUrl);
    res.json({ ok: true, bytes: bytes });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Size probe failed', bytes: 0 });
  }
});

async function probeContentLength(mediaUrl) {
  return probeMediaSize(mediaUrl);
}

app.get('/api/stream', async function (req, res) {
  try {
    let mediaUrl = normalizeVideoUrl(String(req.query.url || '').trim());
    const filename = String(req.query.name || 'video.mp4').trim() || 'video.mp4';

    if (!mediaUrl) return res.status(400).json({ error: 'Missing url parameter' });

    if (preferDirectStream(mediaUrl)) {
      return res.json({
        use_direct: true,
        direct_url: mediaUrl,
        message: 'Opening direct download…',
      });
    }

    const knownLength = await probeContentLength(mediaUrl);
    if (knownLength > PROXY_MAX_BYTES) {
      return res.json({ use_direct: true, direct_url: mediaUrl, message: 'Large file — direct download' });
    }

    const upstream = await fetch(mediaUrl, { headers: upstreamHeaders(mediaUrl) });
    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 401) {
        return res.status(403).json({
          error: 'Download not allowed',
          message: 'The admin / creator has not allowed downloading this video.',
        });
      }
      return res.status(upstream.status).json({ error: 'Upstream HTTP ' + upstream.status });
    }

    const cl = upstream.headers.get('content-length');
    if (cl && parseInt(cl, 10) > PROXY_MAX_BYTES) {
      return res.json({ use_direct: true, direct_url: mediaUrl });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > PROXY_MAX_BYTES) {
      return res.json({ use_direct: true, direct_url: mediaUrl });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const safeName = filename.replace(/"/g, '');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Stream error: ' + err.message });
  }
});

app.use(express.static(ROOT, { index: 'index.html' }));

app.get('/admin', function (req, res) {
  res.sendFile(path.join(ROOT, 'admin', 'index.html'));
});

app.listen(PORT, function () {
  console.log('');
  console.log('  Omni Downloader — Node.js server running');
  console.log('  Website:  http://127.0.0.1:' + PORT);
  console.log('  Admin:    http://127.0.0.1:' + PORT + '/admin/');
  console.log('  User:     ' + (process.env.ADMIN_USERNAME || 'admin'));
  console.log('  Storage:  SQLite → data/admin.db');
  console.log('');
});
