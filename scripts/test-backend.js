'use strict';

const BASE = process.argv[2] || 'https://spontaneous-salamander-418289.netlify.app';
const TOKEN = process.argv[3] || process.env.OMNI_API_TOKEN || '';
const URL = process.argv[4] || 'https://www.tiktok.com/@yeuphimzz/video/7237370304337628442';

async function main() {
  const health = await fetch(`${BASE}/api/health`);
  console.log('health', health.status, await health.text());

  const res = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ url: URL }),
  });
  const text = await res.text();
  console.log('download', res.status, text.slice(0, 600));

  let mediaUrl = '';
  try {
    const data = JSON.parse(text);
    const m = (data.medias || []).find((x) => x && x.url && x.type === 'video');
    mediaUrl = m ? m.url : '';
  } catch (e) {}

  if (mediaUrl) {
    const streamUrl = `${BASE}/api/stream?url=${encodeURIComponent(mediaUrl)}&name=test.mp4&token=${encodeURIComponent(TOKEN)}`;
    const stream = await fetch(streamUrl, { method: 'HEAD', headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log('stream HEAD', stream.status, stream.headers.get('content-type'));
  }

  const size = await fetch(`${BASE}/api/size?url=${encodeURIComponent(URL)}&token=${encodeURIComponent(TOKEN)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  console.log('size', size.status, (await size.text()).slice(0, 200));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
