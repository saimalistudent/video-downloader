'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveYtdlp() {
  const fromEnv = String(process.env.YTDLP_PATH || '').trim();
  if (fromEnv) return { cmd: fromEnv, prefix: [] };

  const lambdaBin = process.env.LAMBDA_TASK_ROOT
    ? path.join(process.env.LAMBDA_TASK_ROOT, 'bin', 'yt-dlp')
    : '';
  if (lambdaBin && fs.existsSync(lambdaBin)) {
    return { cmd: lambdaBin, prefix: [] };
  }

  if (process.platform === 'win32') {
    return { cmd: 'python', prefix: ['-m', 'yt_dlp'] };
  }

  return { cmd: 'yt-dlp', prefix: [] };
}

function isVideoPageUrl(url) {
  return /tiktok\.com|instagram\.com\/(reel|p|tv)|facebook\.com|fb\.watch|youtube\.com|youtu\.be/i.test(String(url || ''));
}

function buildYtdlpArgs(pageUrl, outputTemplate, options) {
  options = options || {};
  const base = resolveYtdlp();
  const args = base.prefix.slice();
  if (options.audio) {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3');
  } else {
    args.push('-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
  }
  args.push(
    '--extractor-retries', '3',
    '--fragment-retries', '3',
    '-o', outputTemplate,
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    pageUrl
  );
  return { cmd: base.cmd, args: args };
}

function runYtdlp(pageUrl, outputTemplate, options) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = buildYtdlpArgs(pageUrl, outputTemplate, options);
    const child = spawn(cmd, args, {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function findDownloadedFile(dir) {
  const files = fs.readdirSync(dir).filter((name) => !name.endsWith('.part'));
  if (!files.length) return null;
  files.sort((a, b) => {
    const sa = fs.statSync(path.join(dir, a)).size;
    const sb = fs.statSync(path.join(dir, b)).size;
    return sb - sa;
  });
  return path.join(dir, files[0]);
}

function cleanupDir(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, name));
    }
    fs.rmdirSync(dir);
  } catch (err) {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadYtdlpToFileOnce(pageUrl, options) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dl-'));
  const outputTemplate = path.join(tmpDir, 'video.%(ext)s');
  try {
    await runYtdlp(pageUrl, outputTemplate, options);
    const filePath = findDownloadedFile(tmpDir);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('yt-dlp produced no output file');
    }
    return { filePath: filePath, tmpDir: tmpDir };
  } catch (err) {
    cleanupDir(tmpDir);
    throw err;
  }
}

async function downloadYtdlpToFile(pageUrl, options) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await downloadYtdlpToFileOnce(pageUrl, options);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(1500 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error('yt-dlp download failed');
}

async function streamYtdlpToWritable(pageUrl, writable, options) {
  const { filePath, tmpDir } = await downloadYtdlpToFile(pageUrl, options);
  try {
    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(filePath);
      readStream.on('error', reject);
      writable.on('error', reject);
      writable.on('finish', resolve);
      readStream.pipe(writable);
    });
  } finally {
    cleanupDir(tmpDir);
  }
}

module.exports = {
  resolveYtdlp,
  isVideoPageUrl,
  downloadYtdlpToFile,
  streamYtdlpToWritable,
};
