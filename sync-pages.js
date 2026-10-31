// Один сайт: канон — public/, корень — зеркало для GitHub Pages (Deploy from branch, root).
// Сервер раздаёт public/, Pages раздаёт корень — байты обязаны совпадать,
// иначе витрина без бэкенда и витрина с бэкендом — разные сайты.
// Тест tests/search.test.js («не расходятся») это проверяет; этот скрипт чинит.
const fs = require('fs');
const path = require('path');

const pairs = [
  ['public/index.html', 'index.html'],
  ['public/products-data.js', 'products-data.js'],
];

let dirty = 0;
for (const [from, to] of pairs) {
  const src = path.join(__dirname, from);
  const dst = path.join(__dirname, to);
  const a = fs.readFileSync(src);
  let b = null;
  try { b = fs.readFileSync(dst); } catch (e) { /* нет файла — скопировать */ }
  if (!b || !a.equals(b)) {
    fs.copyFileSync(src, dst);
    console.log(`synced: ${to} <- ${from} (${a.length} bytes)`);
    dirty++;
  } else {
    console.log(`ok: ${to} == ${from}`);
  }
}
process.exit(0);
