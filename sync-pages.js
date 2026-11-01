// Один сайт: канон — public/, корень — зеркало для GitHub Pages (Deploy from branch, root).
// Сервер раздаёт public/, Pages раздаёт корень — байты обязаны совпадать,
// иначе витрина без бэкенда и витрина с бэкендом — разные сайты.
// Тест tests/search.test.js («не расходятся») это проверяет; этот скрипт чинит.
const fs = require('fs');
const path = require('path');

const pairs = [
  ['public/index.html', 'index.html'],
  ['public/products-data.js', 'products-data.js'],
  ['public/manifest.json', 'manifest.json'],
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

// Фото, загруженные через админку, сервер отдаёт из public/uploads по пути
// /uploads/... . У Pages корень — репозиторий, значит там тот же путь обязан
// существовать как uploads/..., иначе карточка на витрине без сервера выходит
// с битой картинкой. Каталог файлов зеркалится целиком, лишнее вычищается.
const uploadsFrom = path.join(__dirname, 'public', 'uploads');
const uploadsTo = path.join(__dirname, 'uploads');
let uploadsDirty = 0;
const wanted = fs.existsSync(uploadsFrom) ? fs.readdirSync(uploadsFrom) : [];
if (wanted.length && !fs.existsSync(uploadsTo)) fs.mkdirSync(uploadsTo, { recursive: true });
for (const name of wanted) {
  const a = fs.readFileSync(path.join(uploadsFrom, name));
  let b = null;
  try { b = fs.readFileSync(path.join(uploadsTo, name)); } catch (e) { /* нет зеркала — скопировать */ }
  if (!b || !a.equals(b)) {
    fs.writeFileSync(path.join(uploadsTo, name), a);
    console.log(`synced: uploads/${name} (${a.length} bytes)`);
    uploadsDirty++;
  }
}
for (const name of fs.existsSync(uploadsTo) ? fs.readdirSync(uploadsTo) : []) {
  if (wanted.includes(name)) continue;
  fs.rmSync(path.join(uploadsTo, name));
  console.log(`pruned: uploads/${name} — в public/uploads такого файла нет`);
  uploadsDirty++;
}
if (!uploadsDirty) console.log(`ok: uploads/ == public/uploads/ (${wanted.length} фото)`);
process.exit(0);
