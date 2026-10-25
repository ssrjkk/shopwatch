require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const DatabaseSync = require('node:sqlite').DatabaseSync;
const { Telegraf, Markup, session } = require('telegraf');

const app = express();
app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.static(publicDir));

function isValidEnv(val) {
  return val && typeof val === 'string' && val.trim() !== '' && !val.startsWith('ВСТАВЬ_');
}

// URL мини-приложения (Telegram Mini App), открывается кнопкой web_app в боте.
// Задается в .env: WEBAPP_URL=https://<твой-домен> (нужен публичный HTTPS).
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim();

function verifyTelegramInitData(initData) {
  // Проверка подписи https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
  // Возвращает объект user из Mini App или null. Используется в тестах и в POST /api/order.
  if (!initData || !isValidEnv(process.env.TG_BOT_TOKEN)) return null;
  try {
    const crypto = require('crypto');
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calc !== hash) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch (e) {
    return null;
  }
}

// ---------- DB ----------
const db = new DatabaseSync('watchop.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT, series TEXT, category TEXT, name TEXT,
    price INTEGER, image TEXT, specs TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT UNIQUE, items_json TEXT, total INTEGER,
    status TEXT DEFAULT 'Новый', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const defaultSettings = {
  hero_title: 'Магазин оригинальной продукции Garmin и смарт-часов — поможем выбрать под ваши задачи',
  phone: '+7 (473) 300-40-95',
  email: 'watchopp@gmail.com',
  address: 'г. Воронеж, ул. Пушкинская, 8 (ТЦ «Аксиома home»)',
  tg_link: 'https://t.me/watchop_manager',
  max_link: 'https://max.ru/watchop',
  legal_name: 'ИП Жукова Татьяна Юрьевна',
  legal_inn: '362703988401',
  legal_ogrnip: '304362725400110',
  payment_details: 'СБП / Т-Банк / Сбер: +7 (900) 000-00-00 (Татьяна Ю.)\nВ комментарии к переводу укажите номер заказа.',
  show_payment: '1',
  last_order_num: '1175'
};

const initSettingStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultSettings)) initSettingStmt.run(k, v);

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));

