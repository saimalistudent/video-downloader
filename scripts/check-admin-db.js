const sqlite = require('../lib/sqlite-db');

async function main() {
  if (!sqlite.isAvailable()) {
    console.log('sqlite3 not available');
    return;
  }
  const events = await sqlite.all('SELECT event_type, COUNT(*) as c FROM events GROUP BY event_type');
  console.log('events:', JSON.stringify(events, null, 2));
  const dl = await sqlite.get('SELECT used, limit_value FROM plan_usage WHERE plan_id = ?', ['download-api']);
  console.log('download-api plan:', dl);
  const recent = await sqlite.all('SELECT event_type, message, created_at FROM events ORDER BY created_at DESC LIMIT 5');
  console.log('recent:', JSON.stringify(recent, null, 2));
}

main().catch(function (e) { console.error(e.message); process.exit(1); });
