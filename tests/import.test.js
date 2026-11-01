const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { extractImportBlock } = require('./helpers/load');
const { seedKey } = require('../catalog-export.js');

// Импорт исполняется из исходника server.js: тест проверяет тот же парсер,
// по которому админка пишет позиции в базу.
function loadImport() {
  const src = extractImportBlock();
  const factory = new Function('seedKey', `${src}\nreturn { IMPORT_CATEGORIES, IMPORT_MAX_ROWS, normalizeCategory, parsePriceNumber, parseImportTable, classifyImportRows, importPreviewText, insertImportedRows };`);
  return factory(seedKey);
}

function memdb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0, seed_key TEXT);`);
  return db;
}

describe('Импорт каталога: разбор таблицы', () => {
  it('читает строки через точку с запятой и пропускает шапку', () => {
    const { parseImportTable } = loadImport();
    const text = [
      'бренд;серия;категория;название;цена;описание;фото',
      'garmin;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990;AMOLED, титан;https://img/f8.jpg',
      'suunto;;Дайвинг компьютеры;Suunto Vyper;38900',
    ].join('\n');
    const { rows, errors } = parseImportTable(text);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].brand, 'GARMIN');
    assert.equal(rows[0].price, 58990);
    assert.equal(rows[0].image, 'https://img/f8.jpg');
    assert.equal(rows[1].series, '');
    assert.equal(rows[1].specs, '');
    assert.equal(rows[1].image, '');
  });

  it('терпит таб и запятую, цену с пробелами, ₽ и «руб»', () => {
    const { parseImportTable, parsePriceNumber } = loadImport();
    assert.equal(parsePriceNumber('62 320 ₽'), 62320);
    assert.equal(parsePriceNumber('58 990 руб.'), 58990);
    assert.equal(parsePriceNumber('12.500'), 12500);
    assert.equal(parsePriceNumber('нет'), 0);
    const tab = loadImport().parseImportTable('COROS\tPace\tСпортивные часы\tCOROS Pace 3\t21990');
    assert.equal(tab.rows.length, 1);
    assert.equal(tab.rows[0].price, 21990);
    const comma = loadImport().parseImportTable('APPLE,Apple Watch,Спортивные часы,Apple Watch Ultra 2,79990');
    assert.equal(comma.rows.length, 1);
    assert.equal(comma.rows[0].category, 'Спортивные часы');
  });

  it('категория нечувствительна к регистру, но обязана быть с витрины', () => {
    const { normalizeCategory, IMPORT_CATEGORIES } = loadImport();
    assert.equal(normalizeCategory('  спортивные ЧАСЫ '), 'Спортивные часы');
    assert.equal(normalizeCategory('фитнес-трекеры'), 'Фитнес-трекеры');
    assert.equal(normalizeCategory('Эхолоты '), 'Эхолоты');
    assert.equal(normalizeCategory('Квадрокоптеры'), null);
    assert.equal(normalizeCategory(''), null);
    const bad = loadImport().parseImportTable('DJI;;Квадрокоптеры;DJI Avata;40000');
    assert.equal(bad.rows.length, 0);
    assert.match(bad.errors[0].reason, /нет на витрине/);
    for (const c of IMPORT_CATEGORIES) assert.match(bad.errors[0].reason, new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('список категорий не разъезжается с полками на витрине', () => {
    const { IMPORT_CATEGORIES } = loadImport();
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const m = html.match(/const CAT_ORDER=\[([^\]]*)\]/);
    assert.ok(m, 'CAT_ORDER не найден на витрине');
    const front = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(IMPORT_CATEGORIES, front.filter((c) => c !== 'Все товары'), 'полки импорта и витрины различаются');
  });

  it('битые строки отбиваются с внятной причиной, валидные рядом записываются', () => {
    const { parseImportTable } = loadImport();
    const { rows, errors } = parseImportTable([
      'GARMIN;fenix',
      ';fenix;Спортивные часы;Без бренда;58990',
      'GARMIN;fenix;Спортивные часы;Ф;58990',
      'GARMIN;fenix;Спортивные часы;Garmin Fenix 8;abc',
      'GARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990',
    ].join('\n'));
    assert.equal(rows.length, 1, 'прошла только последняя строка');
    assert.equal(errors.length, 4);
    assert.match(errors[0].reason, /меньше четырёх/);
    assert.match(errors[1].reason, /бренд/);
    assert.match(errors[2].reason, /название/);
    assert.match(errors[3].reason, /цена/);
  });

  it('дубликаты внутри файла считаются один раз', () => {
    const { parseImportTable } = loadImport();
    const line = 'GARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990';
    const { rows, errors } = parseImportTable([line, line].join('\n'));
    assert.equal(rows.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /дубликат/);
  });

  it('фото остаётся только ссылкой, всё остальное — пустая строка', () => {
    const { parseImportTable } = loadImport();
    const { rows } = parseImportTable('GARMIN;fenix;Спортивные часы;Fenix 8 тест;58990;оп;C:\\pics\\f8.jpg');
    assert.equal(rows[0].image, '');
  });
});

describe('Импорт каталога: запись в базу', () => {
  it('то, что уже лежит в базе, в новый импорт не попадает', () => {
    const { parseImportTable, classifyImportRows } = loadImport();
    const db = memdb();
    const rows = parseImportTable('GARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990').rows;
    // позиция из админки без seed_key опознаётся по тому же ключу
    db.prepare('INSERT INTO products (brand, series, category, name, price) VALUES (?,?,?,?,?)')
      .run('GARMIN', 'fenix', 'Спортивные часы', 'Garmin Fenix 8 43 мм', 60000);
    let cls = classifyImportRows(db, rows);
    assert.equal(cls.known.length, 1);
    assert.equal(cls.fresh.length, 0);
    // а с проставленным seed_key — тем более
    db.prepare('UPDATE products SET seed_key = ?').run(seedKey(rows[0]));
    cls = classifyImportRows(db, rows);
    assert.equal(cls.known.length, 1);
    // другая позиция — новая
    const other = parseImportTable('COROS;Pace;Спортивные часы;COROS Pace 3;21990').rows;
    cls = classifyImportRows(db, other);
    assert.equal(cls.fresh.length, 1);
    db.close();
  });

  it('строки пишутся одной транзакцией с нулевой скидкой и ключом позиции', () => {
    const { parseImportTable, insertImportedRows } = loadImport();
    const db = memdb();
    const rows = parseImportTable([
      'GARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990;AMOLED;https://img/f8.jpg',
      'COROS;Pace;Спортивные часы;COROS Pace 3;21990',
    ].join('\n')).rows;
    const res = insertImportedRows(db, rows);
    assert.equal(res.error, '');
    assert.equal(res.added, 2);
    const saved = db.prepare('SELECT * FROM products ORDER BY id').all();
    assert.equal(saved.length, 2);
    assert.equal(saved[0].old_price, 0);
    assert.equal(saved[0].is_hit, 0);
    assert.equal(saved[0].seed_key, seedKey(rows[0]));
    assert.equal(saved[1].image, '');
    db.close();
  });

  it('сбой на середине — откат, ни одной записанной строки', () => {
    const { parseImportTable, insertImportedRows } = loadImport();
    const db = memdb();
    const rows = parseImportTable('GARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990').rows;
    db.exec(`CREATE TRIGGER no_insert BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT, 'нет'); END;`);
    const res = insertImportedRows(db, rows);
    assert.ok(res.error, 'ошибка должна быть видна');
    assert.equal(res.added, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM products').get().c, 0);
    db.close();
  });

  it('разбор для админа честно считает полки, дубликаты и ошибки', () => {
    const { parseImportTable, importPreviewText } = loadImport();
    const parsed = parseImportTable([
      'GARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990',
      'COROS;Pace;Спортивные часы;COROS Pace 3;21990',
      'DJI;;Квадрокоптеры;DJI Avata;40000',
      'GARMIN;fenix',
    ].join('\n'));
    const text = importPreviewText(parsed.rows, [{ brand: 'SUUNTO', series: '', category: 'Дайвинг компьютеры', name: 'Suunto Vyper', price: 38900 }], parsed.errors);
    assert.match(text, /Новых позиций: 2/);
    assert.match(text, /Спортивные часы — 2/);
    assert.match(text, /Уже есть в базе \(не трогаем\): 1/);
    assert.match(text, /Не записались \(2\)/);
    assert.match(text, /категории «Квадрокоптеры» нет/);
  });
});
