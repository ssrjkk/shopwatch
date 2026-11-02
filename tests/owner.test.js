const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { extractOwnerBlock, extractPromoBlock, extractEncodingBlock } = require('./helpers/load');

function loadOwner() {
  const body = `${extractEncodingBlock()}\n${extractPromoBlock()}\n${extractOwnerBlock()}\nreturn { fmtMoney, salesStats, topProducts, topCategories, activePromoCount, lowStock, statsText, historyText, parseDaysArg, parseHistoryArgs, recordBotOpened, findReminderCandidates, cleanupCheckoutEvents, digestText };`;
  return new Function(body)();
}

const stamp = (deltaMs) => new Date(Date.now() + deltaMs).toISOString().slice(0, 19).replace('T', ' ');

function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0, stock INTEGER DEFAULT 4, seed_key TEXT);
  CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, customer_json TEXT, owner_tg TEXT, owner_max TEXT, promo_code TEXT, discount INTEGER DEFAULT 0);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, actor TEXT NOT NULL DEFAULT 'system', entity TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, old_value TEXT, new_value TEXT, source TEXT NOT NULL DEFAULT 'api');
  CREATE TABLE checkout_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tg_id TEXT, cart_json TEXT NOT NULL DEFAULT '[]', total INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'started', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, reminded_at DATETIME, order_code TEXT);`);
  db.prepare('INSERT INTO products (id, brand, series, category, name, price, stock) VALUES (?,?,?,?,?,?,?)').run(1, 'GARMIN', 'fenix', 'Спортивные часы', 'Fenix 8', 60000, 10);
  db.prepare('INSERT INTO products (id, brand, series, category, name, price, stock) VALUES (?,?,?,?,?,?,?)').run(2, 'GARMIN', 'fenix', 'Спортивные часы', 'Fenix 7', 50000, 2);
  db.prepare('INSERT INTO products (id, brand, series, category, name, price, stock) VALUES (?,?,?,?,?,?,?)').run(3, 'GARMIN', 'Descent', 'Дайвинг компьютеры', 'Descent Mk3', 70000, 1);
  const ins = db.prepare('INSERT INTO orders (order_code, items_json, total, status, created_at, owner_tg) VALUES (?,?,?,?,?,?)');
  ins.run('TG-100', JSON.stringify([{ id: 1, name: 'Fenix 8', price: 60000, qty: 2 }, { id: 2, name: 'Fenix 7', price: 50000, qty: 1 }]), 170000, 'Новый', stamp(0), '111');
  ins.run('TG-101', JSON.stringify([{ id: 1, name: 'Fenix 8', price: 60000, qty: 1 }]), 60000, 'Оплачен', stamp(0), null);
  ins.run('TG-102', JSON.stringify([{ id: 3, name: 'Descent Mk3', price: 70000, qty: 1 }]), 70000, 'Оплачен', stamp(-86400000), null);
  ins.run('TG-103', JSON.stringify([{ id: 2, name: 'Fenix 7', price: 50000, qty: 99 }]), 4950000, 'Отменен', stamp(-10 * 86400000), null);
  const au = db.prepare("INSERT INTO audit_log (actor, entity, entity_id, action, old_value, new_value, source) VALUES (?,?,?,?,?,?,?)");
  au.run('tg:1', 'product', '5', 'update', '{"price":100}', '{"price":120}', 'bot');
  au.run('site', 'order', 'TG-100', 'create', null, '{"total":170000}', 'api');
  au.run('tg:1', 'publish', '', 'publish', null, '{"ok":true}', 'bot');
  const ce = db.prepare('INSERT INTO checkout_events (session_id, tg_id, cart_json, total, status, order_code, created_at, updated_at, reminded_at) VALUES (?,?,?,?,?,?,?,?,?)');
  ce.run('order:TG-900', '777', '[]', 0, 'bot_opened', 'TG-900', stamp(-3 * 3600000), stamp(-3 * 3600000), null);
  ce.run('order:TG-100', '111', '[]', 0, 'bot_opened', 'TG-100', stamp(-5 * 3600000), stamp(-5 * 3600000), null);
  ce.run('sess-abc-1234', null, '[{"id":1,"qty":1}]', 60000, 'started', null, stamp(-3600000), stamp(-3600000), null);
  ce.run('order:TG-901', '888', '[]', 0, 'bot_opened', 'TG-901', stamp(-3 * 3600000), stamp(-3 * 3600000), stamp(-3600000));
  ce.run('order:TG-902', '999', '[]', 0, 'bot_opened', 'TG-902', stamp(-40 * 86400000), stamp(-40 * 86400000), null);
  return db;
}

describe('Владелец: статистика, журнал, напоминания', () => {
  let o;
  before(() => { o = loadOwner(); });

  it('salesStats считает заявки, выручку, средний чек и конверсию', () => {
    const db = seedDb();
    const t = o.salesStats(db, 1);
    assert.equal(t.count, 2);
    assert.equal(t.sum, 230000);
    assert.equal(t.paid_count, 1);
    assert.equal(t.paid_sum, 60000);
    assert.equal(t.avg, 115000);
    assert.equal(t.conv, 50);
    const y = o.salesStats(db, 1, 1);
    assert.equal(y.count, 1);
    assert.equal(y.sum, 70000);
    db.close();
  });

  it('topProducts/topCategories агрегируют выручку и режут отменённые', () => {
    const db = seedDb();
    const tops = o.topProducts(db, 30, 5);
    assert.ok(tops.length >= 2);
    assert.equal(tops[0].sum, 180000);
    const w2 = tops.find((t) => t.id === 2);
    assert.equal(w2.qty, 1);
    const cats = o.topCategories(db, 30, 5);
    assert.equal(cats[0].cat, 'Спортивные часы');
    assert.equal(cats[0].sum, 230000);
    db.close();
  });

  it('activePromoCount и lowStock читают базу и настройки', () => {
    const db = seedDb();
    assert.equal(o.activePromoCount('SALE10=10,BRAND20=20:GARMIN'), 2);
    assert.equal(o.activePromoCount('мусор без правил'), 0);
    assert.ok(o.activePromoCount('') > 0);
    const low = o.lowStock(db, 10);
    assert.deepEqual(low.map((p) => p.id), [3, 2]);
    db.close();
  });

  it('statsText и historyText дают готовый текст для бота', () => {
    const db = seedDb();
    const t = o.statsText(db, 1);
    assert.match(t, /Заявки: 2/);
    assert.match(t, /Конверсия в оплату: 50%/);
    assert.match(t, /Топ-5 товаров/);
    const h = o.historyText(db, 15);
    assert.match(h, /tg:1 product#5 update/);
    assert.match(h, /site order#TG-100 create/);
    const hp = o.historyText(db, 15, 'product', '5');
    assert.equal(hp.split('\n').length, 1);
    assert.match(hp, /product#5/);
    db.close();
  });

  it('parseDaysArg/parseHistoryArgs понимают команды владельца', () => {
    assert.equal(o.parseDaysArg('/stats 30'), 30);
    assert.equal(o.parseDaysArg('/stats'), 1);
    assert.equal(o.parseDaysArg('/stats 9999'), 366);
    assert.deepEqual(o.parseHistoryArgs('Журнал товар 45'), { limit: 15, entity: 'product', entityId: '45' });
    assert.deepEqual(o.parseHistoryArgs('/history заказ tg-1176'), { limit: 15, entity: 'order', entityId: 'TG-1176' });
    assert.deepEqual(o.parseHistoryArgs('/history 5'), { limit: 5, entity: '', entityId: '' });
  });

  it('recordBotOpened не плодит дубли одного человека по одной заявке', () => {
    const db = seedDb();
    o.recordBotOpened(db, '555', 'TG-200');
    o.recordBotOpened(db, '555', 'TG-200');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM checkout_events WHERE tg_id='555'").get().c, 1);
    db.close();
  });

  it('findReminderCandidates: только старые bot_opened без свежих заявок', () => {
    const db = seedDb();
    const rows = o.findReminderCandidates(db);
    assert.deepEqual(rows.map((r) => r.tg_id), ['777']);
    db.close();
  });

  it('cleanupCheckoutEvents вычищает старше 30 дней', () => {
    const db = seedDb();
    o.cleanupCheckoutEvents(db);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM checkout_events WHERE tg_id='999'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM checkout_events WHERE tg_id='777'").get().c, 1);
    db.close();
  });

  it('digestText: вчера, остатки, бекап и публикация одной сводкой', () => {
    const db = seedDb();
    const ok = o.digestText(db, { backupAt: new Date().toISOString(), publish: { ok: true } });
    assert.match(ok, /Заявок создано: 1/);
    assert.match(ok, /Заканчиваются:/);
    assert.match(ok, /Бекап: свежий/);
    const bad = o.digestText(db, { backupAt: new Date(Date.now() - 30 * 3600000).toISOString(), publish: { ok: false, error: 'push упал' } });
    assert.match(bad, /СТАРШЕ 26 Ч/);
    assert.match(bad, /ОШИБКА/);
    db.close();
  });
});
