const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function serverSrc() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
}

function extractMaxBlock() {
  const src = serverSrc();
  const start = src.indexOf('// ---------- MAX bot');
  const end = src.indexOf('startMaxBotPolling();');
  if (start < 0 || end < 0) throw new Error('MAX block markers not found in server.js');
  return src.slice(start, end);
}

function extractVerifyFn() {
  const src = serverSrc();
  const start = src.indexOf('function verifyTelegramInitData');
  if (start < 0) throw new Error('verifyTelegramInitData not found in server.js');
  const tail = src.slice(start);
  const m = /\n\}\n/.exec(tail);
  if (!m) throw new Error('verifyTelegramInitData end not found');
  return tail.slice(0, m.index + 2);
}

function extractFrontendScript() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error('inline frontend script not found');
  return m[1];
}

module.exports = { ROOT, serverSrc, extractMaxBlock, extractVerifyFn, extractFrontendScript };
