const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { extractMaxBlock } = require('./helpers/load');

describe('MAX bot (parity with Telegram)', () => {
  let api;
  let memdb;

  before(() => {
    memdb = new DatabaseSync(':memory:');
    memdb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, image TEXT, specs TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    const seed = { payment_details: 'PAY', show_payment: '1', hero_title: 'H', phone: 'P', email: 'E', address: 'A', tg_link: 'T', max_link: 'M', legal_name: 'L', legal_inn: 'I' };
    for (const [k, v] of Object.entries(seed)) memdb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
    memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)').run('GARMIN', 'fēnix', 'Спортивные часы', 'Fenix 8', 60000, 'img', 's');
    memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)').run('APPLE', 'Apple Watch', 'Спортивные часы', 'Ultra 2', 70000, 'img', 's');
    memdb.prepare('INSERT INTO orders (order_code, items_json, total) VALUES (?,?,?)').run('TG-9000', JSON.stringify([{ name: 'Fenix 8', price: 60000, qty: 1 }]), 60000);

    const prelude = `
const db = memdb;
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
function isValidEnv(val) { return val && typeof val === 'string' && val.trim() !== '' && !val.startsWith('ВСТАВЬ_'); }
const uploadsDir = 'uploads';
const sent = [];
global.fetch = async (url, opts) => { sent.push({ url, body: opts?.body ? JSON.parse(opts.body) : null, auth: opts?.headers?.Authorization }); return { ok: true, json: async () => ({}) }; };
process.env.MAX_BOT_TOKEN = 'fake-token';
process.env.MAX_ADMIN_ID = '999';
`;
    const driver = `
;return { handleMaxUpdate, maxNotifyAdmin, maxSessions, db, sent,
  lastTo: (id) => [...sent].reverse().find((s) => s.url.includes('user_id=' + id)),
  upd: (uid, name, text) => ({ update_type: 'message_created', message: { sender: { user_id: uid, name }, body: { text } } }) };
`;
    const factory = eval(`(function(memdb){ ${prelude}\n${extractMaxBlock()}\n${driver} })`);
    api = factory(memdb);
  });

  it('uses platform-api2 domain and header auth, shows menu with buttons', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', '/start'));
    const m = api.lastTo(999);
    assert.ok(m.url.startsWith('https://platform-api2.max.ru/messages'));
    assert.equal(m.auth, 'fake-token');
    assert.ok(JSON.stringify(m.body.attachments).includes('Добавить часы'));
  });

  it('add-product wizard inserts the product', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Добавить часы'));
    for (const t of ['GARMIN', 'fēnix', 'Спортивные часы', 'Fenix 9', '65000', 'desc', 'http://img/x.jpg']) {
      await api.handleMaxUpdate(api.upd(999, 'Admin', t));
    }
    const p = api.db.prepare("SELECT * FROM products WHERE name='Fenix 9'").get();
    assert.ok(p && p.price === 65000 && p.image === 'http://img/x.jpg');
    assert.ok(api.lastTo(999).body.text.includes('добавлены'));
  });

  it('price change and delete work via buttons', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Товары и цены'));
    assert.ok(JSON.stringify(api.lastTo(999).body.attachments).includes('Цена #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Цена #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', '62000'));
    assert.equal(api.db.prepare('SELECT price FROM products WHERE id=1').get().price, 62000);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Удалить #2'));
    assert.equal(api.db.prepare('SELECT * FROM products WHERE id=2').get(), undefined);
  });

  it('payment requisites edit + visibility toggle', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Реквизиты оплаты'));
    assert.ok(api.lastTo(999).body.text.includes('PAY'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Изменить реквизиты'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'СБП 123'));
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='payment_details'").get().value, 'СБП 123');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Скрыть на сайте'));
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='show_payment'").get().value, '0');
  });

  it('site texts edit via buttons', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Тексты и контакты'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Телефон'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', '+7-000'));
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='phone'").get().value, '+7-000');
  });

  it('order list + status buttons change status (not hijacked by order lookup)', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Последние заказы'));
    assert.ok(api.lastTo(999).body.text.includes('TG-9000'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'В сборку TG-9000'));
    assert.equal(api.db.prepare('SELECT status FROM orders WHERE order_code=?').get('TG-9000').status, 'В сборке');
  });

  it('order notification carries status buttons', async () => {
    api.sent.length = 0;
    await api.maxNotifyAdmin('НОВАЯ ЗАЯВКА TG-9000', 'TG-9000');
    assert.ok(JSON.stringify(api.lastTo(999).body.attachments).includes('В сборку TG-9000'));
  });

  it('client lookup returns order + requisites, forwards to admin', async () => {
    await api.handleMaxUpdate(api.upd(555, 'Ivan', 'TG-9000'));
    const m = api.lastTo(555);
    assert.ok(m.body.text.includes('К оплате') && m.body.text.includes('СБП 123'));
    assert.ok(api.lastTo(999).body.text.includes('по заказу TG-9000'));
    await api.handleMaxUpdate(api.upd(555, 'Ivan', 'а есть скидка?'));
    assert.ok(api.lastTo(999).body.text.includes('а есть скидка?'));
  });

  it('cancel resets the wizard session', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Добавить часы'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Отмена'));
    assert.ok(!api.maxSessions.has(999));
  });

  it('admin menu appends shop link button when SHOP_URL is set', async () => {
    process.env.SHOP_URL = 'https://example.com/shop';
    await api.handleMaxUpdate(api.upd(999, 'Admin', '/start'));
    const atts = JSON.stringify(api.lastTo(999).body.attachments);
    assert.ok(atts.includes('Открыть каталог') && atts.includes('https://example.com/shop'));
    delete process.env.SHOP_URL;
  });
});
