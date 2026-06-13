'use strict';

const BASE = 'https://spontaneous-salamander-418289.netlify.app';
const TOKEN = 'e2675cdba8f91034';
const VIDEO = 'https://www.tiktok.com/@yeuphimzz/video/7237370304337628442';

async function probeStream(qs) {
  const url = `${BASE}/api/stream?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Omni-Token': TOKEN },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.slice(0, 12).toString('ascii').replace(/[^\x20-\x7E]/g, '.');
  console.log(qs.slice(0, 60), '→', res.status, res.headers.get('content-type'), buf.length, head);
}

async function main() {
  const enc = encodeURIComponent(VIDEO);
  const params = [
    `url=${enc}&name=v.mp4&token=${TOKEN}`,
    `url=${enc}&name=v.mp4&token=${TOKEN}&ytdlp=1`,
    `url=${enc}&name=v.mp4&token=${TOKEN}&proxy=ytdlp`,
    `url=${enc}&name=v.mp4&token=${TOKEN}&mode=ytdlp`,
    `url=${enc}&name=v.mp4&token=${TOKEN}&source=1`,
    `url=${enc}&name=v.mp4&token=${TOKEN}&fresh=1`,
  ];

  // get cdn url first
  const dl = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ url: VIDEO }),
  });
  const data = await dl.json();
  const cdn = (data.medias || []).find((m) => m.type === 'video').url;
  params.push(`url=${encodeURIComponent(cdn)}&name=v.mp4&token=${TOKEN}&referer=${encodeURIComponent(VIDEO)}`);

  for (const p of params) await probeStream(p);
}

main();
