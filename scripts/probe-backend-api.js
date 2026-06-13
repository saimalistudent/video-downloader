'use strict';

const BASE = 'https://spontaneous-salamander-418289.netlify.app';
const TOKEN = 'e2675cdba8f91034';
const VIDEO = 'https://www.tiktok.com/@yeuphimzz/video/7237370304337628442';

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Omni-Token': TOKEN,
  'Content-Type': 'application/json',
};

async function tryReq(label, url, init) {
  try {
    const res = await fetch(url, init);
    const ct = res.headers.get('content-type') || '';
    let body;
    if (/json/i.test(ct)) body = (await res.text()).slice(0, 400);
    else body = `content-type=${ct} len=${res.headers.get('content-length') || 'chunked'}`;
    console.log(label, res.status, body);
    return res;
  } catch (e) {
    console.log(label, 'ERR', e.message);
  }
}

async function main() {
  await tryReq('health', `${BASE}/api/health`);

  const bodies = [
    { url: VIDEO },
    { url: VIDEO, refresh: true },
    { url: VIDEO, direct: true },
    { url: VIDEO, stream: true },
    { url: VIDEO, download: true },
    { url: VIDEO, format: 'mp4' },
    { url: VIDEO, proxy: true },
  ];

  for (const body of bodies) {
    await tryReq('POST ' + JSON.stringify(body), `${BASE}/api/download`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
  }

  const qs = [
    `url=${encodeURIComponent(VIDEO)}&token=${TOKEN}`,
    `url=${encodeURIComponent(VIDEO)}&direct=1&token=${TOKEN}`,
    `url=${encodeURIComponent(VIDEO)}&download=1&token=${TOKEN}`,
  ];
  for (const q of qs) {
    await tryReq('GET download?' + q.split('&')[1], `${BASE}/api/download?${q}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  }

  // stream with source page URL instead of CDN
  await tryReq('stream source url', `${BASE}/api/stream?url=${encodeURIComponent(VIDEO)}&name=v.mp4&token=${TOKEN}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Omni-Token': TOKEN },
  });
}

main();
