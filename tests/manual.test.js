const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { extractAdminBlock, extractEncodingBlock, extractImportBlock, extractOrderCodeFn } = require('./helpers/load');
const { seedKey } = require('../catalog-export.js');

// Ядро ручной заявки, доставок и правки бренда — общее для TG и MAX,
// поэтому проверяется один раз здесь, а не в обоих ботах.
function loadCore() {
  const memdb = new DatabaseSync(':memory:');
  memdb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0, stock INTEGER DEFAULT 4, seed_key TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, customer_json TEXT, owner_tg TEXT, owner_max TEXT, promo_code TEXT, discount INTEGER DEFAULT 0);
CREATE TABLE seed_marks (seed_key TEXT PRIMARY KEY, marked_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  memdb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('last_order_num', '1175');
  const ins = memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)');
  ins.run('GARMIN', 'fēnix', 'Спортивные часы', 'Fenix 8', 60000, 'img', 's');
  ins.run('APPLE', 'Watch', 'Спортивные часы', 'Ultra 2', 70000, 'img', 's');
  ins.run('DEEPER', 'Chirp', 'Эхолоты', 'Chirp 3', 35000, 'img', 's');
  const getSetting = (k) => memdb.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';
  const setSetting = (k, v) => memdb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
  const api = new Function('seedKey', 'db', 'getSetting', 'setSetting', 'fs', 'path',
    `${extractEncodingBlock()}\n${extractImportBlock()}\n${extractAdminBlock()}\n${extractOrderCodeFn()}\nreturn { PRODUCT_FIELD_LABELS, setProductField, parseManualItems, createManualOrder, deliveryMethods, normalizeDelivery, catalogPage, ordersPage, productById, ADMIN_PAGE, ADMIN_ORDER_PAGE, extraCategories, allStoreCategories, normalizeCategory, STORE_DESIGNS, storeDesignName, setStoreDesign };`
  )(seedKey, memdb, getSetting, setSetting, require('fs'), require('path'));
  return { api, db: memdb, getSetting, setSetting };
}

