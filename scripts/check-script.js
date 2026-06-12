const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('<script>\n    /* Monetization');
const end = html.indexOf('</script>', start);
if (start < 0) {
  console.error('Main script not found');
  process.exit(1);
}
const code = html.slice(start + 8, end);
try {
  new vm.Script(code);
  console.log('vm.Script: Syntax OK');
} catch (e) {
  console.error('Syntax error:', e.message);
  if (e.lineNumber) {
    const lines = code.split('\n');
    const ln = e.lineNumber - 1;
    for (let i = Math.max(0, ln - 3); i <= Math.min(lines.length - 1, ln + 3); i++) {
      console.error(String(i + 1).padStart(5) + '| ' + lines[i]);
    }
  }
  process.exit(1);
}
