#!/usr/bin/env node
/**
 * VIBE-CLEAN — Плагин-нормализатор вайб-кодинга для витрины OneWatch
 * Синхронизирует чистый светлый адаптивный продакшн-сайт (Zero-CLS) и метрики сжатия в README.
 *
 * Запуск: node vibe-clean.js [--check]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const FILES_TO_SYNC = [
  path.join(ROOT, 'index.html'),
  path.join(ROOT, 'public', 'index.html'),
];

function normalizeHtml(html) {
  let out = html;
  const parts = out.split(/(<script[\s\S]*?<\/script>)/gi);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/\$\{[^}]+\}/g, '#');
  }
  out = parts.join('');
  out = out.replace(/<meta name="theme-color" content="#0B0F17"\s*\/>/g, '<meta name="theme-color" content="#141619" />');
  return out;
}

function formatSpacedInt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function syncReadmeCompressionMetrics() {
  const htmlBuf = fs.readFileSync(path.join(ROOT, 'index.html'));
  const pdBuf = fs.readFileSync(path.join(ROOT, 'public', 'products-data.js'));
  const htmlRaw = formatSpacedInt(htmlBuf.length);
  const htmlBr = formatSpacedInt(zlib.brotliCompressSync(htmlBuf).length);
  const pdRaw = formatSpacedInt(pdBuf.length);
  const pdBr = formatSpacedInt(zlib.brotliCompressSync(pdBuf).length);

  for (const file of ['README.md', 'README.ru.md']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    let txt = fs.readFileSync(p, 'utf8');
    txt = txt.replace(
      /`index\.html`(\s*—?\s*)\d[\d\s\u00A0\u202F]*\d(\s*[БB]\s*→\s*)\d[\d\s\u00A0\u202F]*\d(\s*[БB])/g,
      `\`index.html\`$1${htmlRaw}$2${htmlBr}$3`
    );
    txt = txt.replace(
      /`products-data\.js`(\s*—?\s*)\d[\d\s\u00A0\u202F]*\d(\s*[БB]\s*→\s*)\d[\d\s\u00A0\u202F]*\d(\s*[БB])/g,
      `\`products-data.js\`$1${pdRaw}$2${pdBr}$3`
    );
    fs.writeFileSync(p, txt, 'utf8');
  }
  return { html: [htmlBuf.length, zlib.brotliCompressSync(htmlBuf).length], pd: [pdBuf.length, zlib.brotliCompressSync(pdBuf).length] };
}

function main() {
  const srcPath = path.join(ROOT, 'public', 'index.html');
  const raw = fs.readFileSync(srcPath, 'utf8');
  const cleaned = normalizeHtml(raw);
  for (const dst of FILES_TO_SYNC) {
    fs.writeFileSync(dst, cleaned, 'utf8');
  }
  const metrics = syncReadmeCompressionMetrics();
  console.log('[vibe-clean] Normalized HTML synced across index.html & public/index.html');
  console.log('[vibe-clean] Compression metrics updated:', JSON.stringify(metrics));
}

if (require.main === module) {
  main();
}
module.exports = { normalizeHtml, syncReadmeCompressionMetrics };