describe('ручная заявка и доставки (ядро для TG и MAX)', () => {
  let core;
  let api;
  beforeEach(() => { core = loadCore(); api = core.api; });

  it('бренд правится как остальные поля', () => {
    assert.ok(api.PRODUCT_FIELD_LABELS.brand, 'Бренд есть в подписях кнопок');
    const r = api.setProductField(core.db, 1, 'brand', 'suunto');
    assert.equal(r.ok, true);
    assert.equal(r.row.brand, 'suunto');
    assert.equal(api.setProductField(core.db, 1, 'brand', 'x').ok, false);
  });

  it('наличие правится числом, 0 — под заказ', () => {
    assert.ok(api.PRODUCT_FIELD_LABELS.stock, 'Наличие есть в подписях кнопок');
    assert.equal(api.setProductField(core.db, 1, 'stock', '7').row.stock, 7);
    assert.equal(api.setProductField(core.db, 1, 'stock', '0').row.stock, 0);
    assert.equal(api.setProductField(core.db, 1, 'stock', 'много').ok, false);
    assert.equal(api.setProductField(core.db, 1, 'stock', '-1').ok, false);
  });

  it('категории расширяются настройкой extra_categories', () => {
    assert.equal(api.normalizeCategory('Квадрокоптеры', core.db), null, 'без настройки чужой полки нет');
    core.setSetting('extra_categories', 'Квадрокоптеры, Оптика');
    assert.deepEqual(api.extraCategories(core.db), ['Квадрокоптеры', 'Оптика']);
    assert.ok(api.allStoreCategories(core.db).includes('Квадрокоптеры'));
    assert.equal(api.normalizeCategory('квадрокоптеры', core.db), 'Квадрокоптеры', 'регистр не важен');
    const r = api.setProductField(core.db, 1, 'category', 'Квадрокоптеры');
    assert.equal(r.ok, true);
    assert.equal(r.row.category, 'Квадрокоптеры');
    core.setSetting('extra_categories', '');
    assert.equal(api.normalizeCategory('Квадрокоптеры', core.db), null, 'убрали из настройки — полка закрыта');
  });

  it('смена дизайна пишет оба файла и запоминается', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-design-'));
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'index-stealth.html'), '<html>STEALTH products-data.js</html>');
    fs.writeFileSync(path.join(dir, 'public', 'index-classic.html'), '<html>CLASSIC products-data.js</html>');
    assert.equal(api.setStoreDesign(dir, 'classic').ok, true);
    assert.ok(fs.readFileSync(path.join(dir, 'public', 'index.html'), 'utf8').includes('CLASSIC'));
    assert.ok(fs.readFileSync(path.join(dir, 'index.html'), 'utf8').includes('CLASSIC'));
    assert.equal(api.storeDesignName(core.db), 'classic');
    assert.equal(api.setStoreDesign(dir, 'nope').ok, false, 'неизвестный дизайн отклонён');
    fs.writeFileSync(path.join(dir, 'public', 'index-classic.html'), 'мусор без каталога');
    assert.equal(api.setStoreDesign(dir, 'classic').ok, false, 'файл без каталога не ставим');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parseManualItems понимает "12x2, 45" и бракует мусор', () => {
    assert.deepEqual(api.parseManualItems('1x2, 3'), { ok: true, items: [{ id: 1, qty: 2 }, { id: 3, qty: 1 }] });
    assert.equal(api.parseManualItems('абырвалг').ok, false);
    assert.equal(api.parseManualItems('').ok, false);
    assert.equal(api.parseManualItems('1x0').ok, false);
    assert.equal(api.parseManualItems('1x100').ok, false);
  });

  it('createManualOrder считает по базе, требует ФИО и телефон', () => {
    const ok = api.createManualOrder(core.db, { items: [{ id: 1, qty: 2 }, { id: 3, qty: 1 }], fio: 'Иван', phone: '+7 900 111-22-33' });
    assert.equal(ok.ok, true);
    assert.match(ok.code, /^TG-\d+$/);
    assert.equal(ok.total, 60000 * 2 + 35000);
    const row = core.db.prepare('SELECT * FROM orders WHERE order_code = ?').get(ok.code);
    assert.equal(row.status, 'Новый');
    assert.equal(JSON.parse(row.customer_json).fio, 'Иван');
    assert.equal(api.createManualOrder(core.db, { items: [{ id: 1, qty: 1 }], fio: '', phone: '+79001112233' }).ok, false);
    assert.equal(api.createManualOrder(core.db, { items: [{ id: 1, qty: 1 }], fio: 'Иван', phone: '123' }).ok, false);
    assert.equal(api.createManualOrder(core.db, { items: [{ id: 999, qty: 1 }], fio: 'Иван', phone: '+79001112233' }).ok, false);
  });

  it('доставки берутся из настройки, мусор нормализуется в первую', () => {
    assert.deepEqual(api.deliveryMethods(core.db), ['СДЭК', 'Почта России', 'Boxberry']);
    core.setSetting('delivery_methods', 'СДЭК, Boxberry');
    assert.deepEqual(api.deliveryMethods(core.db), ['СДЭК', 'Boxberry']);
    assert.equal(api.normalizeDelivery(core.db, 'Boxberry'), 'Boxberry');
    assert.equal(api.normalizeDelivery(core.db, 'Почта России'), 'СДЭК');
    assert.equal(api.createManualOrder(core.db, { items: [{ id: 2, qty: 1 }], fio: 'И', phone: '+79001112233', delivery: 'Дроном' }).ok, true);
    const last = core.db.prepare('SELECT customer_json FROM orders ORDER BY id DESC').get();
    assert.equal(JSON.parse(last.customer_json).delivery, 'СДЭК');
  });

  it('SQL-пагинация даёт те же страницы, что полный проход', () => {
    for (let i = 0; i < 20; i++) core.db.prepare('INSERT INTO products (brand, series, category, name, price) VALUES (?,?,?,?,?)').run('B', 'S', 'Спортивные часы', 'Доп ' + i, 1000 + i);
    const p1 = api.catalogPage(core.db, { category: 'Спортивные часы' });
    assert.equal(p1.total, 22);
    assert.equal(p1.items.length, api.ADMIN_PAGE);
    assert.equal(p1.pages, Math.ceil(22 / api.ADMIN_PAGE));
    assert.equal(p1.items[0].id > p1.items[p1.items.length - 1].id, true);
    const last = api.catalogPage(core.db, { category: 'Спортивные часы', page: 99 });
    assert.equal(last.page, last.pages);
    const q = api.catalogPage(core.db, { query: 'доп' });
    assert.ok(q.total >= 20 && q.items.length <= api.ADMIN_PAGE);
    for (let i = 0; i < 10; i++) {
      core.db.prepare("INSERT INTO orders (order_code, items_json, total, status, customer_json) VALUES (?,?,?,?,?)")
        .run('TG-9' + i, '[]', 100, i % 2 ? 'Новый' : 'Оплачен', '{"fio":"Тест Тестов","phone":"+70000000000"}');
    }
    const o = api.ordersPage(core.db, {});
    assert.equal(o.total, 10);
    assert.equal(o.items.length, api.ADMIN_ORDER_PAGE);
    const oq = api.ordersPage(core.db, { query: 'тестов' });
    assert.equal(oq.total, 10);
    const of = api.ordersPage(core.db, { status: 'Оплачен' });
    assert.ok(of.total === 5 && of.items.every((x) => x.status === 'Оплачен'));
  });
});
