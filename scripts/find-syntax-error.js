const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('<script>\n    /* Monetization');
const end = html.indexOf('</script>', start);
const code = html.slice(start + 8, end);
const lines = code.split('\n');

let depth = 0;
let inFunction = false;
let funcDepth = 0;
const stack = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();

  // crude function detection
  if (/\bfunction\b|\=\>\s*\{|\=\>\s*$/.test(line) && !/function\s*\(/.test(trimmed + ' x')) {
    // skip
  }
  if (/\bfunction\b|\(\s*\)\s*\{|\(\w+\)\s*\{|\=\>\s*\{/.test(line)) {
    // entering function-ish
  }

  if (/^\s*return\b/.test(line)) {
    // check if we're inside any block by counting braces up to this line
    let d = 0;
    let inStr = false;
    let strChar = '';
    for (let j = 0; j <= i; j++) {
      const l = lines[j];
      for (let k = 0; k < l.length; k++) {
        const c = l[k];
        const prev = l[k - 1];
        if (inStr) {
          if (c === strChar && prev !== '\\') inStr = false;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') {
          inStr = true;
          strChar = c;
          continue;
        }
        if (c === '{') d++;
        if (c === '}') d--;
      }
    }
    // At script top level, depth should be 1 (inside script? no - top level is 0)
    // return is legal when inside function - function adds brace
    console.log('Line', i + 1, 'depth', d, ':', trimmed.slice(0, 100));
  }
}

// Use acorn if available
try {
  require('acorn').parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  console.log('acorn: OK');
} catch (e) {
  console.error('acorn error:', e.message);
  if (e.loc) {
    const ln = e.loc.line - 1;
    for (let i = Math.max(0, ln - 4); i <= Math.min(lines.length - 1, ln + 4); i++) {
      console.error(String(i + 1).padStart(5) + '| ' + lines[i]);
    }
  }
}
