const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { serverSrc, extractOrderCodeFn } = require('./helpers/load');

describe('TG deep-link orders (Pages without backend)', () => {
  let api;

  before(() => {
    const memdb = new DatabaseSync(':memory:');
    memdb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, customer_json TEXT, owner_tg TEXT, owner_max TEXT);`);
    memdb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('payment_details', 'PAY');
    memdb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('last_order_num', '1175');
    memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)').run('GARMIN', 'fēnix', 'Спортивные часы', 'Fenix 8', 60000, 'img', 's');
    memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)').run('APPLE', 'Apple Watch', 'Спортивные часы', 'Ultra 2', 80000, 'img', 's');

    const sent = [];
    const replies = [];
    const prelude = `
const db = memdb;
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
function isValidEnv(val) { return val && typeof val === 'string' && val.trim() !== '' && !val.startsWith('ВСТАВЬ_'); }
const tgBot = { telegram: { sendMessage: async (id, text) => { sent.push({ id, text }); } } };
process.env.TG_ADMIN_ID = '1';
${extractOrderCodeFn()}
const mkCtx = (id) => ({ from: { username: 'ivan', first_name: 'Ivan', id: id || 555 }, reply: (t) => { replies.push(t); return t; } });
`;
    const src = serverSrc();
    const start = src.indexOf('// Заказ с витрины');
    const end = src.indexOf('tgBot.telegram.getMe()');
    const block = src.slice(start, end);
    const driver = `
;return { handleSiteOrderPayload, handleClientOrderLookupTg, parseOrderPayload, allocateOrderCode, mkCtx, db,
  sent: () => sent, replies: () => replies, clear: () => { sent.length = 0; replies.length = 0; } };
`;
    const factory = eval(`(function(memdb){ ${prelude}\n${block}\n${driver} })`);
    api = factory(memdb);
  });

  // toLocaleString('ru-RU') вставляет неразрывный пробел — сравнения нормализуем
  const flat = () => api.replies().join('\n').replace(/[\u00A0\u202F]/g, ' ');
  const sentFlat = () => api.sent().map((m) => m.text.replace(/[\u00A0\u202F]/g, ' ')).join('\n');

  it('creates a pending order from a multi-item deep link', () => {
    api.clear();
    api.handleSiteOrderPayload(api.mkCtx(), 'TG-20001', 'TG-20001_1x2x60000');
    const order = api.db.prepare('SELECT * FROM orders WHERE order_code = ?').get('TG-20001');
    assert.ok(order);
    assert.equal(order.total, 120000);
    assert.equal(order.status, 'Новый (сайт)');
    assert.ok(flat().includes('TG-20001'));
    assert.match(sentFlat(), /НОВАЯ ЗАЯВКА С САЙТА TG-20001/);
  });

  it('resolves product names from the bot DB', () => {
    api.clear();
    api.handleSiteOrderPayload(api.mkCtx(), 'TG-20002', 'TG-20002_1x1x60000');
    const items = JSON.parse(api.db.prepare('SELECT items_json FROM orders WHERE order_code=?').get('TG-20002').items_json);
    assert.equal(items[0].name, 'Fenix 8');
  });

  it('refuses a link whose price disagrees with the base instead of ordering another product', () => {
    api.clear();
    // товар за 60 000 в ссылке продается за 2 ₽: это либо правка ссылки, либо
    // устаревший каталог на витрине, где под тем же id другой товар. Не угадываем.
    api.handleSiteOrderPayload(api.mkCtx(), 'TG-20010', 'TG-20010_1x2x2');
    assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM orders WHERE order_code=?').get('TG-20010').c, 0, 'заявка не создана');
    assert.match(flat(), /расходится/);
    assert.ok(api.sent().some((m) => /ЗАКАЗ TG-20010 НЕ СОЗДАН/.test(m.text)), 'админ увидел расхождение');
    api.clear();
    // несуществующий id не превращается в «Товар #999999»
    api.handleSiteOrderPayload(api.mkCtx(), 'TG-20011', 'TG-20011_999999x1x5');
    assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM orders WHERE order_code=?').get('TG-20011').c, 0);
    assert.match(flat(), /Не нашёл в каталоге позиции/);
  });

  it('gives a fresh number when two buyers picked the same code', () => {
    api.clear();
    api.handleSiteOrderPayload(api.mkCtx(555), 'TG-20020', 'TG-20020_1x1x60000');
    api.handleSiteOrderPayload(api.mkCtx(777), 'TG-20020', 'TG-20020_2x1x80000');
    const codes = api.db.prepare('SELECT order_code, total FROM orders ORDER BY id').all().slice(-2);
    assert.equal(codes.length, 2);
    assert.notEqual(codes[0].order_code, codes[1].order_code, 'номера не должны повторяться');
    assert.equal(codes[1].total, 80000);
    assert.ok(/занятый номер TG-20020/.test(sentFlat()), 'админ видит, что номер подменили');
    assert.match(flat(), new RegExp(codes[1].order_code));
  });

  it('same composition and number is shown once, not duplicated', () => {
    api.clear();
    api.handleSiteOrderPayload(api.mkCtx(555), 'TG-20025', 'TG-20025_1x1x60000');
    api.handleSiteOrderPayload(api.mkCtx(555), 'TG-20025', 'TG-20025_1x1x60000');
    assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM orders WHERE order_code=?').get('TG-20025').c, 1);
  });

  it('shows order details only to its owner or the admin', () => {
    api.clear();
    api.handleSiteOrderPayload(api.mkCtx(555), 'TG-20030', 'TG-20030_1x1x60000');
    api.clear();
    api.handleClientOrderLookupTg(api.mkCtx(999), 'TG-20030');
    const stranger = flat();
    assert.match(stranger, /другим покупателем/);
    assert.equal(stranger.includes('Fenix 8'), false, 'чужой состав не показываем');
    assert.equal(stranger.includes('PAY'), false, 'чужие реквизиты не показываем');
    api.clear();
    api.handleClientOrderLookupTg(api.mkCtx(555), 'TG-20030');
    assert.match(flat(), /60 000/);
    api.clear();
    api.handleClientOrderLookupTg(api.mkCtx(1), 'TG-20030');
    assert.match(flat(), /PAY/, 'админ видит заказ');
  });

  it('shows an existing server order instead of duplicating', () => {
    api.clear();
    api.db.prepare('INSERT INTO orders (order_code, items_json, total) VALUES (?,?,?)').run('TG-3000', JSON.stringify([{ name: 'X', price: 5, qty: 1 }]), 5);
    api.handleSiteOrderPayload(api.mkCtx(), 'TG-3000', 'TG-3000');
    assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM orders WHERE order_code=?').get('TG-3000').c, 1);
    assert.ok(api.replies().join('\n').includes('TG-3000'));
  });

  it('supports legacy single-item payloads', () => {
    api.clear();
    api.handleSiteOrderPayload(api.mkCtx(), 'TG-20003', 'TG-20003_1_60000');
    const order = api.db.prepare('SELECT * FROM orders WHERE order_code = ?').get('TG-20003');
    assert.ok(order && order.total === 60000);
  });

  it('allocates unique numbers instead of colliding with existing orders', () => {
    const seen = new Set();
    for (let i = 0; i < 5; i++) seen.add(api.allocateOrderCode());
    assert.equal(seen.size, 5);
    // следующий выданный номер гарантированно свободен в таблице заказов
    const code = api.allocateOrderCode();
    assert.equal(api.db.prepare('SELECT 1 AS x FROM orders WHERE order_code = ?').get(code), undefined);
    api.db.prepare('INSERT INTO orders (order_code, items_json, total) VALUES (?,?,?)').run(code, '[]', 0);
    assert.notEqual(api.allocateOrderCode(), code);
  });
});
