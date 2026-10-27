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
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, owner_tg TEXT, owner_max TEXT);`);
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
const catalogFromDb = () => db.prepare('SELECT * FROM products ORDER BY id ASC').all().map((r) => ({ id: Number(r.id), brand: r.brand, series: r.series, category: r.category, name: r.name, price: Number(r.price), image: r.image, specs: r.specs, hit: Number(r.is_hit || 0) }));
const fileCatalog = () => catalogFromDb().slice(0, -1);
function diffCatalog(f, d) {
  const k = (p) => [p.brand, p.series, p.category, p.name, p.price].join('|');
  const fk = new Set(f.map(k)), dk = new Set(d.map(k));
  return { fileCount: f.length, dbCount: d.length, onlyInDb: d.filter((p) => !fk.has(k(p))), onlyInFile: f.filter((p) => !dk.has(k(p))) };
}
function summarizeDiff(d) { return \`В базе: \${d.dbCount}, в файле: \${d.fileCount}.\nНовых в базе (попадут в файл): \${d.onlyInDb.length}.\`; }
const exportCalls = [];
function exportCatalog(force) {
  const rows = catalogFromDb(), cur = fileCatalog();
  exportCalls.push({ force, rows: rows.length });
  return { blocked: false, diff: diffCatalog(cur, rows), written: ['products-data.js', 'public/products-data.js'], failed: [], rows: rows.length };
}
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

  it('order status buttons work only for the admin', async () => {
    api.db.prepare("UPDATE orders SET status = 'Новый' WHERE order_code = 'TG-9000'").run();
    await api.handleMaxUpdate(api.upd(555, 'Ivan', 'Оплачен TG-9000'));
    assert.equal(api.db.prepare('SELECT status FROM orders WHERE order_code=?').get('TG-9000').status, 'Новый', 'клиент статус не меняет');
    assert.match(api.lastTo(555).body.text, /только администратор/);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Оплачен TG-9000'));
    assert.equal(api.db.prepare('SELECT status FROM orders WHERE order_code=?').get('TG-9000').status, 'Оплачен');
  });

  it('order details are shown to the owner and the admin only', async () => {
    api.db.prepare('UPDATE orders SET owner_max = ? WHERE order_code = ?').run('444', 'TG-9000');
    await api.handleMaxUpdate(api.upd(555, 'Ivan', 'TG-9000'));
    assert.match(api.lastTo(555).body.text, /другим покупателем/);
    assert.equal(api.lastTo(555).body.text.includes('СБП 123'), false, 'реквизиты чужому не отдаём');
    await api.handleMaxUpdate(api.upd(444, 'Vera', 'TG-9000'));
    assert.match(api.lastTo(444).body.text, /К оплате/);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'TG-9000'));
    assert.match(api.lastTo(999).body.text, /К оплате/);
    api.db.prepare("UPDATE orders SET owner_max = NULL WHERE order_code = 'TG-9000'").run();
  });

  it('экспорт каталога: превью из меню, затем подтверждение', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', '/start'));
    assert.ok(JSON.stringify(api.lastTo(999).body.attachments).includes('Экспорт каталога'), 'кнопка в админ-меню');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Экспорт каталога'));
    const preview = api.lastTo(999);
    assert.match(preview.body.text, /Выгрузка каталога/);
    assert.match(preview.body.text, /Новых в базе \(попадут в файл\): 1/);
    assert.ok(JSON.stringify(preview.body.attachments).includes('Подтвердить экспорт'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Подтвердить экспорт'));
    assert.match(api.lastTo(999).body.text, /записано \d+ позиций/);
  });
});
