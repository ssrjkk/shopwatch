const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { extractImportBlock, extractAdminBlock, extractEncodingBlock, extractSettingsGuard } = require('./helpers/load');
const { seedKey } = require('../catalog-export.js');

// Админка сидит рядом с импортом и пользуется его проверкой полок, поэтому
// в тесте поднимаем оба блока вместе — ровно как в server.js. Блок кодировки
// нужен, потому что правка поля чистит текст тем же cleanText.
const api = new Function('seedKey', `${extractEncodingBlock()}\n${extractImportBlock()}\n${extractAdminBlock()}
return { ADMIN_PAGE, ADMIN_ORDER_PAGE, ORDER_STATUS_SET, catalogShelves, catalogPage, productById, productCardText, setProductField, toggleProductHit, deleteProductById, orderStatusBreakdown, ordersPage, orderCardText, setOrderStatus, adminSummary, stockPhotoReport, deleteOrderByCode };`)(seedKey);

// toLocaleString('ru-RU') вставляет неразрывные пробелы — сравнения нормализуем
const flat = (s) => String(s).replace(/[  ]/g, ' ');

function memdb() {  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0, stock INTEGER DEFAULT 4, seed_key TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE, items_json TEXT, total INTEGER, status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, customer_json TEXT, owner_tg TEXT, promo_code TEXT, discount INTEGER DEFAULT 0);`);
  const ins = db.prepare('INSERT INTO products (brand, series, category, name, price, old_price, image, specs, is_hit, seed_key) VALUES (?,?,?,?,?,?,?,?,?,?)');
  [
    ['GARMIN', 'fenix', 'Спортивные часы', 'Garmin Fenix 8 43 мм', 58990, 0, 'https://images.unsplash.com/photo-A?w=600&q=80', 'AMOLED, титан', 1],
    ['GARMIN', 'Forerunner', 'Спортивные часы', 'Garmin Forerunner 970', 41200, 49000, 'https://images.unsplash.com/photo-A?w=600&q=80', 'бег, карты', 0],
    ['DEEPSON', 'STRIKER', 'Эхолоты', 'Deeper CHIRP 3', 34900, 0, 'https://upload.wikimedia.org/wikipedia/commons/deeper.jpg', 'эхолот с сети', 0],
    ['SUUNTO', 'Suunto', 'Дайвинг компьютеры', 'Suunto Vyper', 38900, 0, 'https://images.unsplash.com/photo-B?w=600&q=80', 'ноиток', 0],
  ].forEach((r, i) => ins.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], seedKey({ brand: r[0], series: r[1], category: r[2], name: r[3] }) + i));
  db.prepare(`INSERT INTO orders (order_code, items_json, total, status, customer_json) VALUES
    ('TG-1001','[{"name":"Garmin Fenix 8 43 мм","price":58990,"qty":1}]',58990,'Новый','{"fio":"Иванов Иван","phone":"+7 900 111-22-33","delivery":"СДЭК"}'),
    ('TG-1002','[{"name":"Deeper CHIRP 3","price":34900,"qty":2}]',69800,'Оплачен','{"fio":"Петров П","phone":"+7 900 555-66-77"}'),
    ('TG-1003','[]',0,'Trade-In','{}')`).run();
  return db;
}

describe('Админка: каталог', () => {
  let db;
  beforeEach(() => { db = memdb(); });

  it('полки считают позиции и дают итог по всем', () => {
    const shelves = api.catalogShelves(db);
    assert.equal(shelves[0].category, 'Все товары');
    assert.equal(shelves[0].count, 4);
    assert.ok(shelves.some((s) => s.category === 'Спортивные часы' && s.count === 2));
    assert.ok(shelves.some((s) => s.category === 'Эхолоты' && s.count === 1));
  });

  it('страница каталога фильтрует по полке и ищет без учёта регистра', () => {
    const watches = api.catalogPage(db, { category: 'Спортивные часы' });
    assert.equal(watches.total, 2);
    assert.ok(watches.items.every((p) => p.category === 'Спортивные часы'));
    const byName = api.catalogPage(db, { query: 'FENIX' });
    assert.equal(byName.items.length, 1);
    assert.equal(byName.items[0].name, 'Garmin Fenix 8 43 мм');
    const bySpecs = api.catalogPage(db, { query: 'ноиток' });
    assert.equal(bySpecs.items[0].brand, 'SUUNTO');
    // регистр по-русски тоже должен работать: SQLite LOWER() кириллицу не трогает
    assert.equal(api.catalogPage(db, { query: 'ЭХОЛОТ С СЕТИ' }).total, 1);
    assert.equal(api.catalogPage(db, { query: 'FENIX' }).total, 1);
    const byShelfAndQuery = api.catalogPage(db, { category: 'Эхолоты', query: 'CHIRP' });
    assert.equal(byShelfAndQuery.total, 1);
    assert.equal(api.catalogPage(db, { query: 'нет такого' }).total, 0);
  });

  it('пагинация режет страницу и не выпускает за последний лист', () => {
    const p1 = api.catalogPage(db, { page: 1 });
    assert.equal(p1.pages, 1);
    assert.equal(p1.items.length, 4);
    const many = new DatabaseSync(':memory:');
    many.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, series TEXT, category TEXT, name TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT, specs TEXT, is_hit INTEGER DEFAULT 0, stock INTEGER DEFAULT 4, seed_key TEXT);`);
    const ins = many.prepare('INSERT INTO products (brand, category, name, price) VALUES (?,?,?,?)');
    for (let i = 0; i < 20; i++) ins.run('BR', 'Аксессуары', `Позиция ${i}`, 1000 + i);
    const page2 = api.catalogPage(many, { page: 2 });
    assert.equal(page2.pages, Math.ceil(20 / api.ADMIN_PAGE));
    assert.equal(page2.items.length, api.ADMIN_PAGE);
    assert.equal(page2.page, 2);
    assert.equal(api.catalogPage(many, { page: 999 }).page, page2.pages, 'просьба дальше конца — последняя страница');
    assert.equal(api.catalogPage(many, { page: -5 }).page, 1);
    many.close();
  });

  it('карточка товара показывает цену, уценку, хит и фото', () => {
    const text = api.productCardText(api.productById(db, 2));
    assert.match(text, /#2 Garmin Forerunner 970/);
    assert.match(flat(text), /41 200 ₽.*до уценки 49 000 ₽/s);
    assert.match(text, /Хит: нет/);
    assert.match(flat(api.productCardText(api.productById(db, 1))), /Хит: да/);
    assert.equal(api.productCardText(api.productById(db, 777)), null);
  });

  it('правка поля проверяет значение и сохраняет валидное', () => {
    assert.equal(api.setProductField(db, 1, 'name', 'Garmin Fenix 8 43 мм Solar').row.name, 'Garmin Fenix 8 43 мм Solar');
    assert.equal(api.setProductField(db, 1, 'name', 'аи').ok, false);
    assert.equal(api.setProductField(db, 1, 'price', '58 990 ₽').row.price, 58990);
    assert.equal(api.setProductField(db, 1, 'price', 'дорого').ok, false);
    assert.equal(api.setProductField(db, 1, 'category', 'эхолоты').row.category, 'Эхолоты');
    const badCat = api.setProductField(db, 1, 'category', 'Квадрокоптеры');
    assert.equal(badCat.ok, false);
    assert.match(badCat.error, /полки нет/);
    assert.equal(api.setProductField(db, 1, 'image', 'https://img/new.jpg').row.image, 'https://img/new.jpg');
    assert.equal(api.setProductField(db, 1, 'image', 'C:\\pics\\a.jpg').ok, false);
    assert.equal(api.setProductField(db, 1, 'image', '').row.image, '');
    assert.equal(api.setProductField(db, 1, 'specs', 'сапфир').row.specs, 'сапфир');
    assert.equal(api.setProductField(db, 1, 'series', 'fenix pro').row.series, 'fenix pro');
    assert.equal(api.setProductField(db, 1, 'password', 'x').ok, false);
    assert.equal(api.setProductField(db, 999, 'name', 'нет такого').ok, false);
  });

  it('хит переключается, товар удаляется', () => {
    assert.equal(api.toggleProductHit(db, 2).hit, 1);
    assert.equal(api.productById(db, 2).is_hit, 1);
    assert.equal(api.toggleProductHit(db, 2).hit, 0);
    assert.equal(api.toggleProductHit(db, 999).ok, false);
    const del = api.deleteProductById(db, 4);
    assert.equal(del.ok, true);
    assert.equal(del.name, 'Suunto Vyper');
    assert.equal(api.catalogShelves(db)[0].count, 3);
    assert.equal(api.deleteProductById(db, 4).ok, false);
  });
});

