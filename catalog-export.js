// Выгрузка живой базы каталога в файл-источник products-data.js.
// Формат файла: одна позиция = одна строка JSON, id сохраняются, чтобы deep link
// #/p/<id> и payload заказа значили одно и то же на сервере и на GitHub Pages.

const crypto = require('crypto');
const fs = require('fs');

const FIELDS = ['id', 'brand', 'series', 'category', 'name', 'price', 'old_price', 'image', 'specs', 'hit', 'images'];

// Дополнительные ракурсы: в файле — массив images, в базе — JSON-колонка gallery.
// Только локальные uploads/*, не больше 4 доп. кадров (всего до 5 с первичным),
// без дубля первичного фото.
function normalizeImages(p) {
  let raw = [];
  if (Array.isArray(p.images)) raw = p.images;
  else if (Array.isArray(p.gallery)) raw = p.gallery;
  else if (typeof p.gallery === 'string' && p.gallery.trim()) {
    try {
      const parsed = JSON.parse(p.gallery);
      if (Array.isArray(parsed)) raw = parsed;
    } catch (e) { raw = String(p.gallery).split(','); }
  } else if (typeof p.images === 'string' && p.images.trim()) {
    raw = String(p.images).split(',');
  }
  const primary = String(p.image == null ? '' : p.image);
  const out = [];
  for (const u of raw) {
    const s = String(u == null ? '' : u).trim();
    if (!s || s === primary || out.includes(s)) continue;
    if (/^(javascript|data|vbscript):/i.test(s)) continue;
    if (/^https?:\/\//i.test(s)) continue;
    out.push(s);
    if (out.length >= 4) break;
  }
  return out;
}

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
    // 0 = скидки нет. Храним цену до уценки, а не процент: так «снять скидку»
    // возвращает ровно ту цену, что была, и витрина не зависит от округления.
    old_price: Math.trunc(Number(r.old_price)) || 0,
    image: String(r.image == null ? '' : r.image),
    specs: String(r.specs == null ? '' : r.specs),
    hit: Number(r.hit != null ? r.hit : r.is_hit) > 0 ? 1 : 0,
    images: normalizeImages(r),
  };
}

function renderCatalogFile(rows, meta) {
  const items = rows.map(normalizeRow);
  const stamp = (meta && meta.date) || new Date().toISOString().slice(0, 10);
  const lines = items.map((x) => '  ' + JSON.stringify(x)).join(',\n');
  return [
    '// Единый источник каталога: server.js делает require(), index.html подключает <script src="products-data.js">.',
    '// Формат элемента: { id, brand, series, category, name, price, old_price, image, specs, hit, images } — id задаёт порядок и deep link #/p/<id>. old_price > price означает скидку, 0 — её нет. images — дополнительные реальные ракурсы с сайта производителя.',
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

function hasGalleryColumn(db) {
  try {
    return db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'gallery');
  } catch (e) { return false; }
}

// Засев/апгрейд базы из файла-источника. Таблица seed_marks хранит ключи позиций,
// которые в базе уже были: удалённый админом товар не должен воскрешать перезапуск.
function applySeed(db, rows) {
  const gallery = hasGalleryColumn(db);
  const gal = (x) => (gallery ? JSON.stringify(normalizeImages(x)) : undefined);
  const mark = db.prepare('INSERT OR IGNORE INTO seed_marks (seed_key) VALUES (?)');
  for (const r of db.prepare('SELECT brand, series, category, name FROM products').all()) mark.run(seedKey(r));
  // строки, пришедшие из файла, помечаем ключом — по нему видно, что добавлено админом
  const setKey = db.prepare('UPDATE products SET seed_key = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, brand, series, category, name FROM products WHERE seed_key IS NULL').all()) setKey.run(seedKey(r), r.id);
  const marked = new Set(db.prepare('SELECT seed_key FROM seed_marks').all().map((r) => r.seed_key));
  const ins = gallery
    ? db.prepare('INSERT INTO products (brand, series, category, name, price, old_price, image, specs, is_hit, seed_key, gallery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    : db.prepare('INSERT INTO products (brand, series, category, name, price, old_price, image, specs, is_hit, seed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insWithId = gallery
    ? db.prepare('INSERT INTO products (id, brand, series, category, name, price, old_price, image, specs, is_hit, seed_key, gallery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    : db.prepare('INSERT INTO products (id, brand, series, category, name, price, old_price, image, specs, is_hit, seed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const empty = db.prepare('SELECT COUNT(*) AS c FROM products').get().c === 0;
  let added = 0;
  const findById = gallery
    ? db.prepare('SELECT id, image, gallery FROM products WHERE id = ?')
    : db.prepare('SELECT id, image FROM products WHERE id = ?');
  const findByKey = gallery
    ? db.prepare('SELECT id, image, gallery FROM products WHERE seed_key = ?')
    : db.prepare('SELECT id, image FROM products WHERE seed_key = ?');
  const updMedia = gallery
    ? db.prepare('UPDATE products SET image = ?, gallery = ? WHERE id = ?')
    : db.prepare('UPDATE products SET image = ? WHERE id = ?');
  let repaired = 0;
  db.exec("SAVEPOINT apply_seed");
  try {
    for (const x of rows) {
      const key = seedKey(x);
      if (!empty && marked.has(key)) {
        const cur = (Number(x.id) > 0 && findById.get(Number(x.id))) || findByKey.get(key);
        if (cur && x.image) {
          const curImg = String(cur.image || '');
          const curGal = gallery ? String(cur.gallery || '[]') : '[]';
          const targetImg = String(x.image || '');
          const targetGal = gallery ? gal(x) : '[]';
          const isDemoOrCatalog = !curImg || curImg.startsWith('uploads/demo/') || curGal.includes('uploads/demo/') ||
            (curImg.startsWith('uploads/catalog/') && targetImg.startsWith('uploads/catalog/') && (curImg !== targetImg || (gallery && curGal !== targetGal)));
          if (isDemoOrCatalog && (curImg !== targetImg || (gallery && curGal !== targetGal))) {
            if (gallery) updMedia.run(targetImg, targetGal, cur.id);
            else updMedia.run(targetImg, cur.id);
            repaired++;
          }
        }
        continue;
      }
      const hit = Number(x.hit || x.is_hit) > 0 ? 1 : 0;
      const oldPrice = Math.trunc(Number(x.old_price)) || 0;
      if (gallery) {
        const g = gal(x);
        if (empty && Number(x.id) > 0) insWithId.run(Number(x.id), x.brand, x.series, x.category, x.name, x.price, oldPrice, x.image, x.specs, hit, key, g);
        else ins.run(x.brand, x.series, x.category, x.name, x.price, oldPrice, x.image, x.specs, hit, key, g);
      } else if (empty && Number(x.id) > 0) insWithId.run(Number(x.id), x.brand, x.series, x.category, x.name, x.price, oldPrice, x.image, x.specs, hit, key);
      else ins.run(x.brand, x.series, x.category, x.name, x.price, oldPrice, x.image, x.specs, hit, key);
      mark.run(key);
      added++;
    }
    db.exec("RELEASE SAVEPOINT apply_seed");
  } catch (e) {
    try { db.exec("ROLLBACK TO SAVEPOINT apply_seed"); db.exec("RELEASE SAVEPOINT apply_seed"); } catch (_) {}
    throw e;
  }
  return { added, repaired, empty, seeded: rows.length };
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

module.exports = { FIELDS, seedKey, normalizeRow, normalizeImages, hasGalleryColumn, renderCatalogFile, readCatalogFile, rowKey, diffCatalog, summarizeDiff, applySeed, commitCatalogFiles };
