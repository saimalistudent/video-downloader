const fs = require('fs');
const {
  normalizeVideoUrl,
  upstreamHeaders,
  fetchExternalStream,
  hasExternalBackend,
} = require('./lib/api-proxy');
const { isVideoPageUrl } = require('./lib/ytdlp-runner');
const { corsHeaders, jsonResponse, emptyResponse, queryParam } = require('./lib/http');
const { incrementDownloadCount } = require('./lib/stats-store');

function isServerlessRuntime() {
  return Boolean(
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY ||
    process.env.VERCEL
  );
}

async function relayCdnStream(mediaUrl, filename, expectedSize) {
  const upstreamReqHeaders = upstreamHeaders(mediaUrl);
  let upstream = await fetch(mediaUrl, { headers: upstreamReqHeaders, redirect: 'follow' });

  if (!upstream.ok && (upstream.status === 403 || upstream.status === 401)) {
    upstream = await fetch(mediaUrl, {
      headers: Object.assign({}, upstreamReqHeaders, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'video/mp4,video/*,*/*;q=0.8',
      }),
      redirect: 'follow',
    });
  }

  if (!upstream.ok) {
    return null;
  }

  const safeName = filename.replace(/"/g, '');
  const responseHeaders = corsHeaders({
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="' + safeName + '"',
  });
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    responseHeaders['Content-Length'] = contentLength;
  } else if (expectedSize > 0) {
    responseHeaders['Content-Length'] = String(expectedSize);
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (!buffer.length) return null;
  return {
    statusCode: 200,
    headers: responseHeaders,
    body: buffer.toString('base64'),
    isBase64Encoded: true,
  };
}

async function relayYtdlpStream(ytdlpSource, filename, isAudio) {
  const safeName = filename.replace(/"/g, '');
  const contentType = isAudio ? 'audio/mpeg' : 'video/mp4';
  const { downloadYtdlpToFile } = require('./lib/ytdlp-runner');
  const { withDownloadSlot } = require('./lib/download-queue');
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
    const headers = corsHeaders({
      'Content-Type': 'application/json',
    });
    if (status === 503) {
      headers['Retry-After'] = String(queueErr.retryAfter || 15);
    }
    return {
      statusCode: status,
      headers: headers,
      body: JSON.stringify({
        error: queueErr.message || 'Download queue error',
        message: queueErr.message || 'Server busy — try again shortly.',
      }),
    };
  }

  try {
    const buffer = fs.readFileSync(filePath);
    if (!buffer.length) {
      return jsonResponse(502, { error: 'Empty file from yt-dlp' });
    }
    return {
      statusCode: 200,
      headers: corsHeaders({
        'Content-Type': contentType,
        'Content-Disposition': 'attachment; filename="' + safeName + '"',
        'Content-Length': String(buffer.length),
      }),
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } finally {
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(tmpDir);
    } catch (cleanupErr) { /* ignore */ }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return emptyResponse(204);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    let mediaUrl = queryParam(event, 'url').trim();
    const pageUrl = queryParam(event, 'page_url').trim();
    const filename = queryParam(event, 'name').trim() || 'video.mp4';
    const expectedSize = parseInt(queryParam(event, 'size') || '0', 10) || 0;
    const isAudio = queryParam(event, 'audio') === '1';
    const forceYtdlp = queryParam(event, 'ytdlp') === '1';
    mediaUrl = normalizeVideoUrl(mediaUrl);

    if (!mediaUrl) {
      return jsonResponse(400, { error: 'Missing url parameter' });
    }

    try {
      await incrementDownloadCount();
    } catch (err) {
      console.error('[stream] stats increment skipped:', err.message);
    }

    const directCdn = mediaUrl && !isVideoPageUrl(mediaUrl);
    const ytdlpSource = normalizeVideoUrl(pageUrl || (isVideoPageUrl(mediaUrl) ? mediaUrl : ''));

    async function relayExternalResponse(extra) {
      if (!hasExternalBackend()) return null;
      try {
        const upstream = await fetchExternalStream(Object.assign({
          url: (extra && extra.ytdlp) ? (pageUrl || mediaUrl) : mediaUrl,
          name: filename,
          size: expectedSize > 0 ? String(expectedSize) : '',
          page_url: pageUrl || '',
          ytdlp: forceYtdlp ? '1' : '',
          audio: isAudio ? '1' : '',
        }, extra || {}));
        if (!upstream || !upstream.ok) return null;
        const ct = upstream.headers.get('content-type') || '';
        if (/application\/json/i.test(ct)) return null;
        const safeName = filename.replace(/"/g, '');
        const responseHeaders = corsHeaders({
          'Content-Type': ct || 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="' + safeName + '"',
        });
        const contentLength = upstream.headers.get('content-length');
        if (contentLength) responseHeaders['Content-Length'] = contentLength;
        else if (expectedSize > 0) responseHeaders['Content-Length'] = String(expectedSize);
        const buffer = Buffer.from(await upstream.arrayBuffer());
        if (!buffer.length) return null;
        return {
          statusCode: 200,
          headers: responseHeaders,
          body: buffer.toString('base64'),
          isBase64Encoded: true,
        };
      } catch (extErr) {
        console.warn('[stream] external relay failed:', extErr.message);
        return null;
      }
    }

    if (!forceYtdlp && directCdn) {
      const cdnResult = await relayCdnStream(mediaUrl, filename, expectedSize);
      if (cdnResult) return cdnResult;
      const extCdn = await relayExternalResponse();
      if (extCdn) return extCdn;
    }

    if (forceYtdlp && ytdlpSource) {
      const extYtdlp = await relayExternalResponse({ ytdlp: '1', audio: isAudio ? '1' : '' });
      if (extYtdlp) return extYtdlp;
      if (!isServerlessRuntime()) {
        try {
          return await relayYtdlpStream(ytdlpSource, filename, isAudio);
        } catch (ytdlpErr) {
          console.warn('[stream] local yt-dlp failed:', ytdlpErr.message);
        }
      }
    }

    if (ytdlpSource) {
      const extYtdlp = await relayExternalResponse({ ytdlp: '1', audio: isAudio ? '1' : '' });
      if (extYtdlp) return extYtdlp;
      if (!isServerlessRuntime()) {
        try {
          return await relayYtdlpStream(ytdlpSource, filename, isAudio);
        } catch (ytdlpErr) {
          console.warn('[stream] yt-dlp fallback failed:', ytdlpErr.message);
        }
      }
    }

    if (directCdn) {
      const cdnResult = await relayCdnStream(mediaUrl, filename, expectedSize);
      if (cdnResult) return cdnResult;
      const extCdn = await relayExternalResponse();
      if (extCdn) return extCdn;
      return jsonResponse(403, {
        error: 'CDN blocked relay',
        message: 'Download link expired or blocked. Click Download again to refresh the link.',
      });
    }

    return jsonResponse(502, {
      error: 'Stream relay failed',
      message: 'Could not download this file — try again or pick another quality.',
    });
  } catch (err) {
    console.error('[stream] error:', err.message);
    return jsonResponse(502, { error: 'Stream error: ' + err.message });
  }
};
