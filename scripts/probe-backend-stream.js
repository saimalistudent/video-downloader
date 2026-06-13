'use strict';

const BASE = 'https://spontaneous-salamander-418289.netlify.app';
const TOKEN = process.env.OMNI_API_TOKEN || process.argv[3] || '';
const VIDEO_URL = 'https://www.tiktok.com/@yeuphimzz/video/7237370304337628442';

async function req(path, init) {
  const headers = Object.assign({
    Authorization: `Bearer ${TOKEN}`,
    'X-Omni-Token': TOKEN,
  }, init && init.headers);
  const res = await fetch(BASE + path, Object.assign({}, init, { headers }));
  const ct = res.headers.get('content-type') || '';
  const text = ct.includes('json') ? await res.text() : `[binary ${res.headers.get('content-length') || '?'} bytes]`;
  console.log(path, res.status, text.slice(0, 300));
  return { res, text, ct };
}

async function main() {
  const dl = await req('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: VIDEO_URL }),
  });
  const data = JSON.parse(dl.text);
  const media = (data.medias || []).find((m) => m && m.url && m.type === 'video');
  if (!media) {
    console.log('no video media');
    return;
  }
  console.log('media host:', new URL(media.url).hostname);

  const q = `url=${encodeURIComponent(media.url)}&name=test.mp4&token=${encodeURIComponent(TOKEN)}`;
  await req('/api/stream?' + q, { method: 'GET' });
  await req('/api/stream?' + q, { method: 'HEAD' });

  // anchor-style: no auth header, token in query only
  const res2 = await fetch(`${BASE}/api/stream?${q}`);
  console.log('stream query-only', res2.status, (await res2.text()).slice(0, 200));

  // check for alternate endpoints
  for (const path of ['/api/proxy', '/api/file', '/api/download/file', '/.netlify/functions/stream']) {
    try {
      await req(path + '?' + q, { method: 'GET' });
    } catch (e) {
      console.log(path, e.message);
    }
  }
}

main().catch(console.error);