describe('Админка: заказы', () => {
  let db;
  beforeEach(() => { db = memdb(); });

  it('список фильтруется по статусу и ищется по коду и клиенту', () => {
    assert.equal(api.ordersPage(db, {}).total, 3);
    assert.equal(api.ordersPage(db, { status: 'Оплачен' }).items[0].order_code, 'TG-1002');
    assert.equal(api.ordersPage(db, { query: 'tg-1001' }).items[0].order_code, 'TG-1001');
    assert.equal(api.ordersPage(db, { query: 'иванов' }).total, 1);
    assert.equal(api.ordersPage(db, { query: 'ИВАНОВ' }).total, 1);
    assert.equal(api.ordersPage(db, { query: 'СДЭК' }).total, 1);
    assert.equal(api.ordersPage(db, { query: 'нет' }).total, 0);
  });

  it('карточка заявки собирает состав, сумму и данные клиента', () => {
    const text = flat(api.orderCardText(db, 'tg-1001'));
    assert.match(text, /ЗАЯВКА TG-1001 — Новый/);
    assert.match(text, /1\. Garmin Fenix 8 43 мм × 1 = 58 990 ₽/);
    assert.match(text, /Итого: 58 990 ₽/);
    assert.match(text, /Клиент: Иванов Иван · \+7 900 111-22-33/);
    assert.match(text, /Доставка: СДЭК/);
    assert.equal(api.orderCardText(db, 'TG-9999'), null);
  });

  it('карточка заявки показывает промокод и скидку', () => {
    db.prepare('INSERT INTO orders (order_code, items_json, total, status, promo_code, discount) VALUES (?,?,?,?,?,?)')
      .run('TG-1004', '[{"name":"Garmin Fenix 8 43 мм","price":58990,"qty":1}]', 52990, 'Новый', 'WATCH10', 6000);
    const text = flat(api.orderCardText(db, 'TG-1004'));
    assert.match(text, /Итого: 52 990 ₽/, 'админ видит сумму после скидки');
    assert.match(text, /Промокод WATCH10: −6 000 ₽/);

    db.prepare('INSERT INTO orders (order_code, items_json, total, status, promo_code, discount) VALUES (?,?,?,?,?,?)')
      .run('TG-1005', '[]', 34900, 'Новый', 'VIP15', 0);
    assert.match(flat(api.orderCardText(db, 'TG-1005')), /Промокод VIP15: скидка 0 ₽ \(условия не выполнены\)/, 'код без скидки не выглядит применённым');

    assert.equal(flat(api.orderCardText(db, 'TG-1001')).includes('Промокод'), false, 'без кода лишней строки в карточке нет');
  });

  it('статус меняется только на известный и только у существующей заявки', () => {
    assert.deepEqual(api.setOrderStatus(db, 'TG-1001', 'В сборке'), { ok: true, code: 'TG-1001', status: 'В сборке' });
    assert.equal(api.orderCardText(db, 'TG-1001').includes('В сборке'), true);
    const bad = api.setOrderStatus(db, 'TG-1001', 'Отдано');
    assert.equal(bad.ok, false);
    for (const s of api.ORDER_STATUS_SET) assert.equal(api.setOrderStatus(db, 'TG-1003', s).ok, true, s);
    assert.equal(api.setOrderStatus(db, 'TG-7777', 'Оплачен').ok, false);
  });

  it('разбивка по статусам считает заявки', () => {
    const map = Object.fromEntries(api.orderStatusBreakdown(db).map((s) => [s.status, s.count]));
    assert.equal(map['Новый'], 1);
    assert.equal(map['Оплачен'], 1);
    assert.equal(map['Trade-In'], 1);
  });
});

