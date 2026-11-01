const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { extractMaxBlock, extractDiscountFns, extractImportBlock, extractAdminBlock, extractEncodingBlock, extractSettingsGuard, extractPromoBlock } = require('./helpers/load');
const { seedKey } = require('../catalog-export.js');

describe('MAX bot (parity with Telegram)', () => {
  let api;
  let memdb;

  before(() => {
    memdb = new DatabaseSync(':memory:');
    memdb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0, seed_key TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, customer_json TEXT, owner_tg TEXT, owner_max TEXT, promo_code TEXT, discount INTEGER DEFAULT 0);`);
    const seed = { payment_details: 'PAY', show_payment: '1', hero_title: 'H', phone: 'P', email: 'E', address: 'A', tg_link: 'T', max_link: 'M', legal_name: 'L', legal_inn: 'I' };
    for (const [k, v] of Object.entries(seed)) memdb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
    memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)').run('GARMIN', 'fēnix', 'Спортивные часы', 'Fenix 8', 60000, 'img', 's');
    memdb.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?,?,?,?,?,?,?)').run('APPLE', 'Apple Watch', 'Спортивные часы', 'Ultra 2', 70000, 'img', 's');
    memdb.prepare('INSERT INTO orders (order_code, items_json, total) VALUES (?,?,?)').run('TG-9000', JSON.stringify([{ name: 'Fenix 8', price: 60000, qty: 1 }]), 60000);

    const prelude = `
const db = memdb;
const defaultSettings = { hero_title: 'H', phone: 'P', email: 'E', address: 'A', tg_link: 'T', max_link: 'M', legal_name: 'L', legal_inn: 'I', legal_ogrnip: 'O', payment_details: 'PAY', show_payment: '1', last_order_num: '1175' };
${extractSettingsGuard()}
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
${extractEncodingBlock()}
${extractDiscountFns()}
${extractImportBlock()}
${extractAdminBlock()}
${extractPromoBlock()}
`;
    const driver = `
;return { handleMaxUpdate, maxNotifyAdmin, maxSessions, db, sent,
  loadMaxAdminExtras, maxAdminIdList, MAX_CFG_BUTTONS, EDITABLE_SETTINGS,
  allTo: (id) => sent.filter((s) => s.url.includes('user_id=' + id)),
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

  it('catalog browser: shelves -> page -> card -> field edit, delete asks confirm', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Товары и цены'));
    const shelvesMsg = api.lastTo(999);
    const totalProducts = api.db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
    assert.ok(shelvesMsg.body.text.includes(`Каталог: ${totalProducts} позиций`), shelvesMsg.body.text);
    assert.ok(JSON.stringify(shelvesMsg.body.attachments).includes('Полка: Все товары'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Полка: Все товары'));
    assert.ok(JSON.stringify(api.lastTo(999).body.attachments).includes('Товар #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Товар #1'));
    const card = JSON.stringify(api.lastTo(999).body.attachments);
    for (const label of ['Цена #1', 'Название #1', 'Полка #1', 'Фото #1', 'Скидка #1', 'Удалить #1']) {
      assert.ok(card.includes(label), `в карточке нет кнопки ${label}`);
    }
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Цена #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', '62000'));
    assert.equal(api.db.prepare('SELECT price FROM products WHERE id=1').get().price, 62000);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Товар #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Название #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Fenix 8 переименован'));
    assert.equal(api.db.prepare('SELECT name FROM products WHERE id=1').get().name, 'Fenix 8 переименован');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Полка #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Квадрокоптеры'));
    assert.match(api.lastTo(999).body.text, /полки нет/i);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'В хиты #1'));
    assert.equal(api.db.prepare('SELECT is_hit FROM products WHERE id=1').get().is_hit, 1);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Скидка #1'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', '20'));
    const discounted = api.db.prepare('SELECT price, old_price FROM products WHERE id=1').get();
    assert.equal(discounted.old_price, 62000);
    assert.equal(discounted.price, 49600);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Удалить #2'));
    assert.ok(api.lastTo(999).body.text.includes('Удалить #2'), 'спрашивает подтверждение');
    assert.ok(api.db.prepare('SELECT * FROM products WHERE id=2').get(), 'до подтверждения товар на месте');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Да, удалить #2'));
    assert.equal(api.db.prepare('SELECT * FROM products WHERE id=2').get(), undefined);
  });

  it('orders browser: filter, card, status change, search, summary', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Последние заказы'));
    const list = api.lastTo(999);
    assert.ok(list.body.text.includes('Заявок: 1'), list.body.text);
    assert.ok(JSON.stringify(list.body.attachments).includes('Заявка TG-9000'));
    assert.ok(JSON.stringify(list.body.attachments).includes('Заказы: Все'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Заявка TG-9000'));
    const card = String(api.lastTo(999).body.text).replace(/[  ]/g, ' ');
    assert.match(card, /ЗАЯВКА TG-9000/);
    assert.match(card, /Fenix 8 × 1 = 60 000 ₽/s);
    assert.ok(JSON.stringify(api.lastTo(999).body.attachments).includes('Оплачен TG-9000'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Оплачен TG-9000'));
    assert.equal(api.db.prepare("SELECT status FROM orders WHERE order_code='TG-9000'").get().status, 'Оплачен');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Заказы: Оплачен'));
    assert.ok(api.lastTo(999).body.text.includes('со статусом «Оплачен»'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Заказы: Все'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Найти заявку'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'tg-9000'));
    assert.ok(api.lastTo(999).body.text.includes('поиск «tg-9000»'), api.lastTo(999).body.text);
    assert.ok(api.lastTo(999).body.text.includes('Заявок: 1'), 'найден по номеру независимо от регистра');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Найти заявку'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'нет такого'));
    assert.match(api.lastTo(999).body.text, /Заявок: 0/);
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Сводка сайта'));
    assert.match(api.lastTo(999).body.text, /Товаров: \d+ · хитов: \d+/);
    assert.match(api.lastTo(999).body.text, /Заявок: 1/);
  });

  it('MAX: отчёт по картинкам и удаление заявки с подтверждением', async () => {
    api.db.prepare("INSERT INTO orders (order_code, items_json, total, status) VALUES (?,?,?,?)")
      .run('TG-9111', JSON.stringify([{ name: 'Suunto Vyper', price: 38900, qty: 1 }]), 38900, 'Новый');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Фото на стоках'));
    assert.match(api.lastTo(999).body.text, /Картинки каталога/);
    assert.match(api.lastTo(999).body.text, /Всего позиций: \d+/);

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Заявка TG-9111'));
    assert.ok(JSON.stringify(api.lastTo(999).body.attachments).includes('Удалить TG-9111'), 'в карточке есть кнопка удаления');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Удалить TG-9111'));
    assert.match(api.lastTo(999).body.text, /Удалить заявку TG-9111/);
    assert.ok(api.db.prepare("SELECT * FROM orders WHERE order_code='TG-9111'").get(), 'до подтверждения заявка на месте');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Да, удалить TG-9111'));
    assert.equal(api.db.prepare("SELECT * FROM orders WHERE order_code='TG-9111'").get(), undefined);
    assert.ok(api.db.prepare("SELECT * FROM orders WHERE order_code='TG-9000'").get(), 'остальные заявки не тронуты');
  });

  it('настройка last_order_num из бота не перезаписывается', async () => {
    const read = () => (api.db.prepare("SELECT value FROM settings WHERE key='last_order_num'").get() || {}).value ?? '';
    const before = read();
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Тексты и контакты'));
    const kb = JSON.stringify(api.lastTo(999).body.attachments);
    assert.ok(!kb.includes('last_order_num'), 'служебного ключа нет среди кнопок');
    // прямая попытка подменить служебный ключ через шаг wait_cfg отбивается
    // ключ сессии — строка: MAX отдаёт user_id как текст, и Map различает 999 и '999'
    api.maxSessions.set('999', { step: 'wait_cfg', key: 'last_order_num' });
    await api.handleMaxUpdate(api.upd(999, 'Admin', '999999'));
    assert.match(api.lastTo(999).body.text, /не меняется/);
    assert.equal(api.maxSessions.has('999'), false, 'шаг после отказа закрывается');
    assert.equal(read(), before);
  });

  it('bulk import: preview first, writes only after the confirm button', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Импорт товаров'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'COROS;Pace;Спортивные часы;COROS Pace 11;24990\nDJI;;Квадрокоптеры;DJI Avata;40000'));
    const preview = api.lastTo(999).body.text;
    assert.match(preview, /Новых позиций: 1/);
    assert.match(preview, /категории «Квадрокоптеры» нет/);
    assert.equal(api.db.prepare("SELECT COUNT(*) AS c FROM products WHERE name='COROS Pace 11'").get().c, 0, 'до подтверждения не пишет');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Записать 1'));
    assert.equal(api.db.prepare("SELECT COUNT(*) AS c FROM products WHERE name='COROS Pace 11'").get().c, 1);
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

  it('права админа: экран «Тексты и контакты» покрывает все настраиваемые поля', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Тексты и контакты'));
    const kb = JSON.stringify(api.lastTo(999).body.attachments);
    const labels = Object.keys(api.MAX_CFG_BUTTONS);
    assert.ok(labels.length >= 9, `настроечных полей: ${labels.length}`);
    for (const label of labels) assert.ok(kb.includes(label), `на экране нет кнопки «${label}»`);
    const covered = new Set(Object.values(api.MAX_CFG_BUTTONS));
    for (const key of api.EDITABLE_SETTINGS) {
      assert.ok(covered.has(key) || key === 'payment_details' || key === 'show_payment', `ключ ${key} не открывается ни одним экраном`);
    }
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'ОГРНИП'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', '304362725400111'));
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='legal_ogrnip'").get().value, '304362725400111');
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
    assert.ok(!api.maxSessions.has('999') && !api.maxSessions.has(999));
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

  it('админы MAX: экран, добавление по ID, отзыв и запрет трогать .env', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Админы'));
    const roster = api.lastTo(999);
    assert.match(roster.body.text, /Админы MAX \(1\)/);
    assert.match(roster.body.text, /ID 999 — из \.env/);
    assert.ok(JSON.stringify(roster.body.attachments).includes('Добавить по ID'), 'кнопка добавления есть');

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Убрать ID 999'));
    assert.match(api.lastTo(999).body.text, /правкой \.env/);
    assert.ok(api.maxAdminIdList().includes('999'), 'админа из .env бота не убирается');

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Добавить по ID'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'не число'));
    assert.match(api.lastTo(999).body.text, /цифр/, 'мусор не становится админом');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Добавить по ID'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', '777'));
    assert.match(api.lastTo(999).body.text, /Добавили/);
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='max_extra_admin_ids'").get().value, '777');

    await api.handleMaxUpdate(api.upd(777, 'Second', '/start'));
    assert.match(api.lastTo(777).body.text, /Админ-панель Watchop \(MAX\)/, 'новый админ получает меню');

    const before999 = api.allTo(999).length;
    const before777 = api.allTo(777).length;
    await api.handleMaxUpdate(api.upd(555, 'Ivan', 'здравствуйте'));
    assert.equal(api.allTo(999).length, before999 + 1, 'первый админ получил уведомление');
    assert.equal(api.allTo(777).length, before777 + 1, 'второй админ получил то же уведомление');

    await api.handleMaxUpdate(api.upd(777, 'Second', 'Убрать ID 777'));
    assert.match(api.lastTo(777).body.text, /Убрали ID 777/);
    assert.equal(api.maxAdminIdList().includes('777'), false);
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='max_extra_admin_ids'").get().value, '');
    await api.handleMaxUpdate(api.upd(777, 'Second', 'Товары и цены'));
    assert.match(api.lastTo(777).body.text, /Здравствуйте/, 'отозванный возвращается в режим клиента');
  });

  it('админы MAX переживают рестарт: список догружается из настроек', () => {
    api.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('max_extra_admin_ids', '888')").run();
    api.loadMaxAdminExtras();
    assert.ok(api.maxAdminIdList().includes('888'));
  });

  it('кнопка «Админы» прерывает ввод реквизитов, а не уезжает в него', async () => {
    const payBefore = api.db.prepare("SELECT value FROM settings WHERE key='payment_details'").get().value;
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Реквизиты оплаты'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Изменить реквизиты'));
    assert.ok(api.maxSessions.has('999'), 'шаг ввода реквизитов открыт');
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Админы'));
    assert.match(api.lastTo(999).body.text, /Админы MAX \(/);
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='payment_details'").get().value, payBefore, 'реквизиты не перезаписаны нажатием кнопки');
    assert.ok(!api.maxSessions.has('999') && !api.maxSessions.has(999));
  });

  it('промокоды в MAX: список, добавление, отзыв и отказ на мусоре', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Промокоды'));
    const list = api.lastTo(999).body.text.replace(/[\u00A0\u202F]/g, ' ');
    assert.match(list, /Промокоды витрины \(3\)/);
    assert.match(list, /• WATCH10 — −10%/);
    assert.match(list, /• VIP15 — −15% \(от 50 000 ₽\)/);
    assert.ok(JSON.stringify(api.lastTo(999).body.attachments).includes('Добавить промокод'), 'кнопка добавления на экране');

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Добавить промокод'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'SALE7 7'));
    assert.match(api.lastTo(999).body.text, /SALE7 сохранён/);
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='promo_codes'").get().value.includes('SALE7=7'), true);

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Промокоды'));
    assert.match(api.lastTo(999).body.text, /• SALE7 — −7%/);

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Убрать промокод'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'SALE7'));
    assert.match(api.lastTo(999).body.text, /SALE7 убран/);
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='promo_codes'").get().value.includes('SALE7'), false);

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Добавить промокод'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'BADCODE 500'));
    assert.match(api.lastTo(999).body.text, /от 1 до 90%/, 'процент за пределом отсекается с текстом');
    assert.equal(api.db.prepare("SELECT value FROM settings WHERE key='promo_codes'").get().value.includes('BADCODE'), false);

    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Убрать промокод'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'НЕТТАКОГО'));
    assert.match(api.lastTo(999).body.text, /нет/i, 'отзыв несуществующего кода — отказ, а не тихая ошибка');
  });

  it('кнопка «Промокоды» прерывает ввод, а не уезжает в него', async () => {
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Реквизиты оплаты'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Изменить реквизиты'));
    assert.ok(api.maxSessions.has('999'));
    await api.handleMaxUpdate(api.upd(999, 'Admin', 'Промокоды'));
    assert.match(api.lastTo(999).body.text, /Промокоды витрины/);
    assert.ok(!api.maxSessions.has('999') && !api.maxSessions.has(999), 'шаг закрыт');
  });
});
