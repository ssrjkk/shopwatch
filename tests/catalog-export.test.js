const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRow, renderCatalogFile, readCatalogFile, diffCatalog, summarizeDiff } = require('../catalog-export.js');
const { mountFrontend, withIds } = require('./helpers/dom');

const DB_ROWS = [
  { id: 3, brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Fenix 8 47 мм "Black"', price: 59900, image: 'https://img/3.jpg', specs: 'AMOLED, мульти-GNSS', is_hit: 1 },
  { id: 7, brand: 'SUUNTO', series: 'Suunto', category: 'Дайвинг компьютеры', name: 'Suunto Vyper', price: 38900, image: 'https://img/7.jpg', specs: 'декомпрессия\nдве смеси', is_hit: 0 },
  { id: 11, brand: 'APPLE', series: 'Apple Watch', category: 'Спортивные часы', name: 'Ultra 2', price: 79990, image: 'https://img/11.jpg', specs: '49 мм', is_hit: null },
];

describe('экспорт каталога из базы в файл-источник', () => {
  it('нормализует строку БД в формат файла', () => {
    const n = normalizeRow(DB_ROWS[0]);
    assert.deepEqual(n, {
      id: 3, brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы',
      name: 'Fenix 8 47 мм "Black"', price: 59900, image: 'https://img/3.jpg',
      specs: 'AMOLED, мульти-GNSS', hit: 1,
    });
    assert.equal(normalizeRow(DB_ROWS[1]).hit, 0);
    assert.equal(normalizeRow({ ...DB_ROWS[0], id: '12', price: '99.7', hit: undefined, is_hit: 1 }).id, 12);
    assert.equal(normalizeRow({ ...DB_ROWS[0], price: '99.7' }).price, 99);
  });

  it('генерирует файл, который читается и в Node, и в браузере, без потери полей', () => {
    const text = renderCatalogFile(DB_ROWS, { date: '2026-10-26' });
    assert.match(text, /const PD_SEED_PRODUCTS = \[/);
    assert.match(text, /module\.exports = PD_SEED_PRODUCTS/);
    assert.match(text, /window\.SEED_PRODUCTS = PD_SEED_PRODUCTS/);
    const parsed = readCatalogFile(text);
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(parsed, DB_ROWS.map(normalizeRow));
    assert.ok(text.includes('\\"Black\\"'), 'кавычки в названии экранированы');
    assert.ok(text.includes('\\nдве смеси'), 'перенос строки в описании не ломает файл');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-export-'));
    const file = path.join(dir, 'products-data.js');
    fs.writeFileSync(file, text);
    const g = mountFrontend({ productsData: file });
    assert.equal(g.state.products.length, DB_ROWS.length, 'витрина видит все выгруженные позиции');
    assert.deepEqual(g.state.products.map((p) => p.id), [3, 7, 11], 'id сохранены — deep link #/p/<id> не съезжает');
    g.document.getElementById('search-input').value = 'suunto';
    g.renderCatalog();
    assert.equal(g.state.filtered.length, 1);
    assert.ok(g.document.getElementById('products-grid').innerHTML.includes('Suunto Vyper'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('запись файла атомарна: битый результат не трогает ни рабочую копию, ни бэкап', () => {
    const { commitCatalogFiles } = require('../catalog-export.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-commit-'));
    const targets = [path.join(dir, 'products-data.js'), path.join(dir, 'public', 'products-data.js')];
    fs.mkdirSync(path.join(dir, 'public'));
    const good = renderCatalogFile(DB_ROWS, { date: '2026-10-26' });
    for (const f of targets) fs.writeFileSync(f, 'старое содержимое');
    const validate = (src) => { const r = readCatalogFile(src); return Array.isArray(r) && r.length === DB_ROWS.length ? true : false; };

    const ok = commitCatalogFiles(targets, good, validate);
    assert.deepEqual(ok.failed, [], 'оба файла записаны');
    assert.equal(ok.written.length, 2);
    for (const f of targets) assert.equal(fs.existsSync(f + '.bak'), true, 'резервная копия цела');

    const broken = 'const PD_SEED_PRODUCTS = [ {oops';
    const bad = commitCatalogFiles(targets, broken, validate);
    assert.equal(bad.aborted, true, 'битый файл не записывается');
    assert.equal(bad.written.length, 0);
    for (const f of targets) {
      assert.equal(fs.readFileSync(f, 'utf8'), good, 'рабочий файл не испорчен');
      assert.equal(fs.readFileSync(f + '.bak', 'utf8'), 'старое содержимое', 'бэкап не перезаписан битым');
    }
    for (const f of targets) assert.equal(fs.existsSync(f + '.tmp'), false, 'временные файлы убраны');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('боевой products-data.js читается тем же парсером', () => {
    const live = readCatalogFile(fs.readFileSync(path.join(__dirname, '..', 'products-data.js'), 'utf8'));
    assert.ok(Array.isArray(live) && live.length >= 300, `файл-источник читается, позиций: ${live && live.length}`);
    assert.ok(live.every((p) => p.name && Number(p.price) > 0 && p.category));
  });

  it('diff показывает, что живёт только в базе', () => {
    const file = DB_ROWS.slice(0, 2).map(normalizeRow);
    const db = DB_ROWS.map(normalizeRow);
    const d = diffCatalog(file, db);
    assert.equal(d.fileCount, 2);
    assert.equal(d.dbCount, 3);
    assert.deepEqual(d.onlyInDb.map((p) => p.id), [11]);
    assert.equal(d.onlyInFile.length, 0);
    assert.match(summarizeDiff(d), /Новых в базе \(попадут в файл\): 1/);
    const renamed = file.map((p) => ({ ...p, price: p.price + 1 }));
    const d2 = diffCatalog(renamed, db);
    assert.equal(d2.onlyInDb.length, 3, 'смена цены — это новая позиция');
  });

  it('пустая база воспроизводит файл один в один, а перезапуск не воскрешает удалённое', () => {
    const { DatabaseSync } = require('node:sqlite');
    const { applySeed } = require('../catalog-export.js');
    const memdb = new DatabaseSync(':memory:');
    memdb.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0, seed_key TEXT);
CREATE TABLE seed_marks (seed_key TEXT PRIMARY KEY, marked_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    const src = withIds(require(path.join(__dirname, '..', 'products-data.js')).slice(0, 25));
    const first = applySeed(memdb, src);
    assert.equal(first.added, src.length, 'пустая база заполняется целиком');
    assert.deepEqual(memdb.prepare('SELECT id FROM products ORDER BY id').all().map((r) => r.id), src.map((r) => r.id), 'id не съехали');
    assert.equal(applySeed(memdb, src).added, 0, 'повторный запуск ничего не добавляет');

    // админ удалил товар — перезапуск сервера обязан оставить его удалённым
    const removed = memdb.prepare('SELECT id, name FROM products ORDER BY id LIMIT 1').get();
    memdb.prepare('DELETE FROM products WHERE id = ?').run(removed.id);
    const afterRestart = applySeed(memdb, src);
    assert.equal(afterRestart.added, 0, 'удалённый товар не воскресает');
    assert.equal(memdb.prepare('SELECT COUNT(*) AS c FROM products').get().c, src.length - 1);

    // новая позиция файла (например, после выгрузки с другого сервера) добавляется
    const fresh = { id: 9001, brand: 'TEST', series: 'TestSeries', category: 'Аксессуары', name: 'Новая позиция', price: 1000, image: 'x', specs: '', hit: 0 };
    assert.equal(applySeed(memdb, [...src, fresh]).added, 1, 'новые позиции догружаются');
    assert.ok(memdb.prepare('SELECT 1 AS x FROM products WHERE name = ?').get('Новая позиция'));

    const kept = src.filter((x) => x.id !== removed.id);
    const back = memdb.prepare('SELECT * FROM products ORDER BY id ASC').all();
    assert.deepEqual(diffCatalog(kept, back.map(normalizeRow)).onlyInDb.map((p) => p.name), ['Новая позиция']);
    const text = renderCatalogFile(memdb.prepare("SELECT * FROM products WHERE name <> 'Новая позиция' ORDER BY id ASC").all());
    assert.deepEqual(readCatalogFile(text), kept.map(normalizeRow), 'выгрузка повторима: файл -> база -> файл идентичен');
  });
});
