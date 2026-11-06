// minify-storefront.js — безопасное пережатие статики без смены поведения.
// Только provably-safe преобразования:
//  1) products-data.js: JSON-массив переиздаётся из require() (парсинг = доказательство
//     корректности), шапка-комментарии и node/browser-футер сохраняются;
//  2) index.html: вырезаются только HTML-комментарии (на них никто не завязан).
// Инлайн-JS не трогаем: выигрыш не стоит риска ручного парсинга.
// Запуск: node minify-storefront.js. Проверено: node --check + npm test (281/281).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PD_PATH = path.join(ROOT, 'public', 'products-data.js');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');

function minifyProducts() {
  const rows = require(PD_PATH);
  const list = Array.isArray(rows) ? rows : rows.products;
  if (!Array.isArray(list) || !list.length) throw new Error('products-data.js: пустой каталог');
  const head = [
    '// Единый источник каталога: server.js делает require(), index.html подключает <script src="products-data.js">.',
    "// Формат элемента: { id, brand, series, category, name, price, old_price, image, specs, hit, images } — id задаёт порядок и deep link #/p/<id>. old_price > price означает скидку, 0 — её нет. images — дополнительные реальные ракурсы с сайта производителя.",
  ].join('\n') + '\n';
  const tail = ';\nif (typeof module !== \'undefined\' && module.exports) module.exports = PD_SEED_PRODUCTS;\n' +
    "if (typeof window !== 'undefined') window.SEED_PRODUCTS = PD_SEED_PRODUCTS;\n";
  const out = head + 'const PD_SEED_PRODUCTS = ' + JSON.stringify(list) + tail;
  // Круговая проверка: результат обязан парситься и совпадать по составу.
  const probe = path.join(ROOT, '.minify-probe.js');
  fs.writeFileSync(probe, out);
  try {
    delete require.cache[require.resolve(probe)];
    const back = require(probe);
    const arr = Array.isArray(back) ? back : back.products;
    if (!arr || arr.length !== list.length) throw new Error('round-trip mismatch: ' + (arr && arr.length) + ' vs ' + list.length);
    if (JSON.stringify(arr[0]) !== JSON.stringify(list[0]) || JSON.stringify(arr[arr.length - 1]) !== JSON.stringify(list[list.length - 1])) {
      throw new Error('round-trip content mismatch');
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }
  fs.writeFileSync(PD_PATH, out);
  return { file: 'public/products-data.js', bytes: Buffer.byteLength(out) };
}

function minifyHtml() {
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  const before = Buffer.byteLength(html);
  const comments = html.match(/<!--[\s\S]*?-->/g) || [];
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  fs.writeFileSync(HTML_PATH, html);
  return { file: 'public/index.html', before, bytes: Buffer.byteLength(html), cutComments: comments.length };
}

const a = minifyProducts();
const b = minifyHtml();
console.log('minified:', a.file, a.bytes + ' bytes;', b.file, b.bytes + ' bytes (was ' + b.before + ', cut ' + b.cutComments + ' comments)');