describe('Админка: сводка', () => {
  it('сводка считает товары, полки, заявки и выручку', () => {
    const text = flat(api.adminSummary(memdb(), { show_payment: '1' }));
    assert.match(text, /Товаров: 4 · хитов: 1 · со скидкой: 1/);
    assert.match(text, /Спортивные часы — 2/);
    assert.match(text, /Заявок: 3 · за 7 дней: 3 · ждут действия: 2/);
    assert.match(text, /Оплачен — 1/);
    assert.match(text, /Оплачено на сумму: 69 800 ₽/);
    assert.match(text, /Реквизиты на сайте: показаны/);
    assert.match(flat(api.adminSummary(memdb(), { show_payment: '0' })), /Реквизиты на сайте: скрыты/);
  });
});

describe('Админка: картинки и удаление заявок', () => {
  it('отчёт по фото считает хосты, повторы и свои снимки', () => {
    const db = memdb();
    db.prepare('INSERT INTO products (brand, category, name, price, image) VALUES (?,?,?,?,?)')
      .run('APPLE', 'Спортивные часы', 'Своё фото', 9000, '/uploads/watch_1.jpg');
    const text = api.stockPhotoReport(db);
    assert.match(text, /Всего позиций: 5 · своих \(загружено в админку\): 1/);
    assert.match(text, /images\.unsplash\.com — 3/);
    assert.match(text, /upload\.wikimedia\.org — 1/);
    assert.match(text, /Повторов: 1 картинок/);
    assert.match(text, /2× photo-A/);
  });

  it('отчёт на каталоге без своих фото говорит это прямо', () => {
    const text = api.stockPhotoReport(memdb());
    assert.match(text, /своих \(загружено в админку\): 0/);
    assert.match(text, /Ни одного реального фото товара/);
  });

  it('заявка удаляется по номеру, чужой номер не трогается', () => {
    const db = memdb();
    const res = api.deleteOrderByCode(db, 'tg-1002');
    assert.equal(res.ok, true);
    assert.equal(res.code, 'TG-1002');
    assert.equal(res.status, 'Оплачен');
    assert.equal(api.ordersPage(db, {}).total, 2);
    assert.equal(api.deleteOrderByCode(db, 'TG-7777').ok, false);
    assert.equal(api.orderCardText(db, 'TG-1002'), null);
  });
});

