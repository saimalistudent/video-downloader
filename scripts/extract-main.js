const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('<script>\n    /* Monetization');
const end = html.indexOf('</script>', start);
fs.writeFileSync('scripts/extracted-main.js', html.slice(start + 8, end));
