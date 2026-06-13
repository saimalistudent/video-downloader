'use strict';

const BASE = 'https://spontaneous-salamander-418289.netlify.app';
const TOKEN = 'e2675cdba8f91034';
const VIDEO = 'https://www.tiktok.com/@yeuphimzz/video/7237370304337628442';

async function probe(label, url, init) {
  const res = await fetch(url, Object.assign({
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Omni-Token': TOKEN },
  }, init));
  const ct = res.headers.get('content-type') || '';
  let info;
  if (/json/i.test(ct)) info = (await res.text()).slice(0, 200);
  else {
    const buf = Buffer.from(await res.arrayBuffer());
    const magic = buf.slice(0, 4).toString('hex');
    info = `bytes=${buf.length} magic=${magic} ct=${ct} disp=${res.headers.get('content-disposition')}`;
  }
  console.log(label, res.status, info);
}

async function main() {
  const paths = [
    ['POST dl file', `${BASE}/api/download/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: VIDEO }) }],
    ['POST dl binary', `${BASE}/api/download`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/octet-stream' }, body: JSON.stringify({ url: VIDEO, binary: true }) }],
    ['GET stream ytdlp', `${BASE}/api/stream?url=${encodeURIComponent(VIDEO)}&name=v.mp4&token=${TOKEN}&mode=ytdlp`],
    ['GET stream pipe', `${BASE}/api/stream?url=${encodeURIComponent(VIDEO)}&name=v.mp4&token=${TOKEN}&pipe=1`],
    ['GET stream fmt', `${BASE}/api/stream?url=${encodeURIComponent(VIDEO)}&name=v.mp4&token=${TOKEN}&format=mp4`],
    ['GET ytdlp', `${BASE}/api/ytdlp?url=${encodeURIComponent(VIDEO)}&token=${TOKEN}`],
    ['GET fetch', `${BASE}/api/fetch?url=${encodeURIComponent(VIDEO)}&token=${TOKEN}`],
  ];
  for (const [label, url, init] of paths) await probe(label, url, init);
}

main();