describe('Админка: что можно переписывать в настройках', () => {
  const guard = new Function('defaultSettings', `${extractSettingsGuard()}\nreturn { EDITABLE_SETTINGS, isEditableSetting };`)({
    hero_title: 'h', phone: 'p', email: 'e', address: 'a', tg_link: 't', max_link: 'm',
    legal_name: 'n', legal_inn: 'i', legal_ogrnip: 'o', payment_details: 'd', show_payment: '1',
    last_order_num: '1175',
  });

  it('публичные настройки доступны, служебный счётчик номеров — нет', () => {
    for (const k of ['hero_title', 'phone', 'email', 'address', 'tg_link', 'max_link', 'legal_name', 'legal_inn', 'legal_ogrnip', 'payment_details', 'show_payment']) {
      assert.equal(guard.isEditableSetting(k), true, k);
    }
    assert.equal(guard.isEditableSetting('last_order_num'), false);
    assert.equal(guard.isEditableSetting('whatever'), false);
    assert.equal(guard.isEditableSetting(''), false);
    assert.equal(guard.isEditableSetting(null), false);
  });
});

describe('Админка: заявки на связь', () => {
  it('звонок и оценка Trade-In видны в фильтре и считаются в «ждут действия»', () => {
    const db = memdb();
    for (const s of ['Заявка на звонок', 'Оценка Trade-In']) {
      assert.ok(api.ORDER_STATUS_SET.includes(s), `${s} нет в словаре статусов — фильтр админки её не покажет`);
    }
    const mk = (code, status, fio, phone) => db
      .prepare('INSERT INTO orders (order_code, items_json, total, status, customer_json) VALUES (?, ?, 0, ?, ?)')
      .run(code, JSON.stringify([{ id: 0, name: 'Заявка на связь', price: 0, qty: 1 }]), status, JSON.stringify({ fio, phone }));
    mk('TG-1900', 'Заявка на звонок', 'Мария', '+7 900 000-11-22');
    mk('TG-1901', 'Оценка Trade-In', 'Иван', '+7 900 000-33-44');
    assert.deepEqual(api.ordersPage(db, { status: 'Заявка на звонок' }).items.map((r) => r.order_code), ['TG-1900']);
    assert.deepEqual(api.ordersPage(db, { status: 'Оценка Trade-In' }).items.map((r) => r.order_code), ['TG-1901']);
    // в memdb три заявки, две из них ждут действия — обе заявки на связь добавляются к ним
    assert.match(flat(api.adminSummary(db, { show_payment: '0' })), /Заявок: 5 · за 7 дней: 5 · ждут действия: 4/);
  });
});
