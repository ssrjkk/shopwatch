const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { serverSrc } = require('./helpers/load');

describe('TG deep-link orders (Pages without backend)', () => {
  let api;

  before(() => {
    const memdb = new DatabaseSync(':memory:');
    memdb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, customer_json TEXT);`);
    memdb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('payment_details', 'PAY');
    memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)').run('GARMIN', 'fēnix', 'Спортивные часы', 'Fenix 8', 60000, 'img', 's');

    const sent = [];
    const replies = [];
    const prelude = `
const db = memdb;
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
function isValidEnv(val) { return val && typeof val === 'string' && val.trim() !== '' && !val.startsWith('ВСТАВЬ_'); }
const tgBot = { telegram: { sendMessage: async (id, text) => { sent.push({ id, text }); } } };
process.env.TG_ADMIN_ID = '1';
const mkCtx = () => ({ from: { username: 'ivan', first_name: 'Ivan', id: 555 }, reply: (t) => { replies.push(t); return t; } });
`;
    const src = serverSrc();
    const start = src.indexOf('// Заказ с витрины');
    const end = src.indexOf('tgBot.telegram.getMe()');
    const block = src.slice(start, end);
    const driver = `
;return { handleSiteOrderPayload, handleClientOrderLookupTg, mkCtx, db,
  sent: () => sent, replies: () => replies, clear: () => { sent.length = 0; replies.length = 0; } };
`;
    const factory = eval(`(function(memdb){ ${prelude}\n${block}\n${driver} })`);
    api = factory(memdb);
  });

  it('creates a pending order from a multi-item deep link', () => {
    api.clear();
    const ctx = api.mkCtx();
    api.handleSiteOrderPayload(ctx, 'TG-20001', 'TG-20001_1x2x60000');
    const order = api.db.prepare('SELECT * FROM orders WHERE order_code = ?').get('TG-20001');
    assert.ok(order);
    assert.equal(order.total, 120000);
    assert.equal(order.status, 'Новый (сайт)');
    assert.ok(api.replies().join('\n').includes('TG-20001'));
    assert.ok(api.sent().some((m) => m.text.includes('НОВАЯ ЗАЯВКА С САЙТА TG-20001')));
  });

  it('resolves product names from the bot DB', () => {
    api.clear();
    api.handleSiteOrderPayload(api.mkCtx(), 'TG-20002', 'TG-20002_1x1x60000');
    const items = JSON.parse(api.db.prepare('SELECT items_json FROM orders WHERE order_code=?').get('TG-20002').items_json);
    assert.equal(items[0].name, 'Fenix 8');
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
});
