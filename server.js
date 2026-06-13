/**
 * Omni Downloader — local Node.js server
 * Express + sqlite3 + express-session for admin panel & API
 */
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

require('./lib/load-env').loadEnvFile();

const {
  ensureApiKey,
  getApiKey,
  normalizeVideoUrl,
  upstreamHeaders,
  probeMediaSize,
} = require('./lib/api-proxy');
const { isVideoPageUrl, downloadYtdlpToFile } = require('./lib/ytdlp-runner');
const { withDownloadSlot, getQueueStats } = require('./lib/download-queue');
const { resolveDownloadWithCache, clientIpFromRequest } = require('./lib/link-cache');
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
    download_queue: getQueueStats(),
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

    const refresh = Boolean(
      (req.body && req.body.refresh) ||
      String(req.headers['x-omni-refresh'] || '').trim() === '1'
    );
    const clientIp = clientIpFromRequest(req);

    const started = Date.now();
    const result = await resolveDownloadWithCache(videoUrl, { refresh, clientIp });
    const durationMs = result.durationMs != null ? result.durationMs : (Date.now() - started);

    if (!result.fromCache) {
      await trackApiCall({
        platform: 'api',
        success: result.status >= 200 && result.status < 400 && result.data && !result.data.error,
        status: result.status,
        duration_ms: durationMs,
        rateLimit: result.rateLimit,
        message: result.status >= 400 ? 'RapidAPI error ' + result.status : 'RapidAPI metadata fetch',
      }).catch(function () {});
    }

    if (result.fromCache) {
      res.setHeader('X-Omni-Cache', 'HIT');
    } else if (refresh) {
      res.setHeader('X-Omni-Cache', 'REFRESH');
    } else {
      res.setHeader('X-Omni-Cache', 'MISS');
    }

    const data = result.data;
    if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
      return res.status(result.status || 502).json({
        error: 'Empty RapidAPI result',
        message: 'RapidAPI returned no usable data for this URL.',
      });
    }

    res.status(result.status).json(data);
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

app.get('/api/stream', async function (req, res) {
  try {
    let mediaUrl = normalizeVideoUrl(String(req.query.url || '').trim());
    const pageUrl = normalizeVideoUrl(String(req.query.page_url || '').trim());
    const filename = String(req.query.name || 'video.mp4').trim() || 'video.mp4';
    const expectedSize = parseInt(String(req.query.size || '0'), 10) || 0;
    const isAudio = String(req.query.audio || '') === '1';

    if (!mediaUrl) return res.status(400).json({ error: 'Missing url parameter' });

    const ytdlpSource = pageUrl || (isVideoPageUrl(mediaUrl) ? mediaUrl : '');
    if (ytdlpSource) {
      const safeName = filename.replace(/"/g, '');
      const contentType = isAudio ? 'audio/mpeg' : 'video/mp4';
      let filePath;
      let tmpDir;
      try {
        const result = await withDownloadSlot(function () {
          return downloadYtdlpToFile(ytdlpSource, { audio: isAudio });
        });
        filePath = result.filePath;
        tmpDir = result.tmpDir;
      } catch (queueErr) {
        const status = queueErr.status || 502;
        if (status === 503) {
          res.setHeader('Retry-After', String(queueErr.retryAfter || 15));
        }
        return res.status(status).json({
          error: queueErr.message || 'Download queue error',
          message: queueErr.message || 'Server busy — try again shortly.',
        });
      }
      try {
        const stat = fs.statSync(filePath);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Length', String(stat.size));
        await pipeline(fs.createReadStream(filePath), res);
      } finally {
        try {
          fs.unlinkSync(filePath);
          fs.rmdirSync(tmpDir);
        } catch (cleanupErr) { /* ignore */ }
      }
      return;
    }

    const headers = upstreamHeaders(mediaUrl);
    let upstream = await fetch(mediaUrl, { headers: headers });
    if (!upstream.ok && (upstream.status === 403 || upstream.status === 401)) {
      upstream = await fetch(mediaUrl, {
        headers: Object.assign({}, headers, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'video/mp4,video/*,*/*;q=0.8',
        }),
      });
    }
    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 401) {
        return res.status(403).json({
          error: 'CDN blocked relay',
          message: 'Download link expired or blocked by the platform CDN. Click Download again to refresh the link.',
        });
      }
      return res.status(upstream.status).json({ error: 'Upstream HTTP ' + upstream.status });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const safeName = filename.replace(/"/g, '');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    } else if (expectedSize > 0) {
      res.setHeader('Content-Length', String(expectedSize));
    }

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      await pipeline(nodeStream, res);
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Stream error: ' + err.message });
    }
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
