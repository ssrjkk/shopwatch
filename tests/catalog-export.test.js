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

  it('пустая база воспроизводит файл один в один, id не съезжают', () => {
    const { DatabaseSync } = require('node:sqlite');
    const memdb = new DatabaseSync(':memory:');
    memdb.exec('CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0);');
    const src = withIds(require(path.join(__dirname, '..', 'products-data.js')).slice(0, 25));
    const ins = memdb.prepare('INSERT INTO products (id, brand, series, category, name, price, image, specs, is_hit) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const x of src) ins.run(x.id, x.brand, x.series, x.category, x.name, x.price, x.image, x.specs, x.hit ? 1 : 0);
    const back = memdb.prepare('SELECT * FROM products ORDER BY id ASC').all();
    assert.deepEqual(back.map((r) => r.id), src.map((r) => r.id), 'id не съехали');
    assert.deepEqual(diffCatalog(src, back.map(normalizeRow)).onlyInDb.length, 0, 'после выгрузки база и файл совпадают');
    const text = renderCatalogFile(back);
    assert.deepEqual(readCatalogFile(text), src.map(normalizeRow), 'выгрузка повторима: файл -> база -> файл идентичен');
  });
});