if (db.prepare('SELECT COUNT(*) as c FROM products').get().c === 0) {
  const seed = [
    { brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Garmin Fenix 8 — 51 мм Solar Sapphire Carbon Grey DLC', price: 62320, image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=600&q=80', specs: 'Сапфир + солнечная зарядка, фонарик LED, дайвинг 40 м, топокарты.' },
    { brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Garmin Fenix 8 — 51 мм AMOLED Sapphire Titanium Orange', price: 62320, image: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600&q=80', specs: 'AMOLED 1.4", титан, дайвинг 40 м, мульти-GNSS.' },
    { brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Garmin Fenix 7X Pro Sapphire Solar Titanium', price: 58990, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'Фонарик, solar, 37 дней в смарт-режиме.' },
    { brand: 'GARMIN', series: 'Forerunner', category: 'Спортивные часы', name: 'Garmin Forerunner 970 Carbon Grey DLC Titanium', price: 41200, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'AMOLED, титан, двухчастотный GPS, карты.' },
    { brand: 'GARMIN', series: 'Forerunner', category: 'Спортивные часы', name: 'Garmin Forerunner 570 — 47 мм Slate Grey / Black', price: 31210, image: 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=600&q=80', specs: 'Беговые метрики, Garmin Pay, музыка.' },
    { brand: 'GARMIN', series: 'Forerunner', category: 'Спортивные часы', name: 'Garmin Forerunner 265 Black AMOLED', price: 34990, image: 'https://images.unsplash.com/photo-1434493789847-2f02dc6ca35d?w=600&q=80', specs: 'AMOLED, Training Readiness, 20 дней.' },
    { brand: 'GARMIN', series: 'Forerunner', category: 'Спортивные часы', name: 'Garmin Forerunner 965 Titanium Yellow', price: 45990, image: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600&q=80', specs: 'Титан, AMOLED, полные карты.' },
    { brand: 'GARMIN', series: 'Descent', category: 'Дайвинг компьютеры', name: 'Дайвинг компьютер Garmin Descent Mk3i 51 мм Carbon Grey', price: 125350, image: 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=600&q=80', specs: 'SubWave сонар, 200 м, AMOLED.' },
    { brand: 'GARMIN', series: 'Descent', category: 'Дайвинг компьютеры', name: 'Дайвинг компьютер Garmin Descent Mk3 43 мм Stainless', price: 95890, image: 'https://images.unsplash.com/photo-1544117519-31a4b719223d?w=600&q=80', specs: 'Погружение 200 м, мульти-GNSS.' },
    { brand: 'GARMIN', series: 'Descent', category: 'Дайвинг компьютеры', name: 'Garmin Descent X50i Large Format', price: 91770, image: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600&q=80', specs: 'Большой формат для технодайвинга.' },
    { brand: 'GARMIN', series: 'Instinct', category: 'Спортивные часы', name: 'Garmin Instinct 3 — 50 мм AMOLED Tactical Black', price: 38900, image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=600&q=80', specs: 'MIL-STD-810, тактический режим.' },
    { brand: 'GARMIN', series: 'Instinct', category: 'Спортивные часы', name: 'Garmin Instinct 2X Solar Tactical Tan', price: 32990, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'Solar, бесконечная работа в эконом-режиме.' },
    { brand: 'GARMIN', series: 'Venu', category: 'Спортивные часы', name: 'Garmin Venu 3 — 45 мм Slate / Black', price: 36400, image: 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=600&q=80', specs: 'Сон, звонки с запястья, 30+ профилей.' },
    { brand: 'GARMIN', series: 'MARQ', category: 'Спортивные часы', name: 'Garmin MARQ Athlete (Gen 2) — Carbon Edition', price: 215000, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'Кованый карбон 130 слоев, сапфир.' },
    { brand: 'GARMIN', series: 'vívoactive', category: 'Фитнес-трекеры', name: 'Garmin vivoactive 5 Metallic Navy', price: 24900, image: 'https://images.unsplash.com/photo-1434493789847-2f02dc6ca35d?w=600&q=80', specs: 'AMOLED, Body Battery, 11 дней.' },
    { brand: 'GARMIN', series: 'Lily', category: 'Фитнес-трекеры', name: 'Garmin Lily 2 Active Lunar Gold / Bone', price: 27500, image: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600&q=80', specs: 'Компактные женские, скрытый дисплей.' },
    { brand: 'GARMIN', series: 'tactix', category: 'Спортивные часы', name: 'Garmin tactix 7 AMOLED Ballistics Titanium', price: 108900, image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=600&q=80', specs: 'Баллистика Applied Ballistics, NVG.' },
    { brand: 'GARMIN', series: 'epix', category: 'Спортивные часы', name: 'Garmin Epix Pro Gen 2 51 мм Sapphire Carbon', price: 79990, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'AMOLED, фонарик, топокарты.' },
    { brand: 'GARMIN', series: 'Enduro', category: 'Спортивные часы', name: 'Garmin Enduro 3 Solar Black', price: 69990, image: 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=600&q=80', specs: 'Ультра-автономность 90 дней solar.' },
    { brand: 'APPLE', series: 'Apple Watch', category: 'Спортивные часы', name: 'Apple Watch Ultra 2 49 мм Black Titanium Trail Loop', price: 74990, image: 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=600&q=80', specs: 'Титан 49 мм, 3000 нит, EN13319.' },
    { brand: 'APPLE', series: 'Apple Watch', category: 'Спортивные часы', name: 'Apple Watch Series 10 46 мм Jet Black', price: 42990, image: 'https://images.unsplash.com/photo-1434493789847-2f02dc6ca35d?w=600&q=80', specs: 'Тонкий корпус, OLED, глубиномер.' },
    { brand: 'SAMSUNG', series: 'Galaxy Watch', category: 'Спортивные часы', name: 'Samsung Galaxy Watch Ultra 47 мм LTE Titanium Gray', price: 49990, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'Титан, сапфир, 10 АТМ, Galaxy AI.' },
    { brand: 'SAMSUNG', series: 'Galaxy Watch', category: 'Спортивные часы', name: 'Samsung Galaxy Watch 7 44 мм Green', price: 26990, image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=600&q=80', specs: '3 нм, BioActive, двухчастотный GPS.' },
    { brand: 'SUUNTO', series: 'Suunto', category: 'Спортивные часы', name: 'Suunto Vertical Titanium Solar Canyon', price: 64900, image: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600&q=80', specs: 'Офлайн-карты, 60 дней.' },
    { brand: 'SUUNTO', series: 'Suunto', category: 'Спортивные часы', name: 'Suunto Race S Titanium Canary AMOLED', price: 41500, image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=600&q=80', specs: 'Мультиспорт, AMOLED.' },
    { brand: 'POLAR', series: 'Polar', category: 'Спортивные часы', name: 'Polar Grit X2 Pro Titan Sapphire', price: 68400, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'ЭКГ, SpO2, титан.' },
    { brand: 'POLAR', series: 'Polar', category: 'Спортивные часы', name: 'Polar Vantage V3 Night Black', price: 54900, image: 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=600&q=80', specs: 'Elixir biosensing, AMOLED.' },
    { brand: 'COROS', series: 'COROS', category: 'Спортивные часы', name: 'COROS VERTIX 2S Space', price: 63500, image: 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=600&q=80', specs: '40 дней, офлайн-карты, сапфир+титан.' },
    { brand: 'COROS', series: 'COROS', category: 'Спортивные часы', name: 'COROS Pace 3 White Nylon', price: 22990, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'Легкие 30 г, 38 часов GPS.' },
    { brand: 'HUAWEI', series: 'Huawei Watch', category: 'Спортивные часы', name: 'Huawei Watch Ultimate Green Zirconium', price: 59990, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', specs: 'Жидкий металл, 100 м.' },
    { brand: 'HUAWEI', series: 'Huawei Watch', category: 'Спортивные часы', name: 'Huawei Watch GT 5 Pro Black Titanium', price: 32990, image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=600&q=80', specs: 'Титан, ECG, 14 дней.' },
    { brand: 'AMAZFIT', series: 'Amazfit', category: 'Спортивные часы', name: 'Amazfit T-Rex 3 48 мм Onyx Military', price: 25900, image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=600&q=80', specs: '2000 нит, -30C, 27 дней.' },
    { brand: 'CASIO', series: 'G-Shock', category: 'Спортивные часы', name: 'Casio G-Shock GBD-H2000-1A9 Solar GPS', price: 37900, image: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600&q=80', specs: 'Пульсометр, GPS, solar.' }
  ];
  const ins = db.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const x of seed) ins.run(x.brand, x.series, x.category, x.name, x.price, x.image, x.specs);
}

// ---------- API ----------
let tgBot = null;

app.get('/api/state', (req, res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  res.json({ settings, products });
});

const orderRateLimit = new Map();

app.post('/api/order', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (orderRateLimit.has(ip) && now - orderRateLimit.get(ip) < 5000) {
    return res.status(429).json({ error: 'Слишком быстро. Попробуйте ещё раз.' });
  }
  orderRateLimit.set(ip, now);

  const { items, total, initData } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Пустой заказ' });

  // Мини-апп может приложить initData для проверки подписи; без него — обычный веб-заказ.
  let tgUser = null;
  if (initData) {
    tgUser = verifyTelegramInitData(initData);
    if (!tgUser) return res.status(403).json({ error: 'Bad initData signature' });
  }

  const nextNum = parseInt(getSetting('last_order_num') || '1175', 10) + 1;
  setSetting('last_order_num', nextNum);
  const orderCode = `TG-${nextNum}`;

  db.prepare('INSERT INTO orders (order_code, items_json, total) VALUES (?, ?, ?)').run(orderCode, JSON.stringify(items), total);

  const itemsText = items.map((i, idx) => `${idx + 1}. ${i.name} — ${i.qty} шт. x ${Number(i.price).toLocaleString('ru-RU')} ₽`).join('\n');
  const clientTag = tgUser ? `\nКлиент TG: @${tgUser.username || tgUser.first_name} (id ${tgUser.id})` : '';
  const notifyMsg = `НОВАЯ ЗАЯВКА ${orderCode}\n\nСостав:\n${itemsText}\n\nИтого: ${Number(total).toLocaleString('ru-RU')} ₽${clientTag}\nРеквизиты:\n${getSetting('payment_details')}`;

  if (tgBot && isValidEnv(process.env.TG_ADMIN_ID)) {
    tgBot.telegram.sendMessage(process.env.TG_ADMIN_ID, notifyMsg, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('В сборку', `st_${orderCode}_work`), Markup.button.callback('Оплачен', `st_${orderCode}_paid`)],
        [Markup.button.callback('Отменить', `st_${orderCode}_cancel`)]
      ])
    }).catch((e) => console.error('TG Send Error:', e.message));
  }

  if (isValidEnv(process.env.MAX_BOT_TOKEN) && isValidEnv(process.env.MAX_ADMIN_ID)) {
    sendMaxMessage(process.env.MAX_ADMIN_ID, notifyMsg).catch((e) => console.error('MAX Send Error:', e.message));
  }

  res.json({
    orderCode,
    paymentDetails: getSetting('show_payment') === '1' ? getSetting('payment_details') : ''
  });
});

// ---------- Telegram bot ----------
if (isValidEnv(process.env.TG_BOT_TOKEN)) {
  tgBot = new Telegraf(process.env.TG_BOT_TOKEN);
  tgBot.use(session());
  const isTgAdmin = (ctx) => String(ctx.from?.id) === String(process.env.TG_ADMIN_ID);

  tgBot.command('id', (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

  tgBot.start(async (ctx) => {
    if (!isTgAdmin(ctx)) {
      const payload = ctx.startPayload;
      if (payload && payload.startsWith('TG-')) return handleClientOrderLookupTg(ctx, payload);
      await ctx.reply('Здравствуйте! Магазин Watchop. Отправьте номер заказа (например, TG-1176), менеджер проверит наличие и пришлет реквизиты.');
      if (WEBAPP_URL) return ctx.reply('Каталог и заказ в 1 клик — прямо в Telegram:', Markup.inlineKeyboard([[Markup.button.webApp('Открыть магазин', WEBAPP_URL)]]));
      return;
    }
    ctx.session = {};
    await ctx.reply(
      `Админ-панель Watchop (Telegram)\nВаш ID: ${ctx.from.id}\nВыберите действие:`,
      Markup.keyboard([
        ['Добавить часы', 'Товары и цены'],
        ['Реквизиты оплаты', 'Тексты и контакты'],
        ['Последние заказы']
      ]).resize()
    );
    if (WEBAPP_URL) return ctx.reply('Мини-приложение магазина:', Markup.inlineKeyboard([[Markup.button.webApp('Открыть магазин', WEBAPP_URL)]]));
  });

  tgBot.hears('Реквизиты оплаты', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const shown = getSetting('show_payment') === '1';
    ctx.reply(
      `Текущие реквизиты:\n${getSetting('payment_details')}\n\nПоказ на сайте: ${shown ? 'Включен' : 'Скрыт'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Изменить реквизиты', 'tg_edit_pay')],
        [Markup.button.callback(shown ? 'Скрыть на сайте' : 'Показать на сайте', 'tg_toggle_pay')]
      ])
    );
  });
  tgBot.action('tg_edit_pay', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.session = { step: 'wait_pay' };
    ctx.reply('Отправьте новые реквизиты (СБП / карта / ФИО):');
  });
  tgBot.action('tg_toggle_pay', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const next = getSetting('show_payment') === '1' ? '0' : '1';
    setSetting('show_payment', next);
    ctx.answerCbQuery('Готово');
    ctx.reply(`Показ реквизитов: ${next === '1' ? 'Включен' : 'Выключен'}`);
  });

  tgBot.hears('Добавить часы', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.session = { step: 'add_brand', draft: {} };
    ctx.reply('Шаг 1/6. Бренд (GARMIN, APPLE, SAMSUNG, SUUNTO, POLAR, COROS, HUAWEI, AMAZFIT, CASIO):');
  });

  tgBot.hears('Товары и цены', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const prods = db.prepare('SELECT id, name, price FROM products ORDER BY id DESC LIMIT 15').all();
    const btns = prods.map((p) => [
      Markup.button.callback(`#${p.id} ${p.name.slice(0, 22)} (${p.price})`, `tg_price_${p.id}`),
      Markup.button.callback('Удалить', `tg_del_${p.id}`)
    ]);
    ctx.reply('Последние 15 товаров:', Markup.inlineKeyboard(btns));
  });
  tgBot.action(/^tg_del_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    db.prepare('DELETE FROM products WHERE id = ?').run(Number(ctx.match[1]));
    ctx.answerCbQuery('Удалено');
    ctx.reply(`Товар #${ctx.match[1]} удален.`);
  });
  tgBot.action(/^tg_price_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.session = { step: 'wait_price', prodId: Number(ctx.match[1]) };
    ctx.reply(`Новая цена для #${ctx.match[1]} (только число):`);
  });

  tgBot.hears('Тексты и контакты', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.reply('Что меняем?', Markup.inlineKeyboard([
      [Markup.button.callback('Заголовок баннера', 'tg_cfg_hero_title')],
      [Markup.button.callback('Телефон', 'tg_cfg_phone'), Markup.button.callback('Email', 'tg_cfg_email')],
      [Markup.button.callback('Адрес', 'tg_cfg_address')],
      [Markup.button.callback('Ссылка ТГ', 'tg_cfg_tg_link'), Markup.button.callback('Ссылка MAX', 'tg_cfg_max_link')],
      [Markup.button.callback('ИП ФИО', 'tg_cfg_legal_name'), Markup.button.callback('ИНН', 'tg_cfg_legal_inn')]
    ]));
  });
  tgBot.action(/^tg_cfg_(.+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.session = { step: 'wait_cfg', key: ctx.match[1] };
    ctx.reply(`Текущее:\n${getSetting(ctx.match[1])}\n\nОтправьте новое значение:`);
  });

  tgBot.hears('Последние заказы', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 10').all();
    if (!orders.length) return ctx.reply('Заявок пока нет.');
    ctx.reply(orders.map((o) => `• ${o.order_code} — ${Number(o.total).toLocaleString('ru-RU')} ₽ [${o.status}]`).join('\n'));
  });
  tgBot.action(/^st_(TG-\d+)_(.+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const [, code, st] = ctx.match;
    const map = { work: 'В сборке', paid: 'Оплачен', cancel: 'Отменен' };
    db.prepare('UPDATE orders SET status = ? WHERE order_code = ?').run(map[st] || st, code);
    ctx.answerCbQuery(`Статус: ${map[st]}`);
    ctx.reply(`Статус ${code}: ${map[st]}`);
  });

  tgBot.on('photo', async (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const s = ctx.session || {};
    if (s.step !== 'add_img') return;
    try {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const link = await ctx.telegram.getFileLink(best.file_id);
      const resp = await fetch(link.href);
      const buf = Buffer.from(await resp.arrayBuffer());
      const fileName = `watch_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(uploadsDir, fileName), buf);
      finishAddingProductTg(ctx, `/uploads/${fileName}`);
    } catch (e) {
      ctx.reply('Не удалось сохранить фото. Отправьте ссылку.');
    }
  });

  tgBot.on('text', (ctx) => {
    const txt = ctx.message.text.trim();
    if (!isTgAdmin(ctx)) {
      const m = txt.match(/TG-\d+/i);
      if (m) return handleClientOrderLookupTg(ctx, m[0].toUpperCase());
      if (isValidEnv(process.env.TG_ADMIN_ID)) {
        const tag = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        tgBot.telegram.sendMessage(process.env.TG_ADMIN_ID, `Сообщение от клиента (${tag}, ID ${ctx.from.id}):\n${txt}`).catch(() => {});
      }
      return ctx.reply('Спасибо! Менеджер получил сообщение и скоро ответит.');
    }
    const s = ctx.session || {};
    if (s.step === 'wait_pay') { setSetting('payment_details', txt); ctx.session = {}; return ctx.reply('Реквизиты обновлены!'); }
    if (s.step === 'wait_cfg') { setSetting(s.key, txt); ctx.session = {}; return ctx.reply('Сохранено!'); }
    if (s.step === 'wait_price') {
      const p = parseInt(txt.replace(/\D/g, ''), 10) || 0;
      db.prepare('UPDATE products SET price = ? WHERE id = ?').run(p, s.prodId);
      ctx.session = {};
      return ctx.reply(`Цена #${s.prodId}: ${p.toLocaleString('ru-RU')} ₽`);
    }
    if (s.step === 'add_brand') { s.draft.brand = txt.toUpperCase(); s.step = 'add_series'; return ctx.reply('Шаг 2/6. Серия (fenix, Forerunner, Apple Watch, Galaxy Watch, Suunto...):'); }
    if (s.step === 'add_series') { s.draft.series = txt; s.step = 'add_cat'; return ctx.reply('Шаг 3/6. Категория (Спортивные часы / Дайвинг компьютеры / Фитнес-трекеры):'); }
    if (s.step === 'add_cat') { s.draft.category = txt; s.step = 'add_name'; return ctx.reply('Шаг 4/6. Полное название:'); }
    if (s.step === 'add_name') { s.draft.name = txt; s.step = 'add_price'; return ctx.reply('Шаг 5/6. Цена (только число):'); }
    if (s.step === 'add_price') { s.draft.price = parseInt(txt.replace(/\D/g, ''), 10) || 0; s.step = 'add_specs'; return ctx.reply('Шаг 5.5/6. Описание/характеристики:'); }
    if (s.step === 'add_specs') { s.draft.specs = txt; s.step = 'add_img'; return ctx.reply('Шаг 6/6. Отправьте ФОТО с телефона или ссылку (или - для стандартного):'); }
    if (s.step === 'add_img') {
      const img = txt.startsWith('http') ? txt : 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80';
      finishAddingProductTg(ctx, img);
    }
  });

  function finishAddingProductTg(ctx, imageUrl) {
    const d = ctx.session.draft;
    const info = db.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.brand, d.series, d.category, d.name, d.price, imageUrl, d.specs || '');
    ctx.session = {};
    ctx.reply(`Часы "${d.name}" (${Number(d.price).toLocaleString('ru-RU')} ₽) добавлены! ID: ${info.lastInsertRowid}`);
  }

  function handleClientOrderLookupTg(ctx, code) {
    const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(code);
    if (!order) return ctx.reply(`Заказ ${code} не найден.`);
    const items = JSON.parse(order.items_json || '[]');
    const list = items.map((i) => `• ${i.name} (${Number(i.price).toLocaleString('ru-RU')} ₽)`).join('\n');
    ctx.reply(`Ваш заказ ${code} найден!\n\n${list}\nИтого: ${Number(order.total).toLocaleString('ru-RU')} ₽\n\nРеквизиты:\n${getSetting('payment_details')}`);
    if (isValidEnv(process.env.TG_ADMIN_ID)) {
      const tag = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      tgBot.telegram.sendMessage(process.env.TG_ADMIN_ID, `Клиент ${tag} обратился по заказу ${code}`).catch(() => {});
    }
  }

  tgBot.telegram.getMe()
    .then((me) => console.log(`Telegram bot @${me.username} polling started`))
    .catch((e) => console.error('TG getMe failed:', e.description || e.message));
  tgBot.launch().catch((e) => console.error('TG polling error:', e.description || e.message));
  process.once('SIGINT', () => tgBot.stop('SIGINT'));
  process.once('SIGTERM', () => tgBot.stop('SIGTERM'));
}

// ---------- MAX bot (полный паритет с Telegram-ботом) ----------
// Документация: https://dev.max.ru/docs-api (домен platform-api2, авторизация через заголовок Authorization)
const MAX_API = 'https://platform-api2.max.ru';
const maxSessions = new Map(); // userId -> { step, draft, prodId, key }

function maxKb(rows) {
  // Кнопки типа message присылают боту заранее заданный текст — меню работает без answers API
  return [{
    type: 'inline_keyboard',
    payload: { buttons: rows.map((r) => r.map((t) => ({ type: 'message', text: t, payload: t }))) }
  }];
}

const MAX_MENU = [['Добавить часы', 'Товары и цены'], ['Реквизиты оплаты', 'Тексты и контакты'], ['Последние заказы']];
const MAX_CANCEL = [['Отмена']];

async function sendMaxMessage(userId, text, kbRows) {
  if (!isValidEnv(process.env.MAX_BOT_TOKEN)) return;
  const body = { text: String(text).slice(0, 4000) };
  if (kbRows) body.attachments = maxKb(kbRows);
  await fetch(`${MAX_API}/messages?user_id=${userId}`, {
    method: 'POST',
    headers: { Authorization: process.env.MAX_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function startMaxBotPolling() {
  if (!isValidEnv(process.env.MAX_BOT_TOKEN)) return;
  console.log('MAX bot polling started');
  let marker = null;
  while (true) {
    try {
      const url = new URL(`${MAX_API}/updates`);
      url.searchParams.set('timeout', '25');
      if (marker) url.searchParams.set('marker', marker);
      const res = await fetch(url.toString(), { headers: { Authorization: process.env.MAX_BOT_TOKEN } });
      if (res.ok) {
        const data = await res.json();
        if (data.marker) marker = data.marker;
        for (const upd of (data.updates || [])) await handleMaxUpdate(upd);
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function maxOrderStatusKb(orderCode) {
  return [[`В сборку ${orderCode}`, `Оплачен ${orderCode}`], [`Отменить ${orderCode}`]];
}

async function maxNotifyAdmin(text, orderCode) {
  if (!isValidEnv(process.env.MAX_ADMIN_ID)) return;
  await sendMaxMessage(process.env.MAX_ADMIN_ID, text, orderCode ? maxOrderStatusKb(orderCode) : undefined);
}

async function maxAdminMenu(userId, title) {
  await sendMaxMessage(userId, title || 'Админ-панель Watchop (MAX). Выберите действие:', [...MAX_MENU, ...MAX_CANCEL]);
}

const MAX_CFG_BUTTONS = {
  'Баннер': 'hero_title', 'Телефон': 'phone', 'Email': 'email', 'Адрес': 'address',
  'Ссылка ТГ': 'tg_link', 'Ссылка MAX': 'max_link', 'ИП': 'legal_name', 'ИНН': 'legal_inn'
};
async function handleMaxUpdate(upd) {
  if (upd.update_type === 'message_callback' && upd.callback) {
    const cbText = upd.callback.payload || upd.callback.text || '';
    const cbUser = upd.callback.user || upd.user || {};
    if (cbText) {
      return handleMaxMessage(String(cbUser.user_id || ''), cbUser.name || 'Клиент', String(cbText), upd);
    }
    return;
  }
  if (upd.update_type === 'bot_started') {
    const u = upd.user || {};
    return handleMaxMessage(String(u.user_id || ''), u.name || 'Клиент', '/start', upd);
  }
  const msg = upd.message;
  if (upd.update_type !== 'message_created' || !msg) return;
  const senderId = String(msg.sender?.user_id || '');
  if (!senderId) return;
  const senderName = msg.sender?.name || 'Клиент';
  const text = (msg.body?.text || '').trim();

  const photoUrl = findMaxPhotoUrl(msg.body?.attachments);
  const sess = maxSessions.get(senderId);
  if (photoUrl && sess?.step === 'add_img' && String(senderId) === String(process.env.MAX_ADMIN_ID)) {
    try {
      const resp = await fetch(photoUrl);
      const buf = Buffer.from(await resp.arrayBuffer());
      const fileName = `watch_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(uploadsDir, fileName), buf);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, `Часы "${sess.draft.name}" (${Number(sess.draft.price).toLocaleString('ru-RU')} ₽) добавлены! ID: ${finishAddingProductMax(sess.draft, `/uploads/${fileName}`)}`, MAX_MENU);
    } catch (e) {
      return sendMaxMessage(senderId, 'Не удалось сохранить фото. Отправьте ссылку на картинку.');
    }
  }
  return handleMaxMessage(senderId, senderName, text, upd);
}

function findMaxPhotoUrl(attachments) {
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments) {
    const p = a?.payload || {};
    const url = p.url || p.preview_url || a.url || null;
    if (url && typeof url === 'string' && url.startsWith('http')) return url;
  }
  return null;
}

function finishAddingProductMax(d, imageUrl) {
  return db.prepare('INSERT INTO products (brand, series, category, name, price, image, specs) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(d.brand, d.series, d.category, d.name, d.price, imageUrl, d.specs || '').lastInsertRowid;
}

async function handleMaxMessage(senderId, senderName, text, upd) {
  const isMaxAdmin = String(senderId) === String(process.env.MAX_ADMIN_ID);

  if (text === '/id') return sendMaxMessage(senderId, `Ваш MAX ID: ${senderId}`);

  const stMatch = text.match(/^(В сборку|Оплачен|Отменить)\s+(TG-\d+)$/i);
    if (stMatch) {
      const map = { 'в сборку': 'В сборке', 'оплачен': 'Оплачен', 'отменить': 'Отменен' };
      const status = map[stMatch[1].toLowerCase()];
      db.prepare('UPDATE orders SET status = ? WHERE order_code = ?').run(status, stMatch[2].toUpperCase());
      return sendMaxMessage(senderId, `Статус ${stMatch[2].toUpperCase()}: ${status}`, MAX_MENU);
    }

  

  const orderMatch = text.match(/TG-\d+/i);
  if (orderMatch && !text.startsWith('/')) {
    const code = orderMatch[0].toUpperCase();
    const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(code);
    if (order) {
      const items = JSON.parse(order.items_json || '[]');
      const list = items.map((i) => `• ${i.name} (${Number(i.price).toLocaleString('ru-RU')} ₽)`).join('\n');
      await sendMaxMessage(senderId, `Заказ ${code} принят!\n\n${list}\nК оплате: ${Number(order.total).toLocaleString('ru-RU')} ₽\n\nРеквизиты:\n${getSetting('payment_details')}`);
      if (isValidEnv(process.env.MAX_ADMIN_ID) && !isMaxAdmin) {
        await maxNotifyAdmin(`Клиент ${senderName} (${senderId}) в MAX по заказу ${code}:\n"${text}"`);
      }
      return;
    }
  }

  if (!isMaxAdmin) {
    if (isValidEnv(process.env.MAX_ADMIN_ID)) {
      await maxNotifyAdmin(`Сообщение в MAX от ${senderName} (${senderId}):\n${text || '(без текста)'}`);
    }
    return sendMaxMessage(senderId, 'Здравствуйте! Напишите номер заказа (например, TG-1176) или дождитесь менеджера.');
  }

  const sess = maxSessions.get(senderId) || {};

  if (text === 'Отмена') {
    maxSessions.delete(senderId);
    return maxAdminMenu(senderId, 'Отменено. Выберите действие:');
  }

  if (text === '/start' || text === '/help' || text === 'Меню') {
    maxSessions.delete(senderId);
    return maxAdminMenu(senderId);
  }

  if (sess.step) {
    if (sess.step === 'wait_pay') {
      setSetting('payment_details', text);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, 'Реквизиты оплаты обновлены на сайте!', MAX_MENU);
    }
    if (sess.step === 'wait_cfg') {
      setSetting(sess.key, text);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, 'Настройка сайта сохранена!', MAX_MENU);
    }
    if (sess.step === 'wait_price') {
      const p = parseInt(text.replace(/\D/g, ''), 10) || 0;
      db.prepare('UPDATE products SET price = ? WHERE id = ?').run(p, sess.prodId);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, `Цена #${sess.prodId}: ${p.toLocaleString('ru-RU')} ₽`, MAX_MENU);
    }
    if (sess.step === 'add_brand') { sess.draft.brand = text.toUpperCase(); sess.step = 'add_series'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 2/6. Серия для фильтра (fēnix, Forerunner, Apple Watch, Galaxy Watch, Suunto...):'); }
    if (sess.step === 'add_series') { sess.draft.series = text; sess.step = 'add_cat'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 3/6. Категория (Спортивные часы / Дайвинг компьютеры / Фитнес-трекеры):'); }
    if (sess.step === 'add_cat') { sess.draft.category = text; sess.step = 'add_name'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 4/6. Полное название часов:'); }
    if (sess.step === 'add_name') { sess.draft.name = text; sess.step = 'add_price'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 5/6. Цена в рублях (только число):'); }
    if (sess.step === 'add_price') { sess.draft.price = parseInt(text.replace(/\D/g, ''), 10) || 0; sess.step = 'add_specs'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 5.5/6. Краткое описание/характеристики:'); }
    if (sess.step === 'add_specs') { sess.draft.specs = text; sess.step = 'add_img'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 6/6. Отправьте ФОТО часов или ссылку на картинку (или - для стандартного фото):'); }
    if (sess.step === 'add_img') {
      const img = text.startsWith('http') ? text : 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80';
      const id = finishAddingProductMax(sess.draft, img);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, `Часы "${sess.draft.name}" (${Number(sess.draft.price).toLocaleString('ru-RU')} ₽) добавлены! ID: ${id}`, MAX_MENU);
    }
  }

  if (text === 'Добавить часы') {
    maxSessions.set(senderId, { step: 'add_brand', draft: {} });
    return sendMaxMessage(senderId, 'Шаг 1/6. Бренд (GARMIN, APPLE, SAMSUNG, SUUNTO, POLAR, COROS, HUAWEI, AMAZFIT, CASIO):', MAX_CANCEL);
  }
  if (text === 'Товары и цены' || text === '/products') {
    const prods = db.prepare('SELECT id, name, price FROM products ORDER BY id DESC LIMIT 15').all();
    if (!prods.length) return sendMaxMessage(senderId, 'Товаров пока нет.', MAX_MENU);
    const rows = prods.flatMap((p) => [[`Цена #${p.id}`, `Удалить #${p.id}`]]);
    const list = prods.map((p) => `#${p.id} ${p.name.slice(0, 30)} — ${Number(p.price).toLocaleString('ru-RU')} ₽`).join('\n');
    return sendMaxMessage(senderId, `Последние 15 товаров:\n${list}\n\nНажмите кнопку под сообщением:`, [...rows, ...MAX_CANCEL]);
  }
  const priceMatch = text.match(/^Цена #(\d+)$/i);
  if (priceMatch) {
    maxSessions.set(senderId, { step: 'wait_price', prodId: Number(priceMatch[1]) });
    return sendMaxMessage(senderId, `Новая цена для #${priceMatch[1]} (только число):`, MAX_CANCEL);
  }
  const delMatch = text.match(/^(?:Удалить #|\/del )(\d+)$/i);
  if (delMatch) {
    db.prepare('DELETE FROM products WHERE id = ?').run(Number(delMatch[1]));
    return sendMaxMessage(senderId, `Товар #${delMatch[1]} удален.`, MAX_MENU);
  }
  if (text === 'Реквизиты оплаты' || text === '/pay') {
    const shown = getSetting('show_payment') === '1';
    return sendMaxMessage(senderId,
      `Текущие реквизиты:\n${getSetting('payment_details')}\n\nПоказ на сайте: ${shown ? 'Включен' : 'Скрыт'}`,
      [['Изменить реквизиты'], [shown ? 'Скрыть на сайте' : 'Показать на сайте'], ['Отмена']]);
  }
  if (text === 'Изменить реквизиты') {
    maxSessions.set(senderId, { step: 'wait_pay' });
    return sendMaxMessage(senderId, 'Отправьте новые реквизиты (СБП / карта / ФИО):', MAX_CANCEL);
  }
  if (text === 'Скрыть на сайте' || text === 'Показать на сайте') {
    const next = getSetting('show_payment') === '1' ? '0' : '1';
    setSetting('show_payment', next);
    return sendMaxMessage(senderId, `Показ реквизитов: ${next === '1' ? 'Включен' : 'Выключен'}`, MAX_MENU);
  }
  if (text === 'Тексты и контакты') {
    return sendMaxMessage(senderId, 'Что меняем на сайте?', [['Баннер'], ['Телефон', 'Email'], ['Адрес'], ['Ссылка ТГ', 'Ссылка MAX'], ['ИП', 'ИНН'], ['Отмена']]);
  }
  if (MAX_CFG_BUTTONS[text]) {
    const key = MAX_CFG_BUTTONS[text];
    maxSessions.set(senderId, { step: 'wait_cfg', key });
    return sendMaxMessage(senderId, `Текущее:\n${getSetting(key)}\n\nОтправьте новое значение:`, MAX_CANCEL);
  }
  if (text === 'Последние заказы' || text === '/orders') {
    const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 10').all();
    if (!orders.length) return sendMaxMessage(senderId, 'Заявок пока нет.', MAX_MENU);
    const list = orders.map((o) => `• ${o.order_code} — ${Number(o.total).toLocaleString('ru-RU')} ₽ [${o.status}]`).join('\n');
    const last = orders[0];
    return sendMaxMessage(senderId, `Последние заказы:\n${list}`, [...maxOrderStatusKb(last.order_code), ...MAX_CANCEL]);
  }

  if (text.startsWith('/pay ')) {
    const v = text.replace('/pay ', '').trim();
    setSetting('payment_details', v);
    return sendMaxMessage(senderId, `Реквизиты обновлены:\n${v}`, MAX_MENU);
  }
  if (text.startsWith('/add ')) {
    const parts = text.replace('/add ', '').split('|').map((s) => s.trim());
    if (parts.length < 4) return sendMaxMessage(senderId, 'Формат: /add GARMIN | fēnix | Название | 62320', MAX_MENU);
    const [brand, series, name, priceStr] = parts;
    const price = parseInt(priceStr.replace(/\D/g, ''), 10) || 0;
    const id = finishAddingProductMax({ brand: brand.toUpperCase(), series, category: 'Спортивные часы', name, price, specs: '' }, 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80');
    return sendMaxMessage(senderId, `Добавлено! ID: ${id}`, MAX_MENU);
  }

  return maxAdminMenu(senderId, 'Не понял команду. Выберите действие кнопкой:');
}
startMaxBotPolling();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Watchop running on http://localhost:${PORT}`));
