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

// Фото, загруженные через админку, и локальный каталог студийных кадров сервер
// отдаёт из public/uploads по пути /uploads/... . У Pages корень — репозиторий,
// значит там тот же путь обязан существовать как uploads/..., иначе карточка на
// витрине без сервера выходит с битой картинкой. Дерево зеркалится рекурсивно,
// лишнее вычищается.
const uploadsFrom = path.join(__dirname, 'public', 'uploads');
const uploadsTo = path.join(__dirname, 'uploads');
let uploadsDirty = 0;
function listFilesRecursive(dir, base = '') {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out = out.concat(listFilesRecursive(full, rel));
    else out.push(rel);
  }
  return out;
}
const wanted = listFilesRecursive(uploadsFrom);
if (wanted.length && !fs.existsSync(uploadsTo)) fs.mkdirSync(uploadsTo, { recursive: true });
for (const rel of wanted) {
  const src = path.join(uploadsFrom, rel);
  const dst = path.join(uploadsTo, rel);
  const a = fs.readFileSync(src);
  let b = null;
  try { b = fs.readFileSync(dst); } catch (e) { /* нет зеркала — скопировать */ }
  if (!b || !a.equals(b)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, a);
    console.log(`synced: uploads/${rel} (${a.length} bytes)`);
    uploadsDirty++;
  }
}
for (const rel of listFilesRecursive(uploadsTo)) {
  if (wanted.includes(rel)) continue;
  fs.rmSync(path.join(uploadsTo, rel));
  console.log(`pruned: uploads/${rel} — в public/uploads такого файла нет`);
  uploadsDirty++;
}
if (!uploadsDirty) console.log(`ok: uploads/ == public/uploads/ (${wanted.length} фото)`);
try { require("./vibe-clean.js").syncReadmeCompressionMetrics(); } catch (e) {}
process.exit(0);
