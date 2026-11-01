const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function serverSrc() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
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

// Реальный выдающий номера заказов код сервера — тесты не должны подменять его заглушкой.
function extractOrderCodeFn() {
  const src = serverSrc();
  const start = src.indexOf('function allocateOrderCode()');
  if (start < 0) throw new Error('allocateOrderCode not found in server.js');
  const tail = src.slice(start);
  const m = /\n\}\n/.exec(tail);
  if (!m) throw new Error('allocateOrderCode end not found');
  return tail.slice(0, m.index + 2);
}

function extractFrontendScript() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error('inline frontend script not found');
  return m[1];
}

function extractTgAdminBlock() {
  const src = serverSrc();
  const start = src.indexOf('// ---------- TG admins ----------');
  const end = src.indexOf("app.get('/api/state'");
  if (start < 0 || end < 0) throw new Error('TG admins block markers not found in server.js');
  return src.slice(start, end);
}

function extractDiscountFns() {
  const src = serverSrc();
  const start = src.indexOf('// ---------- Скидки ----------');
  const end = src.indexOf('// ---------- /Скидки ----------');
  if (start < 0 || end < 0) throw new Error('Скидки block markers not found in server.js');
  return src.slice(start, end);
}

function extractImportBlock() {
  const src = serverSrc();
  const start = src.indexOf('// ---------- Импорт каталога ----------');
  const end = src.indexOf('// ---------- /Импорт каталога ----------');
  if (start < 0 || end < 0) throw new Error('Импорт каталога block markers not found in server.js');
  return src.slice(start, end);
}

function extractAdminBlock() {
  const src = serverSrc();
  const start = src.indexOf('// ---------- Админка: каталог, заказы, сводка ----------');
  const end = src.indexOf('// ---------- /Админка ----------');
  if (start < 0 || end < 0) throw new Error('Админка block markers not found in server.js');
  return src.slice(start, end);
}

module.exports = { ROOT, serverSrc, extractMaxBlock, extractVerifyFn, extractOrderCodeFn, extractFrontendScript, extractTgAdminBlock, extractDiscountFns, extractImportBlock, extractAdminBlock };
