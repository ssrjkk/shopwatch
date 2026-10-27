// Выгрузка живой базы каталога в файл-источник products-data.js.
// Формат файла: одна позиция = одна строка JSON, id сохраняются, чтобы deep link
// #/p/<id> и payload заказа значили одно и то же на сервере и на GitHub Pages.

const crypto = require('crypto');
const fs = require('fs');

const FIELDS = ['id', 'brand', 'series', 'category', 'name', 'price', 'image', 'specs', 'hit'];

// Устойчивый идентификатор позиции файла-источника. По нему сервер понимает,
// что товар уже жил в базе, — в том числе если админ его удалил.
function seedKey(p) {
  const parts = [p.brand, p.series, p.category, p.name].map((v) => String(v == null ? '' : v).trim().toLowerCase());
  return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex');
}

function normalizeRow(r) {
  return {
    id: Math.trunc(Number(r.id)) || 0,
    brand: String(r.brand == null ? '' : r.brand),
    series: String(r.series == null ? '' : r.series),
    category: String(r.category == null ? '' : r.category),
    name: String(r.name == null ? '' : r.name),
    price: Math.trunc(Number(r.price)) || 0,
    image: String(r.image == null ? '' : r.image),
    specs: String(r.specs == null ? '' : r.specs),
    hit: Number(r.hit != null ? r.hit : r.is_hit) > 0 ? 1 : 0,
  };
}

function renderCatalogFile(rows, meta) {
  const items = rows.map(normalizeRow);
  const stamp = (meta && meta.date) || new Date().toISOString().slice(0, 10);
  const lines = items.map((x) => '  ' + JSON.stringify(x)).join(',\n');
  return [
    '// Единый источник каталога: server.js делает require(), index.html подключает <script src="products-data.js">.',
    '// Формат элемента: { id, brand, series, category, name, price, image, specs, hit } — id задаёт порядок и deep link #/p/<id>.',
    `// Выгружено из рабочей базы админ-ботом, дата ${stamp}, позиций: ${items.length}.`,
    'const PD_SEED_PRODUCTS = [',
    lines ? lines + ',' : '',
    '];',
    'if (typeof module !== \'undefined\' && module.exports) module.exports = PD_SEED_PRODUCTS;',
    'if (typeof window !== \'undefined\') window.SEED_PRODUCTS = PD_SEED_PRODUCTS;',
    '',
  ].join('\n');
}

// Читает содержимое файла-источника без side-effect'ов: window/module в sandbox'е пусты.
function readCatalogFile(src) {
  try {
    const fn = new Function(String(src) + '\n;return PD_SEED_PRODUCTS;');
    const rows = fn();
    return Array.isArray(rows) ? rows.map(normalizeRow) : null;
  } catch (e) {
    return null;
  }
}

function rowKey(p) {
  const n = normalizeRow(p);
  return [n.brand, n.series, n.category, n.name, n.price].join('|');
}

function diffCatalog(fileRows, dbRows) {
  const inFile = new Set((fileRows || []).map(rowKey));
  const inDb = new Set((dbRows || []).map(rowKey));
  return {
    fileCount: (fileRows || []).length,
    dbCount: (dbRows || []).length,
    onlyInDb: (dbRows || []).filter((p) => !inFile.has(rowKey(p))),
    onlyInFile: (fileRows || []).filter((p) => !inDb.has(rowKey(p))),
  };
}

// Позиции только в базе — это те, что добавлены через админку и ещё не попали в файл.
function summarizeDiff(diff) {
  const lines = [];
  lines.push(`В базе: ${diff.dbCount}, в файле: ${diff.fileCount}.`);
  lines.push(`Новых в базе (попадут в файл): ${diff.onlyInDb.length}.`);
  if (diff.onlyInFile.length) lines.push(`Есть в файле, но нет в базе (останутся в файле только если не перезаписывать): ${diff.onlyInFile.length}.`);
  return lines.join('\n');
}

// Засев/апгрейд базы из файла-источника. Таблица seed_marks хранит ключи позиций,
// которые в базе уже были: удалённый админом товар не должен воскрешать перезапуск.
function applySeed(db, rows) {
  const mark = db.prepare('INSERT OR IGNORE INTO seed_marks (seed_key) VALUES (?)');
  for (const r of db.prepare('SELECT brand, series, category, name FROM products').all()) mark.run(seedKey(r));
  // строки, пришедшие из файла, помечаем ключом — по нему видно, что добавлено админом
  const setKey = db.prepare('UPDATE products SET seed_key = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, brand, series, category, name FROM products WHERE seed_key IS NULL').all()) setKey.run(seedKey(r), r.id);
  const marked = new Set(db.prepare('SELECT seed_key FROM seed_marks').all().map((r) => r.seed_key));
  const ins = db.prepare('INSERT INTO products (brand, series, category, name, price, image, specs, is_hit, seed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insWithId = db.prepare('INSERT INTO products (id, brand, series, category, name, price, image, specs, is_hit, seed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const empty = db.prepare('SELECT COUNT(*) AS c FROM products').get().c === 0;
  let added = 0;
  for (const x of rows) {
    const key = seedKey(x);
    if (!empty && marked.has(key)) continue;
    const hit = Number(x.hit || x.is_hit) > 0 ? 1 : 0;
    if (empty && Number(x.id) > 0) insWithId.run(Number(x.id), x.brand, x.series, x.category, x.name, x.price, x.image, x.specs, hit, key);
    else ins.run(x.brand, x.series, x.category, x.name, x.price, x.image, x.specs, hit, key);
    mark.run(key);
    added++;
  }
  return { added, empty, seeded: rows.length };
}

// Записывает файл во все цели атомарно: сначала временная копия и проверка,
// что она читается, только потом подмена. Бэкап предыдущей версии остаётся целым.
function commitCatalogFiles(paths, text, validate) {
  const name = (f) => String(f).split(/[\\/]/).slice(-2).join('/');
  const written = [];
  const failed = [];
  const prepared = [];
  for (const f of paths) {
    const tmp = f + '.tmp';
    try {
      fs.writeFileSync(tmp, text);
      if (validate && validate(fs.readFileSync(tmp, 'utf8')) !== true) throw new Error('временная копия не прошла проверку');
      prepared.push({ f, tmp });
    } catch (e) {
      failed.push(`${name(f)}: ${e.message}`);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    }
  }
  if (failed.length) {
    for (const p of prepared) { try { fs.unlinkSync(p.tmp); } catch (e) {} }
    return { written, failed, aborted: true };
  }
  for (const { f, tmp } of prepared) {
    const bak = f + '.bak';
    try {
      if (fs.existsSync(f)) fs.copyFileSync(f, bak);
      fs.copyFileSync(tmp, f);
      if (validate && validate(fs.readFileSync(f, 'utf8')) !== true) {
        if (fs.existsSync(bak)) fs.copyFileSync(bak, f);
        throw new Error('не прошёл проверку после записи, откат из .bak');
      }
      written.push(name(f));
    } catch (e) {
      failed.push(`${name(f)}: ${e.message}`);
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
    }
  }
  return { written, failed, aborted: false };
}

module.exports = { FIELDS, seedKey, normalizeRow, renderCatalogFile, readCatalogFile, rowKey, diffCatalog, summarizeDiff, applySeed, commitCatalogFiles };
