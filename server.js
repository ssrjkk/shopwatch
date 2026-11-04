try { require('./sqlite-compat.js'); } catch (_) {}
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');
const DatabaseSync = require('node:sqlite').DatabaseSync;
const { Telegraf, Markup, session } = require('telegraf');

// Не даём токенам ботов попасть в логи: ошибки HTTP-клиентов содержат URL с токеном.
function redactSecrets(value) {
  let out = String(value == null ? '' : value);
  for (const key of ['TG_BOT_TOKEN', 'MAX_BOT_TOKEN', 'GITHUB_PUSH_TOKEN']) {
    const token = process.env[key];
    if (token && token.length >= 8) out = out.split(token).join('***');
  }
  return out.replace(/bot\d+:[A-Za-z0-9_-]{10,}/g, 'bot***').replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

const app = express();
if (typeof app.set === 'function') app.set('trust proxy', 1);
// --- Защита: лимит тела, security-заголовки, закрытый CORS по умолчанию ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
// ---------- Кодировка входящих данных ----------
// Клиент может прислать тело не в UTF-8: CSV из Excel в cp1251, кривой curl,
// старый терминал. Стандартный парсер декодирует всё как UTF-8 и молча ставит
// U+FFFD — данные теряются безвозвратно, и менеджер видит «?????» вместо имени.
// Поэтому: строгий UTF-8, а если байты ему не подошли — windows-1251 (для
// русскоязычного магазина это и есть та «старая» кодировка; в ней определены
// все 256 байт, так что третьей попытки не нужно).
function decodeTextBytes(buf) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch (e) { /* пробуем windows-1251 */ }
  try {
    return { text: new TextDecoder('windows-1251', { fatal: true }).decode(buf), encoding: 'windows-1251' };
  } catch (e) {
    return { text: '', encoding: '' };
  }
}

// NFC склеивает разложенные буквы («е» + диакритика → «ё»), иначе поиск и
// дедупликация видят две разные строки. Управляющие символы вырезаем, \r\n
// приводим к \n.
function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .normalize('NFC')
    .trim();
}

function hasReplacement(value) {
  return String(value == null ? '' : value).includes('\uFFFD');
}

function hasGarbageDeep(node) {
  if (typeof node === 'string') return hasReplacement(node);
  if (Array.isArray(node)) return node.some(hasGarbageDeep);
  if (node && typeof node === 'object') return Object.values(node).some(hasGarbageDeep);
  return false;
}

// Если после штатного разбора в теле остались U+FFFD, пробуем расшифровать
// исходные байты в другой кодировке. Обычный UTF-8 запрос сюда не заходит.
function repairRequestEncoding(req, res, next) {
  if (!req.rawBody || !req.body || typeof req.body !== 'object' || !hasGarbageDeep(req.body)) return next();
  const dec = decodeTextBytes(req.rawBody);
  if (dec.text && dec.encoding !== 'utf-8') {
    try {
      const fixed = JSON.parse(dec.text);
      if (fixed && typeof fixed === 'object') {
        req.body = fixed;
        req.bodyEncoding = dec.encoding;
      }
    } catch (e) { /* JSON битый — пусть отвечает стандартный парсер */ }
  }
  return next();
}

app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(repairRequestEncoding);
// ---------- /Кодировка ----------
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : { origin: false }));

const publicDir = path.join(__dirname, 'public');
// Фото из админки должны переживать пересборку контейнера: в Docker UPLOADS_DIR указывает на /data.
const uploadsDir = path.isAbsolute(process.env.UPLOADS_DIR || '')
  ? process.env.UPLOADS_DIR
  : path.join(publicDir, process.env.UPLOADS_DIR || 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
// ---------- Сжатие ответов ----------
// GitHub Pages жмёт сам, а этот сервер (localhost, VPS, Docker) отдавал HTML и
// JSON не сжатыми: /api/state — 135 КБ вместо 23 КБ, витрина — 96 КБ вместо
// 27 КБ. Brotli, если клиент его принимает, иначе gzip. Картинки не трогаем:
// они уже сжаты, а буферизация потока только вредит.
const zlib = require('zlib');
const COMPRESSIBLE_PATH = /(?:^\/$|\.(?:html?|js|mjs|css|json|txt|svg|map)$|\/api\/(?:state|order-status)$)/i;
const COMPRESS_MIN_BYTES = 1024;

function toBuffer(chunk, encoding) {
  if (!chunk) return Buffer.alloc(0);
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

function isCompressibleType(res) {
  const type = String(res.getHeader('Content-Type') || '').toLowerCase();
  return !type || /json|javascript|text\/|html|css|svg/.test(type);
}

function compression(req, res, next) {
  const accept = String(req.headers['accept-encoding'] || '');
  const useBrotli = /(^|[,;\s])br($|[,;\s])/i.test(accept);
  const useGzip = /(^|[,;\s])gzip($|[,;\s])/i.test(accept);
  if ((!useBrotli && !useGzip) || !COMPRESSIBLE_PATH.test(req.path) || req.method === 'HEAD') return next();
  const chunks = [];
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (chunk, encoding, cb) => {
    if (chunk && !res.headersSent) chunks.push(toBuffer(chunk, encoding));
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };
  res.end = (chunk, encoding, cb) => {
    if (chunk && !res.headersSent) chunks.push(toBuffer(chunk, encoding));
    res.write = write;
    res.end = end;
    const body = Buffer.concat(chunks);
    const status = res.statusCode || 200;
    if ((status < 200 || status >= 300 || status === 204) || body.length < COMPRESS_MIN_BYTES || !isCompressibleType(res)) {
      res.setHeader('Content-Length', body.length);
      return end(body);
    }
    let out;
    try {
      out = useBrotli ? zlib.brotliCompressSync(body) : zlib.gzipSync(body, { level: 6 });
    } catch (e) {
      res.setHeader('Content-Length', body.length);
      return end(body);
    }
    if (out.length >= body.length) {
      res.setHeader('Content-Length', body.length);
      return end(body);
    }
    res.setHeader('Content-Encoding', useBrotli ? 'br' : 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', out.length);
    return end(out);
  };
  return next();
}

app.use(compression);
// Файлы из админки называются watch_<миллисекунды>.jpg, то есть имя уникально
// на каждое загруженное фото. Значит его можно отдавать как immutable: браузер
// не делает лишнюю ревалидацию на каждый показ карточки.
app.use('/uploads', express.static(uploadsDir, { maxAge: '365d', immutable: true }));
app.use(express.static(publicDir));

const { applySeed, commitCatalogFiles, normalizeRow, renderCatalogFile, readCatalogFile, diffCatalog, summarizeDiff, seedKey, normalizeImages } = require('./catalog-export.js');

function isValidEnv(val) {
  return val && typeof val === 'string' && val.trim() !== '' && !val.startsWith('ВСТАВЬ_');
}

// URL мини-приложения (Telegram Mini App), открывается кнопкой web_app в боте.
// Задается в .env: WEBAPP_URL=https://<твой-домен> (нужен публичный HTTPS).
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim();
// Публичная витрина (например, GitHub Pages) — кнопка-ссылка, когда мини-аппа нет.
const SHOP_URL = (process.env.SHOP_URL || '').trim();

function tgShopButtons() {
  if (WEBAPP_URL) return [Markup.button.webApp('Открыть магазин', WEBAPP_URL)];
  if (SHOP_URL) return [Markup.button.url('Открыть каталог', SHOP_URL)];
  return [];
}


function tgAdminMenuKb() {
  return Markup.keyboard([
    ['Добавить часы', 'Товары и цены'],
    ['Реквизиты оплаты', 'Тексты и контакты'],
    ['Последние заказы', 'Экспорт каталога'],
    ['Импорт товаров', 'Админы'],
    ['Сводка сайта', 'Фото на стоках'],
    ['Промокоды', 'Дизайн'],
    ['Статистика', 'Журнал'],
    ['Бекап БД']
  ]).resize();
}

function tgAdminsPanelKb() {
  const rows = [];
  for (const r of tgAdminRoster()) {
    if (r.source !== 'бот') continue;
    rows.push([Markup.button.callback(`Убрать ${r.kind === 'id' ? 'ID ' + r.value : '@' + r.value}`, r.kind === 'id' ? `adm_rm_id_${r.value}` : `adm_rm_u_${r.value}`)]);
  }
  rows.push([Markup.button.callback('Добавить по ID', 'adm_add_id'), Markup.button.callback('Добавить по юзернейму', 'adm_add_u')]);
  rows.push([Markup.button.callback('Обновить список', 'adm_list'), Markup.button.callback('Назад', 'adm_back')]);
  return Markup.inlineKeyboard(rows);
}

function showTgAdminsPanel(ctx) {
  const lines = tgAdminRoster().map((r) => `• ${r.kind === 'id' ? 'ID ' + r.value : '@' + r.value} — ${r.source === '.env' ? 'из .env, убрать можно только правкой .env' : 'добавлен через бота'}`);
  ctx.reply(
    `Админы бота (${lines.length}):\n${lines.join('\n')}\n\nАдмин видит админ-меню и получает все уведомления о заявках. Добавленный по юзернейму становится полным админом при первом сообщении боту.`,
    tgAdminsPanelKb()
  );
}

function tgPromoKb() {
  const hl = getSetting('promo_highlight') === '1';
  return Markup.inlineKeyboard([
    [Markup.button.callback('Добавить промокод', 'promo_add'), Markup.button.callback('Убрать промокод', 'promo_rm')],
    [Markup.button.callback('Обновить список', 'promo_list'), Markup.button.callback(hl ? 'Красные ценники: вкл' : 'Красные ценники: выкл', 'promo_hl')]
  ]);
}

function promoHighlightLine() {
  return `Красные ценники на витрине: ${getSetting('promo_highlight') === '1' ? 'ВКЛ (как было)' : 'ВЫКЛ (нейтральные цены)'}. Переключается кнопкой ниже, цены и скидки не трогает.`;
}

function showTgPromoPanel(ctx, note) {
  const list = promoRulesText(getSetting('promo_codes'));
  ctx.reply(
    `${note ? note + '\n\n' : ''}${list}\n\n${promoHighlightLine()}\n\nПравило задаётся строкой «КОД ПРОЦЕНТ [БРЕНД] [minСУММА]» — например «VIP20 20 GARMIN min100000». Скидку считает сервер по ценам своей базы, а клиент присылает только код: подделать сумму с сайта нельзя.`,
    tgPromoKb()
  );
}

function verifyTelegramInitData(initData) {
  // Проверка подписи https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
  // Возвращает объект user из Mini App или null. Используется в тестах и в POST /api/order.
  if (!initData || !isValidEnv(process.env.TG_BOT_TOKEN)) return null;
  try {
    const crypto = require('crypto');
    const params = new URLSearchParams(initData);
    if (new Set(params.keys()).size !== [...params.keys()].length) return null;
    const hash = params.get('hash');
    if (!/^[a-f0-9]{64}$/.test(hash || '')) return null;
    const authDate = Number(params.get('auth_date') || 0);
    const age = Date.now() / 1000 - authDate;
    if (!Number.isSafeInteger(authDate) || authDate <= 0 || age < -60 || age > 86400) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
    if (!crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'))) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch (e) {
    return null;
  }
}

// ---------- DB ----------
const db = new DatabaseSync(process.env.DB_PATH || 'watchop.db');
try { db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;'); } catch (e) {}

// ---------- Бекапы и целостность ----------
// ---------- Backups & DB integrity ----------
const BACKUP_DIR = process.env.BACKUP_DIR || (process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'backups') : path.join(__dirname, 'backups'));
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '7', 10) || 7);
function runBackup(reason, over) {
  const o = over || {};
  const conn = o.conn || db;
  const dir = o.dir || BACKUP_DIR;
  const saver = o.set || setSetting;
  const keep = o.keep || BACKUP_KEEP;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + String(process.pid);
    const file = path.join(dir, "watchop-" + stamp + ".db");
    conn.exec("VACUUM INTO '" + file.split("'").join("''") + "'");
    try {
      const files = fs.readdirSync(dir).filter((f) => /^watchop-.*\.db$/.test(f)).sort();
      while (files.length > keep) fs.unlinkSync(path.join(dir, files.shift()));
    } catch (e) {}
    try { saver("last_backup_at", new Date().toISOString()); } catch (e) {}
    console.log("Backup done (" + (reason || "manual") + "): " + file);
    return { ok: true, file: file };
  } catch (e) {
    console.error("Backup FAILED:", e.message);
    return { ok: false, error: e.message };
  }
}
function checkDbIntegrity() {
  try {
    const r = db.prepare('PRAGMA integrity_check').get();
    if (r && r.integrity_check === 'ok') return { ok: true };
    console.error('DB integrity_check FAILED:', JSON.stringify(r));
    return { ok: false, error: JSON.stringify(r) };
  } catch (e) {
    console.error('DB integrity_check error:', e.message);
    return { ok: false, error: e.message };
  }
}
function handleBackupRequest(ctx) {
  const r = runBackup('Кнопка Бекап БД');
  if (!r.ok) return ctx.reply('Бекап не получился: ' + r.error);
  return ctx.replyWithDocument({ source: r.file }, { caption: 'Бекап базы' }).catch((e) => ctx.reply('Файл записан, но отправить не вышло: ' + redactSecrets(e.message)));
}
// ---------- /Backup ----------

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
  phone: '+7 (000) 000-00-00',
  email: 'demo@example.invalid',
  address: 'Доставка по всей России — СДЭК, Почта России, Boxberry',
  tg_link: '',
  max_link: '',
  legal_name: 'ИП Жукова Татьяна Юрьевна',
  legal_inn: '0000000000',
  legal_ogrnip: '304362725400110',
  delivery_methods: 'СДЭК,Почта России,Boxberry',
  extra_categories: '',
  store_design: 'stealth',
  payment_details: 'СБП / Т-Банк / Сбер: +7 (900) 000-00-00 (Татьяна Ю.)\nВ комментарии к переводу укажите номер заказа.',
  show_payment: '1',
  promo_highlight: '0',
  last_order_num: '1175'
};

const initSettingStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultSettings)) initSettingStmt.run(k, v);

// Что админка имеет право переписывать текстом. last_order_num — служебный счётчик
// номеров заявок: его порча ломает выдачу кодов, поэтому его в списке нет.
// store_design меняется только кнопками «Дизайн» (там проверка файла),
// произвольный текст в этой настройке ломал бы витрину.
const EDITABLE_SETTINGS = Object.keys(defaultSettings).filter((k) => k !== 'last_order_num' && k !== 'store_design');
function isEditableSetting(key) {
  return EDITABLE_SETTINGS.indexOf(String(key || '')) >= 0;
}

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));

// Миграция старой ссылки менеджера на рабочего бота + колонка хитов для существующих БД
if (getSetting('tg_link') === 'https://t.me/watchop_manager') setSetting('tg_link', '');
if (getSetting('hero_title').includes('Воронеже')) setSetting('hero_title', 'Магазин оригинальной продукции Garmin и смарт-часов с доставкой по всей России — поможем выбрать под ваши задачи');
if (getSetting('address').includes('Воронеж') || getSetting('address').includes('Пушкинская')) setSetting('address', 'Доставка по всей России — СДЭК, Почта России, Boxberry');
try { db.exec('ALTER TABLE products ADD COLUMN is_hit INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE products ADD COLUMN old_price INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 4'); } catch (e) {}
try { db.exec('ALTER TABLE products ADD COLUMN seed_key TEXT'); } catch (e) {}
try { db.exec("ALTER TABLE products ADD COLUMN gallery TEXT DEFAULT '[]'"); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN customer_json TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN owner_tg TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN owner_max TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN promo_code TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE orders ADD COLUMN discount INTEGER DEFAULT 0'); } catch (e) {}
db.exec('CREATE TABLE IF NOT EXISTS seed_marks (seed_key TEXT PRIMARY KEY, marked_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
// Защита заказов: повторная отправка формы не плодит дубли, остатки уходят атомарно.
db.exec('CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, order_code TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
db.exec('CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at)');
// Журнал действий: кто/что/когда поменял. Пишем только факты, без секретов и PII.
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  actor TEXT NOT NULL DEFAULT 'system',
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT NOT NULL DEFAULT 'api'
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)');
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id)');
// Брошенные оформления: только id товаров, сумма и случайный session_id — никаких телефонов.
db.exec(`CREATE TABLE IF NOT EXISTS checkout_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tg_id TEXT,
  cart_json TEXT NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reminded_at DATETIME,
  order_code TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_checkout_status ON checkout_events(status, updated_at)');
// Миграция для баз, созданных до появления order_code в checkout_events.
try { db.exec('ALTER TABLE checkout_events ADD COLUMN order_code TEXT'); } catch (e) {}
// Админка и сводка постоянно группируют по полке и статусу, а кабинеты ищут
// заявки по статусу и дате — без индексов это полный проход по каталогу.
db.exec('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_hit ON products(is_hit)');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)');

const SEED_PRODUCTS = require('./public/products-data.js');
{
  const res = applySeed(db, SEED_PRODUCTS);
  if (res.added) console.log(res.empty ? `Catalog seeded: ${res.added} products` : `Catalog upgraded: +${res.added} products`);
}
// Разовый refresh фото из файла-источника: файл — единственный источник правды
// для каталожных фото. Обновляем позиции, чьи фото ещё на чужих CDN, а также те,
// что лежат в управляемом пуле uploads/catalog/ но разошлись с файлом (ревизия
// пула). Свои загрузки админа вне catalog/ (/uploads/watch_*.jpg и т.п.) и ручные
// правки не трогаем.
try {
  const OLD_HOSTS = ['images.unsplash.com', 'upload.wikimedia.org', 'thumb.wikimedia.org', 'pitergsm.ru'];
  const wantByKey = new Map(SEED_PRODUCTS.map((p) => [seedKey(p), String(p.image || '')]));
  const wantById = new Map(SEED_PRODUCTS.map((p) => [Number(p.id), String(p.image || '')]));
  const wantGalByKey = new Map(SEED_PRODUCTS.map((p) => [seedKey(p), JSON.stringify(normalizeImages(p))]));
  const wantGalById = new Map(SEED_PRODUCTS.map((p) => [Number(p.id), JSON.stringify(normalizeImages(p))]));
  const updImg = db.prepare('UPDATE products SET image = ? WHERE id = ?');
  const updGal = db.prepare('UPDATE products SET gallery = ? WHERE id = ?');
  let refreshed = 0;
  db.exec('SAVEPOINT img_refresh');
  try {
    for (const r of db.prepare('SELECT id, image, seed_key, gallery FROM products').all()) {
      const cur = String(r.image || '');
      const want = wantById.get(Number(r.id)) || wantByKey.get(r.seed_key);
      if (want && want !== cur) {
        const isHotlink = OLD_HOSTS.some((h) => cur.includes(h));
        const isManagedPool = cur.startsWith('uploads/catalog/');
        if (isHotlink || isManagedPool) { updImg.run(want, r.id); refreshed++; }
      }
      const wantGal = wantGalById.get(Number(r.id)) || wantGalByKey.get(r.seed_key);
      if (wantGal && String(r.gallery == null ? '[]' : r.gallery) !== wantGal) {
        const curGal = String(r.gallery == null || r.gallery === '' ? '[]' : r.gallery);
        if (curGal === '[]' || cur.startsWith('uploads/catalog/') || OLD_HOSTS.some((h) => cur.includes(h))) {
          updGal.run(wantGal, r.id); refreshed++;
        }
      }
    }
    db.exec('RELEASE SAVEPOINT img_refresh');
  } catch (e) {
    try { db.exec('ROLLBACK TO SAVEPOINT img_refresh'); db.exec('RELEASE SAVEPOINT img_refresh'); } catch (_) {}
    throw e;
  }
  if (refreshed) console.log(`Catalog images refreshed: ${refreshed}`);
} catch (e) { console.error('Image refresh failed:', e.message); }


// ---------- Экспорт каталога из базы в файл-источник ----------
// products-data.js — единственный источник для витрины без бэкенда (GitHub Pages)
// и для начального засева базы. Кнопка в админке приводит базу к файлу.
const CATALOG_FILES = [path.join(__dirname, 'products-data.js'), path.join(publicDir, 'products-data.js')];

function catalogFromDb() {
  return db.prepare('SELECT * FROM products ORDER BY id ASC').all().map(normalizeRow);
}

// ---------- Скидки ----------
// old_price — цена до уценки, price — текущая. Повторная скидка считается от
// old_price, иначе уценки незаметно накладывались бы друг на друга.
// Округление до 10 ₽: витрина должна выглядеть как магазин, а не как калькулятор.
function discountFor(row, percent) {
  const p = Math.trunc(Number(percent));
  if (!Number.isFinite(p) || p < 1 || p > 90) return { ok: false, error: 'Скидка — целое число от 1 до 90 процентов.' };
  const base = Math.trunc(Number(row.price)) || 0;
  if (!base) return { ok: false, error: 'У товара нет цены — сначала выставьте её в «Товары и цены».' };
  const stored = Math.trunc(Number(row.old_price)) || 0;
  const from = stored > base ? stored : base;
  const next = Math.round(((from * (100 - p)) / 100) / 10) * 10;
  if (next < 10 || next >= from) return { ok: false, error: 'При такой цене скидка ничего не меняет — возьмите процент побольше.' };
  return { ok: true, oldPrice: from, price: next, percent: p };
}

function discountOff(row) {
  const stored = Math.trunc(Number(row.old_price)) || 0;
  if (!stored) return { ok: false, error: 'Скидки на этом товаре и так нет.' };
  return { ok: true, price: stored };
}
// ---------- /Скидки ----------

// ---------- Промокоды ----------
// Правила хранятся в settings.promo_codes строкой «КОД=ПРОЦЕНТ[:БРЕНД][:minСУММА]»
// через запятую. Клиент присылает только код: сумму и право на скидку сервер
// считает сам по ценам из своей базы, поэтому подделать скидку нельзя.
const DEFAULT_PROMO_RULES = 'WATCH10=10,GARMIN5=5:GARMIN,VIP15=15:min50000';
function parsePromoRules(raw) {
  const src = String(raw == null || raw === '' ? DEFAULT_PROMO_RULES : raw);
  const map = new Map();
  for (const part of src.split(/[;,\n]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^([A-Za-z0-9_-]{2,24})\s*[=:]\s*(\d{1,2})(?::(.+))?$/);
    if (!m) continue;
    const code = m[1].toUpperCase();
    const percent = Math.trunc(Number(m[2]));
    if (percent < 1 || percent > 90) continue;
    let brand = '';
    let minTotal = 0;
    for (const token of String(m[3] || '').split(':')) {
      const t = token.trim();
      if (/^min(\d{3,9})$/i.test(t)) minTotal = Math.trunc(Number(t.replace(/\D/g, ''))) || 0;
      else if (t) brand = t.toUpperCase();
    }
    map.set(code, { code, percent, brand, minTotal });
  }
  return map;
}
function serializePromoRules(map) {
  const out = [];
  for (const r of map.values()) {
    let s = `${r.code}=${r.percent}`;
    if (r.brand) s += `:${r.brand}`;
    if (r.minTotal > 0) s += `:min${r.minTotal}`;
    out.push(s);
  }
  return out.join(',');
}
function evaluatePromo(rulesRaw, codeRaw, items, lookupProduct) {
  const code = cleanText(codeRaw).toUpperCase();
  const rules = parsePromoRules(rulesRaw);
  let subtotal = 0;
  let eligible = 0;
  for (const it of items || []) {
    const qty = Math.min(Math.max(Math.trunc(Number(it.qty)) || 1, 1), 99);
    const p = typeof lookupProduct === 'function' ? lookupProduct(Number(it.id)) : it;
    if (!p || !(Number(p.price) > 0)) continue;
    const line = Math.trunc(Number(p.price)) * qty;
    subtotal += line;
    const rule = rules.get(code);
    if (rule && (!rule.brand || String(p.brand || '').toUpperCase() === rule.brand)) eligible += line;
  }
  const none = (error) => ({ ok: false, error, code, percent: 0, subtotal, discountRub: 0, total: subtotal });
  if (!code) return none('Промокод не указан');
  const rule = rules.get(code);
  if (!rule) return none('Промокод не найден или истёк');
  if (rule.minTotal > 0 && subtotal < rule.minTotal) return none(`Промокод ${rule.code} действует при заказе от ${rule.minTotal.toLocaleString('ru-RU')} ₽`);
  if (rule.brand && eligible === 0) return none(`Промокод ${rule.code} действует только на бренд ${rule.brand}`);
  const discountRub = Math.min(subtotal, Math.round(Math.round((eligible * rule.percent) / 100) / 10) * 10);
  return { ok: true, code: rule.code, percent: rule.percent, brand: rule.brand, minTotal: rule.minTotal, subtotal, discountRub, total: Math.max(0, subtotal - discountRub) };
}
function upsertPromoRule(rulesRaw, input) {
  const parts = cleanText(input).split(/\s+/);
  const code = String(parts[0] || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const percent = Math.trunc(Number(String(parts[1] || '').replace(/[^\d]/g, '')));
  if (code.length < 2 || code.length > 24) return { ok: false, error: 'Код — от 2 до 24 символов' };
  if (!Number.isFinite(percent) || percent < 1 || percent > 90) return { ok: false, error: 'Скидка — от 1 до 90%' };
  let brand = '';
  let minTotal = 0;
  for (const tok of parts.slice(2)) {
    if (/^(?:min|от)?(\d{3,9})$/i.test(tok)) minTotal = Math.trunc(Number(tok.replace(/\D/g, '')));
    else if (/^[A-Za-zА-Яа-я]{2,20}$/.test(tok)) brand = tok.toUpperCase();
  }
  const map = parsePromoRules(rulesRaw);
  map.set(code, { code, percent, brand, minTotal });
  return { ok: true, code, percent, brand, minTotal, serialized: serializePromoRules(map) };
}
function removePromoRule(rulesRaw, codeRaw) {
  const code = cleanText(codeRaw).toUpperCase();
  const map = parsePromoRules(rulesRaw);
  if (!map.has(code)) return { ok: false, error: `Промокода ${code || '—'} нет` };
  map.delete(code);
  return { ok: true, code, serialized: serializePromoRules(map) };
}
function promoRulesText(rulesRaw) {
  const map = parsePromoRules(rulesRaw);
  if (!map.size) return 'Активных промокодов нет.';
  const lines = [`Промокоды витрины (${map.size}):`];
  for (const r of map.values()) {
    const cond = [];
    if (r.brand) cond.push(`только ${r.brand}`);
    if (r.minTotal > 0) cond.push(`от ${r.minTotal.toLocaleString('ru-RU')} ₽`);
    lines.push(`• ${r.code} — −${r.percent}%${cond.length ? ` (${cond.join(', ')})` : ''}`);
  }
  return lines.join('\n');
}
// ---------- /Промокоды ----------

initSettingStmt.run('promo_codes', getSetting('promo_codes') || DEFAULT_PROMO_RULES);

// ---------- Импорт каталога ----------
// Набор категорий обязан совпадать с CAT_ORDER на витрине: полки фильтра
// строятся по этому списку, и позиция с «своей» категорией осталась бы
// недоступной нигде, кроме поиска. Тест следит, чтобы списки не разъехались.
const IMPORT_CATEGORIES = ['Спортивные часы', 'Эхолоты', 'Велокомпьютеры', 'GPS навигаторы', 'Фитнес-трекеры', 'Дайвинг компьютеры', 'Охота и дрессировка', 'Пульсометры', 'Аксессуары'];
const IMPORT_MAX_ROWS = 2000;

function extraCategories(conn) {
  const c = conn && conn.prepare ? conn : (typeof db !== 'undefined' ? db : null);
  if (!c) return [];
  try {
    const raw = String(c.prepare('SELECT value FROM settings WHERE key = ?').get('extra_categories')?.value || '');
    return raw.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
  } catch (e) { return []; }
}
function allStoreCategories(conn) {
  return [...IMPORT_CATEGORIES, ...extraCategories(conn).filter((c) => !IMPORT_CATEGORIES.includes(c))];
}
function normalizeCategory(raw, conn) {
  const s = String(raw || '').trim().replace(/ё/g, 'е').toLowerCase();
  if (!s) return null;
  const pool = conn ? allStoreCategories(conn) : IMPORT_CATEGORIES;
  for (const c of pool) {
    if (c.replace(/ё/g, 'е').toLowerCase() === s) return c;
  }
  return null;
}

function parsePriceNumber(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  const n = Number(digits);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function splitImportLine(line) {
  const delim = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
  return line.split(delim).map((c) => cleanText(c.replace(/^"(.*)"$/, '$1')));
}

// Столбцы: бренд;серия;категория;название;цена;описание;фото. Лишние хвосты
// режем, нехватка описания и фото — не беда, без названия/цены/категории — ошибка строки.
function parseImportTable(text, conn) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const n = idx + 1;
    if (!line.trim()) continue;
    const cells = splitImportLine(line);
    const head = `${cells[0] || ''} ${cells.join(' ')}`.toLowerCase();
    // \b с кириллицей в JS не работает (граница слова только для [A-Za-z0-9_])
    if (/^(бренд|brand)/i.test((cells[0] || '').trim()) && /(цен|price)/i.test(head)) continue;
    if (cells.length < 4) {
      errors.push({ line: n, reason: 'столбцов меньше четырёх: бренд;серия;категория;название;цена' });
      continue;
    }
    const [brand, series, category, name, priceRaw, specs, image] = cells;
    if (!brand) { errors.push({ line: n, reason: 'пустой бренд' }); continue; }
    if (!name || name.length < 3) { errors.push({ line: n, reason: 'название пустое или короче трёх знаков' }); continue; }
    const cat = normalizeCategory(category, conn || null);
    if (!cat) { errors.push({ line: n, reason: `категории «${category || ''}» нет среди полок; можно: ${allStoreCategories(conn).join(', ')}` }); continue; }
    const price = parsePriceNumber(priceRaw);
    if (!price) { errors.push({ line: n, reason: `цена «${priceRaw || ''}» не читается — нужно число` }); continue; }
    const row = {
      brand: brand.toUpperCase(),
      series: series || '',
      category: cat,
      name: name.slice(0, 200),
      price,
      specs: String(specs || '').slice(0, 500),
      image: /^https?:\/\//i.test(image || '') ? image.slice(0, 500) : '',
    };
    const key = seedKey(row);
    if (seen.has(key)) { errors.push({ line: n, reason: 'такая строка уже была выше — дубликат' }); continue; }
    seen.add(key);
    rows.push(row);
    if (rows.length > IMPORT_MAX_ROWS) {
      errors.push({ line: n, reason: `больше ${IMPORT_MAX_ROWS} строк за раз не импортируем — разрежь файл` });
      break;
    }
  }
  return { rows, errors };
}

// Позиция считается уже имеющейся по тому же ключу, что и сид: бренд+серия+
// категория+название. Цена не в ключе — иначе правка цены плодила бы дубль.
function classifyImportRows(conn, rows) {
  const knownKeys = new Set(conn.prepare('SELECT seed_key, brand, series, category, name FROM products').all()
    .map((r) => r.seed_key || seedKey(r)));
  const fresh = [];
  const known = [];
  for (const r of rows) (knownKeys.has(seedKey(r)) ? known : fresh).push(r);
  return { fresh, known };
}

function importPreviewText(fresh, known, errors) {
  const byCat = {};
  for (const r of fresh) byCat[r.category] = (byCat[r.category] || 0) + 1;
  const shelf = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).map((c) => `  ${c} — ${byCat[c]}`).join('\n');
  const lines = [
    `Разобрал ${fresh.length + known.length + errors.length} строк.`,
    `Новых позиций: ${fresh.length}.`,
    shelf ? `По полкам:\n${shelf}` : '',
    known.length ? `Уже есть в базе (не трогаем): ${known.length}.` : '',
    errors.length ? `Не записались (${errors.length}), первые:\n${errors.slice(0, 5).map((e) => `  строка ${e.line}: ${e.reason}`).join('\n')}` : '',
    fresh.length ? '' : 'Записывать нечего — поправь файл и пришли ещё раз.',
  ].filter(Boolean);
  return lines.join('\n');
}

function insertImportedRows(conn, rows) {
  const ins = conn.prepare('INSERT INTO products (brand, series, category, name, price, old_price, image, specs, is_hit, seed_key) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?)');
  conn.exec('BEGIN');
  try {
    for (const r of rows) ins.run(r.brand, r.series, r.category, r.name, r.price, r.image, r.specs, seedKey(r));
    conn.exec('COMMIT');
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch (_) { /* транзакции уже нет */ }
    return { added: 0, error: e.message };
  }
  return { added: rows.length, error: '' };
}
// ---------- /Импорт каталога ----------

// ---------- Админка: каталог, заказы, сводка ----------
// Общие для Telegram и MAX функции управления сайтом. Никакого Telegram/MAX
// внутри нет намеренно: боты только показывают кнопки и вызывают их, а вся
// работа с базой проверяется тестами один раз, а не дважды.
const ADMIN_PAGE = 8;
const ADMIN_ORDER_PAGE = 6;
const PRODUCT_FIELD_LABELS = { name: 'Название', brand: 'Бренд', series: 'Серия', category: 'Полка', price: 'Цена', stock: 'Наличие', specs: 'Описание', image: 'Фото' };
const ORDER_STATUS_SET = ['Новый', 'Новый (сайт)', 'Trade-In', 'Trade-In (сайт)', 'В сборке', 'Оплачен', 'Отменен'];
// Кнопки статусов в обоих ботах: короткий ключ -> значение в базе
const ORDER_STATUS_BUTTONS = { neu: 'Новый', trade: 'Trade-In', work: 'В сборке', paid: 'Оплачен', cancel: 'Отменен' };

// Способы доставки — тоже настройка сайта: витрина рисует select из неё,
// API принимает только значение из неё. Формат: через запятую, 1–10 штук.
function deliveryMethods(conn) {  const c = conn || db;
  const raw = String(c.prepare('SELECT value FROM settings WHERE key = ?').get('delivery_methods')?.value || '').trim();
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  return list.length ? list : ['СДЭК', 'Почта России', 'Boxberry'];
}
function normalizeDelivery(conn, raw) {
  const list = deliveryMethods(conn);
  const v = String(raw || '').trim();
  return list.includes(v) ? v : list[0];
}

// Два дизайна витрины. Файлы-источники живут рядом: public/index-stealth.html
// и public/index-classic.html; активный собирается в public/index.html + index.html.
// Админ переключает кнопкой в боте — квадратные метры кода не трогаем, только файлы.
const STORE_DESIGNS = { stealth: 'Stealth Titanium', classic: 'Classic Light' };
function storeDesignName(conn) {
  const v = String((conn || db).prepare('SELECT value FROM settings WHERE key = ?').get('store_design')?.value || 'stealth').trim();
  return STORE_DESIGNS[v] ? v : 'stealth';
}
function setStoreDesign(rootDir, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!STORE_DESIGNS[key]) return { ok: false, error: 'Дизайн: stealth или classic.' };
  const src = path.join(rootDir, 'public', `index-${key}.html`);
  let html;
  try { html = fs.readFileSync(src, 'utf8'); } catch (e) { return { ok: false, error: 'Файл дизайна не найден: ' + src }; }
  if (!html.includes('products-data.js')) return { ok: false, error: 'Файл не похож на витрину: нет подключения каталога.' };
  try {
    fs.writeFileSync(path.join(rootDir, 'public', 'index.html'), html);
    fs.writeFileSync(path.join(rootDir, 'index.html'), html);
  } catch (e) { return { ok: false, error: 'Не записать файлы дизайна: ' + e.message }; }
  setSetting('store_design', key);
  return { ok: true, design: key, label: STORE_DESIGNS[key] };
}

function catalogShelves(conn) {
  const rows = conn.prepare('SELECT category, COUNT(*) AS c FROM products GROUP BY category ORDER BY c DESC').all();
  const total = rows.reduce((s, r) => s + Number(r.c), 0);
  return [{ category: 'Все товары', count: total }, ...rows.map((r) => ({ category: r.category || 'Без категории', count: Number(r.c) }))];
}

function catalogPage(conn, opts) {
  const category = String((opts && opts.category) || 'Все товары');
  const query = String((opts && opts.query) || '').trim();
  const where = [];
  const args = [];
  if (category && category !== 'Все товары') { where.push('category = ?'); args.push(category); }
  const sqlWhere = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  // Без поиска считаем и режем в SQL — 347 строк через JS гонять незачем.
  if (!query) {
    const total = Number(conn.prepare(`SELECT COUNT(*) AS c FROM products${sqlWhere}`).get(...args).c);
    const pages = Math.max(1, Math.ceil(total / ADMIN_PAGE));
    const page = Math.min(Math.max(1, Math.trunc(Number(opts && opts.page)) || 1), pages);
    const items = conn.prepare(`SELECT id, brand, series, category, name, price, old_price, stock, image, specs, is_hit FROM products${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, ADMIN_PAGE, (page - 1) * ADMIN_PAGE);
    return { items, total, pages, page, category, query };
  }
  // Поиск нормализуем в JS: и LOWER(), и UPPER() в SQLite различают регистр
  // только у латиницы, а «Феникс» ищут и строчными, и прописными по-русски.
  const q = query.toUpperCase();
  const rows = conn.prepare(`SELECT id, brand, series, category, name, price, old_price, stock, image, specs, is_hit FROM products${sqlWhere} ORDER BY id DESC`).all(...args)
    .filter((r) => [r.name, r.brand, r.series, r.specs].some((v) => String(v || '').toUpperCase().includes(q)));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / ADMIN_PAGE));
  const page = Math.min(Math.max(1, Math.trunc(Number(opts && opts.page)) || 1), pages);
  return { items: rows.slice((page - 1) * ADMIN_PAGE, page * ADMIN_PAGE), total, pages, page, category, query };
}

function productById(conn, id) {
  return conn.prepare('SELECT id, brand, series, category, name, price, old_price, stock, image, specs, is_hit FROM products WHERE id = ?').get(Number(id)) || null;
}

function productCardText(p) {
  if (!p) return null;
  const off = (Math.trunc(Number(p.old_price)) || 0) > Number(p.price);
  return [
    `#${p.id} ${p.name}`,
    `Бренд: ${p.brand || '—'} · Серия: ${p.series || '—'}`,
    `Полка: ${p.category || '—'}`,
    `Цена: ${Number(p.price).toLocaleString('ru-RU')} ₽${off ? `, до уценки ${Number(p.old_price).toLocaleString('ru-RU')} ₽` : ''}`,
    `Хит: ${Number(p.is_hit) ? 'да' : 'нет'}`,
    `Наличие: ${(p.stock ?? 4)} шт.`,
    `Фото: ${p.image || 'нет'}`,
    `Описание: ${p.specs || '—'}`,
  ].join('\n');
}

// Одно поле за раз. Категория проверяется по полкам витрины, цена — только
// число, фото — ссылка http(s) или пусто; файлом меняет отдельный шаг бота.
function setProductField(conn, id, field, raw) {
  const p = productById(conn, id);
  if (!p) return { ok: false, error: 'Товар не найден — обнови список.' };
  const value = cleanText(raw);
  if (hasReplacement(value)) return { ok: false, error: 'Символы не читаются — пришли значение в UTF-8.' };
  if (field === 'price') {
    const n = Math.trunc(Number(value.replace(/\D/g, '')));
    if (!n) return { ok: false, error: 'Цена — число, например 58990.' };
    conn.prepare('UPDATE products SET price = ? WHERE id = ?').run(n, p.id);
  } else if (field === 'stock') {
    const raw = String(value).trim();
    if (!/^-?\d+$/.test(raw)) return { ok: false, error: 'Наличие — число штук от 0 (под заказ) до 9999.' };
    const sn = Math.trunc(Number(raw));
    if (!Number.isSafeInteger(sn) || sn < 0 || sn > 9999) return { ok: false, error: 'Наличие — число штук от 0 (под заказ) до 9999.' };
    conn.prepare('UPDATE products SET stock = ? WHERE id = ?').run(sn, p.id);
  } else if (field === 'category') {
    const cat = normalizeCategory(value, conn);
    if (!cat) return { ok: false, error: `Такой полки нет. Можно: ${allStoreCategories(conn).join(', ')}` };
    conn.prepare('UPDATE products SET category = ? WHERE id = ?').run(cat, p.id);
  } else if (field === 'image') {
    if (value && !/^https?:\/\//i.test(value)) return { ok: false, error: 'Фото — ссылка http(s)://…, или пусто, чтобы убрать картинку.' };
    conn.prepare('UPDATE products SET image = ? WHERE id = ?').run(value.slice(0, 500), p.id);
  } else if (field === 'brand') {
    if (value.length < 2) return { ok: false, error: 'Бренд короче двух знаков.' };
    conn.prepare('UPDATE products SET brand = ? WHERE id = ?').run(value.slice(0, 40), p.id);
  } else if (field === 'name' || field === 'series' || field === 'specs') {
    if (field === 'name' && value.length < 3) return { ok: false, error: 'Название короче трёх знаков.' };
    const cap = field === 'name' ? 200 : field === 'specs' ? 500 : 80;
    conn.prepare(`UPDATE products SET ${field} = ? WHERE id = ?`).run(value.slice(0, cap), p.id);
  } else {
    return { ok: false, error: 'Неизвестное поле товара.' };
  }
  return { ok: true, row: productById(conn, p.id) };
}

function toggleProductHit(conn, id) {
  const p = productById(conn, id);
  if (!p) return { ok: false, error: 'Товар не найден.' };
  const next = Number(p.is_hit) ? 0 : 1;
  conn.prepare('UPDATE products SET is_hit = ? WHERE id = ?').run(next, p.id);
  return { ok: true, hit: next, row: productById(conn, p.id) };
}

function deleteProductById(conn, id) {
  const p = productById(conn, id);
  if (!p) return { ok: false, error: 'Товар не найден.' };
  conn.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  return { ok: true, id: p.id, name: p.name };
}

function orderStatusBreakdown(conn) {
  return conn.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status ORDER BY c DESC').all()
    .map((r) => ({ status: r.status || '—', count: Number(r.c) }));
}

function ordersPage(conn, opts) {
  const status = String((opts && opts.status) || 'Все');
  const query = String((opts && opts.query) || '').trim();
  const where = [];
  const args = [];
  if (status && status !== 'Все') { where.push('status = ?'); args.push(status); }
  const sqlWhere = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  // Без поиска — COUNT + LIMIT/OFFSET в SQL, без поиска по JSON в JS.
  if (!query) {
    const total = Number(conn.prepare(`SELECT COUNT(*) AS c FROM orders${sqlWhere}`).get(...args).c);
    const pages = Math.max(1, Math.ceil(total / ADMIN_ORDER_PAGE));
    const page = Math.min(Math.max(1, Math.trunc(Number(opts && opts.page)) || 1), pages);
    const items = conn.prepare(`SELECT id, order_code, total, status, created_at FROM orders${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, ADMIN_ORDER_PAGE, (page - 1) * ADMIN_ORDER_PAGE);
    return { items, total, pages, page, status, query };
  }
  // Тот же регистр по-русски, что и в каталоге: нормализуем в JS, а не в SQL.
  const q = query.toUpperCase();
  const full = conn.prepare(`SELECT order_code, customer_json, items_json FROM orders${sqlWhere}`).all(...args);
  const hit = new Set(full.filter((r) => [r.order_code, r.customer_json, r.items_json].some((v) => String(v || '').toUpperCase().includes(q)))
    .map((r) => r.order_code));
  const rows = conn.prepare(`SELECT id, order_code, total, status, created_at FROM orders${sqlWhere} ORDER BY id DESC`).all(...args)
    .filter((r) => hit.has(r.order_code));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / ADMIN_ORDER_PAGE));
  const page = Math.min(Math.max(1, Math.trunc(Number(opts && opts.page)) || 1), pages);
  return { items: rows.slice((page - 1) * ADMIN_ORDER_PAGE, page * ADMIN_ORDER_PAGE), total, pages, page, status, query };
}

function orderCardText(conn, code) {
  const o = conn.prepare('SELECT order_code, items_json, total, status, created_at, customer_json, owner_tg, promo_code, discount FROM orders WHERE order_code = ?').get(String(code || '').toUpperCase());
  if (!o) return null;
  let items = [];
  let cust = {};
  try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
  try { cust = JSON.parse(o.customer_json || '{}'); } catch (e) { cust = {}; }
  const lines = [
    `ЗАЯВКА ${o.order_code} — ${o.status}`,
    `Создана: ${o.created_at || '—'}`,
    `Состав, позиций: ${items.length}`,
    ...items.map((i, n) => `  ${n + 1}. ${i.name} × ${i.qty} = ${Number(i.price).toLocaleString('ru-RU')} ₽`),
    `Итого: ${Number(o.total).toLocaleString('ru-RU')} ₽`,
    ...(o.promo_code ? [`Промокод ${o.promo_code}${Number(o.discount) > 0 ? `: −${Number(o.discount).toLocaleString('ru-RU')} ₽` : ': скидка 0 ₽ (условия не выполнены)'}`] : []),
  ];
  if (cust.fio || cust.phone) lines.push(`Клиент: ${cust.fio || '—'} · ${cust.phone || '—'}`);
  if (cust.email) lines.push(`Почта: ${cust.email}`);
  if (cust.address) lines.push(`Адрес: ${cust.address}`);
  if (cust.delivery) lines.push(`Доставка: ${cust.delivery}`);
  if (o.owner_tg) lines.push(`TG покупателя: ${o.owner_tg}`);
  return lines.join('\n');
}

function setOrderStatus(conn, code, status) {
  const o = conn.prepare('SELECT order_code FROM orders WHERE order_code = ?').get(String(code || '').toUpperCase());
  if (!o) return { ok: false, error: 'Заявка не найдена.' };
  if (ORDER_STATUS_SET.indexOf(status) < 0) return { ok: false, error: `Неизвестный статус. Можно: ${ORDER_STATUS_SET.join(', ')}` };
  conn.prepare('UPDATE orders SET status = ? WHERE order_code = ?').run(status, o.order_code);
  return { ok: true, code: o.order_code, status };
}

// Отчёт о картинках: заказчик жалуется, что полку не узнать — на большинстве
// позиций сток Unsplash, и одна и та же фотография повторяется десятки раз.
function stockPhotoReport(conn) {
  const rows = conn.prepare('SELECT id, name, image FROM products').all();
  const byHost = {};
  const repeats = new Map();
  let own = 0;
  for (const r of rows) {
    const img = String(r.image || '');
    if (!img) { byHost['без картинки'] = (byHost['без картинки'] || 0) + 1; continue; }
    if (img.includes('/uploads/')) { own++; continue; }
    let host = 'другое';
    try { host = new URL(img).hostname; } catch (e) { host = 'битая ссылка'; }
    byHost[host] = (byHost[host] || 0) + 1;
    const key = img.split('?')[0];
    const seen = repeats.get(key) || [];
    seen.push(r);
    repeats.set(key, seen);
  }
  const duplicated = [...repeats.entries()].filter(([, list]) => list.length > 1).sort((a, b) => b[1].length - a[1].length);
  const lines = [
    'Картинки каталога',
    `Всего позиций: ${rows.length} · своих (загружено в админку): ${own}`,
    ...Object.entries(byHost).sort((a, b) => b[1] - a[1]).map(([h, c]) => `  ${h} — ${c}`),
    duplicated.length
      ? `Повторов: ${duplicated.length} картинок используются на нескольких позициях, чаще всего:\n${duplicated.slice(0, 5).map(([url, list]) => `  ${list.length}× ${url.split('?')[0].split('/').pop()}`).join('\n')}`
      : 'Повторов нет: каждая картинка уникальна.',
    own === 0 ? 'Ни одного реального фото товара: витрина выглядит как макет. Фото грузится в боте — «Добавить часы» шагом 6 или «Фото» в карточке товара.' : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function deleteOrderByCode(conn, code) {
  const o = conn.prepare('SELECT order_code, total, status FROM orders WHERE order_code = ?').get(String(code || '').toUpperCase());
  if (!o) return { ok: false, error: 'Заявка не найдена.' };
  conn.prepare('DELETE FROM orders WHERE order_code = ?').run(o.order_code);
  return { ok: true, code: o.order_code, status: o.status, total: Number(o.total) };
}

// Ручная заявка из бота: те же правила, что у /api/order — цены только из базы,
// ФИО и телефон обязательны. items: [{id, qty}].
function parseManualItems(raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  const items = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:[xх×*]\s*(\d+))?$/i);
    if (!m) return { ok: false, error: `Не понял «${part}» — формат: ID или IDxкол-во через запятую, например 12x2, 45.` };
    const qty = m[2] ? Math.trunc(Number(m[2])) : 1;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 99) return { ok: false, error: `Количество у «${part}»: 1–99.` };
    items.push({ id: Number(m[1]), qty });
  }
  if (!items.length) return { ok: false, error: 'Пусто: пришли ID товаров через запятую, например 12x2, 45.' };
  if (items.length > 50) return { ok: false, error: 'Больше 50 позиций за раз нельзя.' };
  return { ok: true, items };
}
function createManualOrder(conn, { items, fio, phone, delivery }) {
  const customer = {
    fio: String(fio || '').trim().slice(0, 100),
    phone: String(phone || '').trim().slice(0, 30),
  };
  if (!customer.fio) return { ok: false, error: 'Нужно ФИО покупателя.' };
  if (customer.phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'Телефон короче 10 цифр.' };
  const cleanItems = [];
  for (const it of items || []) {
    const prod = conn.prepare('SELECT id, name, price FROM products WHERE id = ?').get(Number(it.id));
    if (!prod) return { ok: false, error: `Товара #${it.id} нет в базе.` };
    const qty = Math.trunc(Number(it.qty)) || 1;
    cleanItems.push({ id: prod.id, name: String(prod.name).slice(0, 200), price: prod.price, qty });
  }
  if (!cleanItems.length) return { ok: false, error: 'Пустой состав.' };
  const total = cleanItems.reduce((s, i) => s + i.price * i.qty, 0);
  const code = allocateOrderCode();
  conn.prepare('INSERT INTO orders (order_code, items_json, total, status, customer_json) VALUES (?, ?, ?, ?, ?)')
    .run(code, JSON.stringify(cleanItems), total, 'Новый', JSON.stringify({ ...customer, delivery: normalizeDelivery(conn, delivery) }));
  return { ok: true, code, total };
}

function adminSummary(conn, settings) {  const shelves = catalogShelves(conn);
  const products = shelves[0].count;
  const hits = Number(conn.prepare('SELECT COUNT(*) AS c FROM products WHERE is_hit > 0').get().c);
  const discounted = Number(conn.prepare('SELECT COUNT(*) AS c FROM products WHERE old_price > price').get().c);
  const orders = Number(conn.prepare('SELECT COUNT(*) AS c FROM orders').get().c);
  const week = Number(conn.prepare("SELECT COUNT(*) AS c FROM orders WHERE created_at >= datetime('now','-7 days')").get().c);
  const waiting = Number(conn.prepare("SELECT COUNT(*) AS c FROM orders WHERE status IN ('Новый','Новый (сайт)','Trade-In','Trade-In (сайт)')").get().c);
  const paid = Number(conn.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status = 'Оплачен'").get().s);
  const lines = [
    'Сводка сайта',
    `Товаров: ${products} · хитов: ${hits} · со скидкой: ${discounted}`,
    `Полки: ${shelves.slice(1).map((s) => `${s.category} — ${s.count}`).join(', ') || '—'}`,
    `Заявок: ${orders} · за 7 дней: ${week} · ждут действия: ${waiting}`,
    `По статусам: ${orderStatusBreakdown(conn).map((s) => `${s.status} — ${s.count}`).join(', ') || '—'}`,
    `Оплачено на сумму: ${paid.toLocaleString('ru-RU')} ₽`,
  ];
  if (settings) lines.push(`Реквизиты на сайте: ${String(settings.show_payment) === '1' ? 'показаны' : 'скрыты'}`);
  return lines.join('\n');
}
// ---------- /Админка ----------

function fileCatalog() {
  try {
    return readCatalogFile(fs.readFileSync(CATALOG_FILES[0], 'utf8')) || [];
  } catch (e) {
    return [];
  }
}

function exportCatalog(force) {
  const rows = catalogFromDb();
  const current = fileCatalog();
  const diff = diffCatalog(current, rows);
  if (!force && current.length && rows.length < current.length) {
    return {
      blocked: true,
      diff,
      text: `Экспорт остановлен: в базе ${rows.length} позиций, в файле ${current.length}. Сначала разберитесь с потерей — либо подтвердите принудительно.`,
    };
  }
  const text = renderCatalogFile(rows);
  const validate = (src) => {
    const parsed = readCatalogFile(src);
    return Array.isArray(parsed) && parsed.length === rows.length ? true : false;
  };
  if (!validate(text)) {
    return { blocked: true, diff, text: 'Экспорт остановлен: сгенерированный файл не читается обратно. Ни один файл не тронут.' };
  }
  const res = commitCatalogFiles(CATALOG_FILES, text, validate);
  return { blocked: false, diff, written: res.written, failed: res.failed, aborted: res.aborted, rows: rows.length };
}

// ---------- Публикация на GitHub Pages ----------
// Витрина без сервера читает каталог из products-data.js, поэтому правка админки
// становится видимой покупателю только после коммита в репозиторий. Кнопка в
// бота делает именно это: выгрузка, синхронизация зеркал, коммит и push.
const PUBLISH_PATHS = ['products-data.js', 'public/products-data.js', 'index.html', 'public/index.html', 'manifest.json', 'public/manifest.json', 'robots.txt', 'public/robots.txt', 'sitemap.xml', 'public/sitemap.xml', 'uploads', 'public/uploads'];
let publishInFlight = false;

// Подсказка к ошибке push: её причина зависит от того, откуда берётся доступ.
function pushFailureNote(via) {
  if (via !== 'saved credentials') return '';
  return '\nСейчас бот пушит через сохранённые в git креды. Если они пустые или отозванные (проверка: `gh auth status`), впиши fine-grained PAT с правами Contents: Write в GITHUB_PUSH_TOKEN в .env и перезапусти сервер.';
}

// Токен не обязателен: на машине, где git уже имеет доступ к репозиторию,
// пуш идёт через сохранённые креды. Если GITHUB_PUSH_TOKEN задан — пуш идёт
// явным URL, а remote в .git/config не переписывается, чтобы секрет не осел
// на диске и не поехал вместе с репозиторием.
function publishPlan(env) {
  const remote = String(env.GITHUB_PUSH_REMOTE || 'https://github.com/ssrjkk/shopwatch.git');
  const branch = String(env.GITHUB_PUSH_BRANCH || 'main');
  const token = String(env.GITHUB_PUSH_TOKEN || '').trim();
  if (!token) return { branch, args: ['push', 'origin', `HEAD:refs/heads/${branch}`], via: 'saved credentials' };
  const url = remote.replace(/^(https?:\/\/)/, `$1x-access-token:${token}@`);
  return { branch, args: ['push', url, `HEAD:refs/heads/${branch}`], via: 'GITHUB_PUSH_TOKEN' };
}

function runGit(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: __dirname, windowsHide: true, timeout: timeoutMs || 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: redactSecrets(String(stdout || '').trim()),
        err: redactSecrets(String(stderr || (err && err.message) || '').trim()),
      }));
  });
}

function runSyncPages() {
  return new Promise((resolve) => {
    execFile(process.execPath, ['sync-pages.js'], { cwd: __dirname, windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => resolve({ ok: !err, text: redactSecrets(`${String(stdout || '')}${String(stderr || '')}`.trim()) }));
  });
}

// Что ушло бы в публикацию прямо сейчас. Ничего не пишет и не отправляет.
async function publishPreview() {
  const st = await runGit(['status', '--porcelain', '--', ...PUBLISH_PATHS]);
  if (!st.ok && !st.out) return { ok: false, error: `git status не ответил: ${st.err || st.out}` };
  const plan = publishPlan(process.env);
  return {
    ok: true,
    files: st.out.split('\n').map((l) => l.trim()).filter(Boolean),
    dbRows: catalogFromDb().length,
    fileRows: fileCatalog().length,
    branch: plan.branch,
    via: plan.via,
  };
}

async function publishCatalog(actorLabel) {
  if (publishInFlight) return { ok: false, error: 'Публикация уже идёт — дождись завершения.' };
  publishInFlight = true;
  try {
    const exp = exportCatalog(true);
    if (exp.blocked) return { ok: false, error: exp.text };
    if (exp.failed.length) return { ok: false, error: `Файл каталога не записан: ${exp.failed.join('; ')}` };
    const sync = await runSyncPages();
    if (!sync.ok) return { ok: false, error: `Зеркала не синхронизированы: ${sync.text}` };
    const st = await runGit(['status', '--porcelain', '--', ...PUBLISH_PATHS]);
    const files = st.out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!files.length) return { ok: true, nothing: true, text: 'Публиковать нечего: файлы каталога уже совпадают с репозиторием.' };
    const add = await runGit(['add', '--', ...PUBLISH_PATHS]);
    if (!add.ok) return { ok: false, error: `git add: ${add.err}` };
    const msg = `data: publish catalog from the admin bot (${catalogFromDb().length} positions)` +
      (actorLabel ? `\n\nRequested by ${actorLabel} from the bot admin menu.` : '');
    const commit = await runGit(['commit', '-m', msg]);
    if (!commit.ok) return { ok: false, error: `git commit: ${commit.err}` };
    const sha = ((commit.out.match(/\[[\w\/-]+ ([0-9a-f]{7,40})\]/) || [])[1] || '');
    const plan = publishPlan(process.env);
    let push = await runGit(plan.args);
    for (let attempt = 1; !push.ok && attempt <= 3; attempt++) {
      const transient = /rate limit|temporarily|timeout|timed out|502|503|504|fetch first|non-fast-forward|stale info/i.test(push.err || '');
      if (!transient) break;
      if (/non-fast-forward|fetch first|stale info/i.test(push.err || '')) {
        const pull = await runGit(['pull', '--rebase', 'origin', plan.branch]);
        if (!pull.ok) { push = { ok: false, err: push.err + ' | rebase: ' + pull.err }; break; }
      } else {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      push = await runGit(plan.args);
    }
    if (!push.ok) {
      return { ok: false, committed: sha, error: `Коммит ${sha.slice(0, 7)} создан локально, но push не прошёл (3 попытки): ${push.err}\nВ репозиторий ничего не ушло; разберись с доступом и нажми кнопку ещё раз.${pushFailureNote(plan.via)}` };
    }
    return {
      ok: true,
      sha,
      branch: plan.branch,
      files: files.length,
      text: `Опубликовано: ${sha.slice(0, 7)} в ${plan.branch} (файлов: ${files.length}, через ${plan.via}). GitHub Pages пересоберёт витрину сам, обычно 1–2 минуты.`,
    };
  } finally {
    publishInFlight = false;
  }
}
// ---------- /Публикация ----------

// ---------- API ----------
let tgBot = null;

// ---------- TG admins ----------
// Админов может быть несколько: ID через запятую в TG_ADMIN_ID плюс юзернеймы в
// TG_ADMIN_USERNAMES. Юзернейм превращается в ID при первом сообщении админа,
// поэтому числовой ID заказчика знать заранее не нужно.
const tgExtraAdminIds = new Set();
const tgExtraAdminUsernames = new Set();
function tgAdminEnvIds() {
  return String(process.env.TG_ADMIN_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function tgAdminEnvUsernames() {
  return String(process.env.TG_ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}
function tgAdminIdList() {
  return [...new Set([...tgAdminEnvIds(), ...tgExtraAdminIds])];
}
function tgAdminUsernameList() {
  return [...new Set([...tgAdminEnvUsernames(), ...tgExtraAdminUsernames])];
}
function loadTgAdminExtras() {
  for (const part of String(getSetting('tg_extra_admin_ids') || '').split(',')) {
    const v = part.trim();
    if (v) tgExtraAdminIds.add(v);
  }
  for (const part of String(getSetting('tg_extra_admin_usernames') || '').split(',')) {
    const v = part.trim().replace(/^@/, '').toLowerCase();
    if (v) tgExtraAdminUsernames.add(v);
  }
}
function saveTgAdminExtras() {
  setSetting('tg_extra_admin_ids', [...tgExtraAdminIds].join(','));
  setSetting('tg_extra_admin_usernames', [...tgExtraAdminUsernames].join(','));
}
function normalizeTgUsername(raw) {
  return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}
// 'ok' | 'bad' | 'env': админов из .env убрать из бота нельзя, они база доступа
function addTgAdminId(raw) {
  const v = String(raw || '').trim();
  if (!/^\d{3,15}$/.test(v)) return 'bad';
  if (tgAdminEnvIds().includes(v)) return 'env';
  tgExtraAdminIds.add(v);
  saveTgAdminExtras();
  return 'ok';
}
function removeTgAdminId(raw) {
  const v = String(raw || '').trim();
  if (tgAdminEnvIds().includes(v)) return 'env';
  if (!tgExtraAdminIds.delete(v)) return 'none';
  saveTgAdminExtras();
  return 'ok';
}
function addTgAdminUsername(raw) {
  const v = normalizeTgUsername(raw);
  if (!/^[a-z0-9_]{3,32}$/.test(v)) return 'bad';
  if (tgAdminEnvUsernames().includes(v)) return 'env';
  tgExtraAdminUsernames.add(v);
  saveTgAdminExtras();
  return 'ok';
}
function removeTgAdminUsername(raw) {
  const v = normalizeTgUsername(raw);
  if (tgAdminEnvUsernames().includes(v)) return 'env';
  if (!tgExtraAdminUsernames.delete(v)) return 'none';
  saveTgAdminExtras();
  return 'ok';
}
function tgAdminRoster() {
  const rows = [];
  for (const id of tgAdminEnvIds()) rows.push({ source: '.env', kind: 'id', value: id });
  for (const u of tgAdminEnvUsernames()) rows.push({ source: '.env', kind: 'username', value: u });
  for (const id of tgExtraAdminIds) rows.push({ source: 'бот', kind: 'id', value: id });
  for (const u of tgExtraAdminUsernames) rows.push({ source: 'бот', kind: 'username', value: u });
  return rows;
}
function isTgAdminCtx(ctx) {
  const id = String(ctx?.from?.id || '');
  if (!id) return false;
  if (tgAdminIdList().includes(id)) return true;
  const username = normalizeTgUsername(ctx.from?.username);
  if (username && tgAdminUsernameList().includes(username)) {
    // Запоминаем числовой ID, чтобы админ работал и после смены юзернейма
    tgExtraAdminIds.add(id);
    saveTgAdminExtras();
    return true;
  }
  return false;
}
function notifyTgAdmins(text, options) {
  const ids = tgAdminIdList();
  if (!tgBot || !ids.length) return;
  for (const id of ids) {
    tgBot.telegram.sendMessage(id, text, options).catch((e) => console.error('TG Send Error:', redactSecrets(e.message)));
  }
}

app.get('/api/state', (req, res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  const clean = Object.fromEntries(Object.entries(settings).filter(([k]) => k !== 'payment_details'));
  // Ссылка на MAX показывается на витрине только когда MAX-бот действительно настроен,
  // иначе покупатель уходит в 404.
  if (!isValidEnv(process.env.MAX_BOT_TOKEN) || !isValidEnv(settings.max_link)) clean.max_link = '';
  res.json({ settings: clean, products });
});

// Состояния старых часов для Trade-In; ключи совпадают с селектом на витрине
const TI_COND_TEXT = { 1: 'новые, не носились', 2: 'отличное состояние', 3: 'рабочие, есть следы использования', 4: 'неисправны, на запчасти' };

// Статус заявки для кабинета «Мои заказы». Без кода заявки и последних 4 цифр
// телефона покупателя ничего не отдаём: номера TG-XXXX идут подряд, перебирать
// их без второго фактора не нужно давать никому.
app.get('/api/order-status', (req, res) => {
  const lip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!lookupAllowed(lip, 60)) return res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
  const code = String(req.query.code || '').trim().toUpperCase();
  const pt = String(req.query.pt || '').replace(/\D/g, '');
  if (!/^TG-\d+$/.test(code) || pt.length < 4) return res.status(400).json({ error: 'Нужны код заявки и последние 4 цифры телефона' });
  const order = db.prepare('SELECT status, created_at, customer_json FROM orders WHERE order_code = ?').get(code);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  let phone = '';
  try { phone = String(JSON.parse(order.customer_json || '{}').phone || ''); } catch (e) { phone = ''; }
  if (phone.replace(/\D/g, '').slice(-4) !== pt.slice(-4)) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json({ code, status: order.status, createdAt: order.created_at });
});

app.post('/api/promo-check', (req, res) => {
  const lip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!lookupAllowed(lip, 60)) return res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const code = cleanText(typeof body.code === 'string' ? body.code : body.promo).slice(0, 24);
    if (!code) return res.status(400).json({ error: 'Введите промокод' });
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    if (!rawItems.length) return res.status(400).json({ error: 'Корзина пуста' });
    const items = [];
    for (const it of rawItems) {
      const id = Number(it && it.id);
      const qty = Number(it && it.qty);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad item id' });
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ error: 'Bad item quantity' });
      items.push({ id, qty });
    }
    // Цены для расчёта берутся из базы, а не из запроса: иначе код можно применить
    // к подставленной сумме.
    const ev = evaluatePromo(getSetting('promo_codes'), code, items, (id) => db.prepare('SELECT id, brand, price FROM products WHERE id = ?').get(id));
    if (!ev.ok) return res.status(400).json({ error: ev.error });
    res.json({ code: ev.code, percent: ev.percent, subtotal: ev.subtotal, discount: ev.discountRub, total: ev.total });
  } catch (e) {
    res.status(400).json({ error: 'Некорректный запрос' });
  }
});

app.get('/healthz', (req, res) => {
  try {
    const products = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
    const orders = db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
    res.json({ ok: true, products, orders, uptime: Math.round(process.uptime()) });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Развёрнутая самодиагностика: база, целостность, диск, свежесть бекапа,
// последняя публикация и рассинхрон витрина↔база. 503 при любой проблеме.
app.get('/health', (req, res) => {
  const checks = {};
  try { db.prepare('SELECT 1 AS x').get(); checks.db = 'ok'; }
  catch (e) { checks.db = 'FAIL: ' + maskPhone(redactSecrets(e.message)).slice(0, 120); }
  try {
    const r = db.prepare('PRAGMA quick_check').get();
    const v = r ? Object.values(r)[0] : null;
    checks.integrity = (v === 'ok' || v === 'OK') ? 'ok' : 'FAIL: ' + String(v).slice(0, 80);
  } catch (e) { checks.integrity = 'FAIL: ' + maskPhone(redactSecrets(e.message)).slice(0, 120); }
  try {
    const dir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname;
    const st = fs.statfsSync(dir);
    const freeMb = Math.floor(Number(st.bavail) * Number(st.bsize) / 1048576);
    checks.disk_mb_free = freeMb;
    checks.disk = freeMb > 500 ? 'ok' : 'LOW';
  } catch (e) { checks.disk = 'unknown'; }
  try {
    const last = getSetting('last_backup_at');
    const ageH = last ? (Date.now() - Date.parse(last)) / 3600000 : 9999;
    checks.backup_age_h = Math.round(ageH * 10) / 10;
    checks.backup = ageH < 26 ? 'ok' : 'STALE';
  } catch (e) { checks.backup = 'unknown'; }
  try {
    const p = JSON.parse(getSetting('publish_last') || 'null');
    checks.publish = p && p.ok === false ? ('FAIL: ' + String(p.error || 'unknown')).slice(0, 160) : 'ok';
  } catch (e) { checks.publish = 'unknown'; }
  try {
    const dbCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
    let fileCount = -1;
    try {
      const { readCatalogFile } = require('./catalog-export.js');
      const rows = readCatalogFile(fs.readFileSync(path.join(__dirname, 'public', 'products-data.js'), 'utf8'));
      if (rows) fileCount = rows.length;
    } catch (e) {}
    checks.catalog_db = dbCount;
    checks.catalog_file = fileCount;
    checks.catalog = (fileCount >= 0 && fileCount !== dbCount) ? 'DRIFT' : 'ok';
  } catch (e) { checks.catalog = 'unknown'; }
  const bad = Object.entries(checks).filter(([, v]) => /FAIL|LOW|STALE|DRIFT/.test(String(v)));
  res.status(bad.length ? 503 : 200).json({ ok: bad.length === 0, checks, uptime: Math.round(process.uptime()) });
});

// ---------- Защита заказов: идемпотентность, остатки, аудит, маскировка ----------
function maskPhone(value) {
  return String(value == null ? '' : value).replace(/(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g, '+7 (***) ***-**-**');
}
function claimIdempotencyKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(key)) return { ok: false };
  try {
    const hit = db.prepare('SELECT order_code, total FROM orders WHERE order_code = (SELECT order_code FROM idempotency_keys WHERE key = ?)').get(key);
    if (hit) return { ok: true, duplicate: true, orderCode: hit.order_code, total: hit.total };
  } catch (e) { return { ok: false }; }
  return { ok: true, duplicate: false };
}
function rememberIdempotencyKey(key, orderCode) {
  try { db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, order_code) VALUES (?, ?)').run(key, orderCode); } catch (e) {}
}
function auditLog(entry) {
  try {
    const cut = (v) => {
      if (v == null) return null;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
    };
    db.prepare('INSERT INTO audit_log (actor, entity, entity_id, action, old_value, new_value, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(entry.actor || 'system').slice(0, 60), String(entry.entity || '').slice(0, 30), String(entry.entityId || '').slice(0, 100), String(entry.action || '').slice(0, 30), cut(entry.oldV), cut(entry.neW), String(entry.source || 'api').slice(0, 20));
  } catch (e) { console.error('audit failed:', redactSecrets(e.message)); }
}
// Лёгкий sliding-window лимит для читающих ручек (статус заявки, промокод): до 60/мин с IP.
const lookupRateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of lookupRateLimit) {
    const fresh = arr.filter((t) => now - t < 60000);
    if (fresh.length) lookupRateLimit.set(ip, fresh);
    else lookupRateLimit.delete(ip);
  }
  if (typeof orderRateLimit !== "undefined") {
    for (const [ip, ts] of orderRateLimit) {
      if (now - ts > 300000) orderRateLimit.delete(ip);
    }
  }
  if (typeof maxSessions !== "undefined" && maxSessions.size > 500) {
    const firstKey = maxSessions.keys().next().value;
    if (firstKey !== undefined) maxSessions.delete(firstKey);
  }
}, 30000).unref?.();
function lookupAllowed(ip, limit) {
  const now = Date.now();
  const arr = (lookupRateLimit.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= (limit || 60)) return false;
  arr.push(now);
  lookupRateLimit.set(ip, arr);
  return true;
}

// ---------- Владелец: статистика, журнал, дайджест ----------
// Чистые функции на conn (тестируются без ботов): вся правда только из базы.
function fmtMoney(n) {
  return Number(n || 0).toLocaleString('ru-RU') + ' ₽';
}
function salesStats(conn, days, back) {
  const d = Math.max(1, Math.min(366, Math.trunc(Number(days)) || 1));
  const b = Math.max(0, Math.min(366, Math.trunc(Number(back)) || 0));
  const r = conn.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS s,
    COALESCE(SUM(CASE WHEN status = 'Оплачен' THEN 1 ELSE 0 END),0) AS pc,
    COALESCE(SUM(CASE WHEN status = 'Оплачен' THEN total ELSE 0 END),0) AS ps
    FROM orders WHERE date(created_at) BETWEEN date('now', '-' || ? || ' days') AND date('now', '-' || ? || ' days')`).get(b + d - 1, b);
  const avg = r.c ? Math.round(r.s / r.c) : 0;
  return { count: r.c, sum: r.s, paid_count: r.pc, paid_sum: r.ps, avg, conv: r.c ? Math.round((100 * r.pc) / r.c) : 0 };
}
function topProducts(conn, days, lim, back) {
  const d = Math.max(1, Math.min(366, Math.trunc(Number(days)) || 1));
  const b = Math.max(0, Math.min(366, Math.trunc(Number(back)) || 0));
  const rows = conn.prepare(`SELECT items_json FROM orders WHERE date(created_at) BETWEEN date('now', '-' || ? || ' days') AND date('now', '-' || ? || ' days') AND status != 'Отменен' AND status != 'Отменён'`).all(b + d - 1, b);
  const agg = new Map();
  for (const r of rows) {
    let items = [];
    try { items = JSON.parse(r.items_json || '[]'); } catch (e) { items = []; }
    for (const it of items) {
      const id = Number(it && it.id) || 0;
      if (!id) continue;
      const k = id + '|' + String(it.name || '');
      const a = agg.get(k) || { id, name: String(it.name || ''), qty: 0, sum: 0 };
      a.qty += Number(it.qty) || 0;
      a.sum += (Number(it.price) || 0) * (Number(it.qty) || 0);
      agg.set(k, a);
    }
  }
  return [...agg.values()].sort((x, y) => y.sum - x.sum).slice(0, Math.max(1, Math.min(20, lim || 5)));
}
function topCategories(conn, days, lim, back) {
  const d = Math.max(1, Math.min(366, Math.trunc(Number(days)) || 1));
  const b = Math.max(0, Math.min(366, Math.trunc(Number(back)) || 0));
  const byId = new Map(conn.prepare('SELECT id, category FROM products').all().map((p) => [Number(p.id), p.category || 'Без категории']));
  const rows = conn.prepare(`SELECT items_json FROM orders WHERE date(created_at) BETWEEN date('now', '-' || ? || ' days') AND date('now', '-' || ? || ' days') AND status != 'Отменен' AND status != 'Отменён'`).all(b + d - 1, b);
  const agg = new Map();
  for (const r of rows) {
    let items = [];
    try { items = JSON.parse(r.items_json || '[]'); } catch (e) { items = []; }
    for (const it of items) {
      if (!Number(it && it.id)) continue;
      const cat = byId.get(Number(it.id)) || 'Без категории';
      const a = agg.get(cat) || { cat, qty: 0, sum: 0 };
      a.qty += Number(it.qty) || 0;
      a.sum += (Number(it.price) || 0) * (Number(it.qty) || 0);
      agg.set(cat, a);
    }
  }
  return [...agg.values()].sort((x, y) => y.sum - x.sum).slice(0, Math.max(1, Math.min(20, lim || 5)));
}
function activePromoCount(rulesRaw) {
  try { return parsePromoRules(rulesRaw).size; } catch (e) { return 0; }
}
function lowStock(conn, lim) {
  return conn.prepare('SELECT id, brand, name, stock FROM products WHERE stock IS NOT NULL AND stock <= 3 ORDER BY stock, id LIMIT ?').all(Math.max(1, Math.min(50, lim || 10)));
}
function statsText(conn, days) {
  const d = Math.max(1, Math.min(366, Math.trunc(Number(days)) || 1));
  const label = d === 1 ? 'сегодня' : d === 7 ? '7 дней' : d === 30 ? '30 дней' : d + ' дн.';
  const s = salesStats(conn, d);
  const tops = topProducts(conn, d, 5);
  const cats = topCategories(conn, d, 5);
  const out = [];
  out.push(`Статистика · ${label}`);
  out.push(`Заявки: ${s.count} на ${fmtMoney(s.sum)}`);
  out.push(`Оплачено: ${s.paid_count} на ${fmtMoney(s.paid_sum)}`);
  out.push(`Средний чек: ${fmtMoney(s.avg)}`);
  out.push(`Конверсия в оплату: ${s.conv}%`);
  out.push('Топ-5 товаров:');
  if (!tops.length) out.push('— пока пусто');
  tops.forEach((t, i) => out.push(`${i + 1}. ${t.name.slice(0, 60)} — ${t.qty} шт на ${fmtMoney(t.sum)}`));
  out.push('Топ-5 категорий:');
  if (!cats.length) out.push('— пока пусто');
  cats.forEach((t, i) => out.push(`${i + 1}. ${t.cat} — на ${fmtMoney(t.sum)}`));
  return out.join('\n');
}
function historyText(conn, limit, entity, entityId) {
  const lim = Math.max(1, Math.min(50, Math.trunc(Number(limit)) || 15));
  let rows;
  if (entity) {
    rows = conn.prepare('SELECT ts, actor, entity, entity_id, action FROM audit_log WHERE entity = ? AND (? = \'\' OR entity_id = ?) ORDER BY id DESC LIMIT ?').all(String(entity).slice(0, 30), String(entityId || ''), String(entityId || ''), lim);
  } else {
    rows = conn.prepare('SELECT ts, actor, entity, entity_id, action FROM audit_log ORDER BY id DESC LIMIT ?').all(lim);
  }
  if (!rows.length) return 'Журнал пуст: изменений пока не было.';
  return rows.map((r) => `${String(r.ts || '').slice(5, 16)} ${r.actor} ${r.entity}${r.entity_id ? '#' + r.entity_id : ''} ${r.action}`).join('\n');
}
function parseDaysArg(text) {
  const m = String(text || '').match(/\b(\d{1,4})\b/);
  const n = m ? Number(m[1]) : 1;
  return Math.max(1, Math.min(366, n || 1));
}
function parseHistoryArgs(text) {
  const t = String(text || '');
  let m = t.match(/(?:товар|product)\s+#?(\d{1,9})/i);
  if (m) return { limit: 15, entity: 'product', entityId: m[1] };
  m = t.match(/(?:заявк|заказ|order)\s+(TG-\d{1,9})/i);
  if (m) return { limit: 15, entity: 'order', entityId: m[1].toUpperCase() };
  m = t.match(/\b(\d{1,3})\b/);
  return { limit: m ? Math.max(1, Math.min(50, Number(m[1]))) : 15, entity: '', entityId: '' };
}
// Брошенные заявки: фиксируем открытие бота по deep link (удаляем старый след
// того же человека по той же заявке, чтобы не плодить строки и не слать дважды).
function recordBotOpened(conn, tgId, code) {
  const tg = String(tgId || '');
  const c = String(code || '').toUpperCase();
  if (!tg || !/^TG-\d+$/.test(c)) return;
  conn.prepare("DELETE FROM checkout_events WHERE tg_id = ? AND order_code = ? AND status = 'bot_opened'").run(tg, c);
  conn.prepare("INSERT INTO checkout_events (session_id, tg_id, cart_json, total, status, order_code) VALUES (?,?,?,?,?,?)").run('order:' + c, tg, '[]', 0, 'bot_opened', c);
}
// Кандидаты на одно вежливое напоминание: открывал бота >2 ч назад, за сутки
// не напоминали, после открытия не появилось ни одной неотменённой заявки.
function findReminderCandidates(conn) {
  return conn.prepare(`SELECT * FROM checkout_events
    WHERE status = 'bot_opened' AND tg_id IS NOT NULL AND tg_id != ''
      AND datetime(updated_at) < datetime('now','-2 hours')
      AND datetime(created_at) > datetime('now','-30 days')
      AND (reminded_at IS NULL OR datetime(reminded_at) < datetime('now','-24 hours'))
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.owner_tg = checkout_events.tg_id
        AND datetime(o.created_at) >= datetime(checkout_events.created_at)
        AND o.status NOT IN ('Отменен', 'Отменён'))
    ORDER BY updated_at LIMIT 20`).all();
}
function cleanupCheckoutEvents(conn) {
  try { conn.prepare("DELETE FROM checkout_events WHERE datetime(updated_at) < datetime('now','-30 days')").run(); } catch (e) {}
  try { conn.prepare("DELETE FROM idempotency_keys WHERE datetime(created_at) < datetime('now','-30 days')").run(); } catch (e) {}
}
function digestText(conn, opts) {
  const o = opts || {};
  const y = salesStats(conn, 1, 1);
  const yDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const out = [];
  out.push(`Утро. Итоги ${yDate}:`);
  out.push(`Заявок создано: ${y.count} на ${fmtMoney(y.sum)}`);
  out.push(`Оплачено: ${y.paid_count} на ${fmtMoney(y.paid_sum)}`);
  const low = lowStock(conn, 5);
  out.push(low.length ? 'Заканчиваются: ' + low.map((p) => `#${p.id} ${String(p.name).slice(0, 40)} (${p.stock} шт)`).join('; ') : 'Остатки в норме.');
  const bAge = o.backupAt ? (Date.now() - Date.parse(o.backupAt)) / 3600000 : 9999;
  out.push('Бекап: ' + (bAge < 26 ? 'свежий' : 'СТАРШЕ 26 Ч — проверь!'));
  if (o.publish && o.publish.ok === false) out.push('Публикация: ОШИБКА — ' + String(o.publish.error || '').slice(0, 120));
  else out.push('Публикация: без ошибок.');
  return out.join('\n');
}
async function sendCheckoutReminders() {
  if (!tgBot) return;
  let rows = [];
  try { rows = findReminderCandidates(db); } catch (e) { return; }
  for (const r of rows) {
    try {
      await tgBot.telegram.sendMessage(r.tg_id, `Вы начали оформление${r.order_code ? ' ' + r.order_code : ''}, но заявка не завершена. Если нужна помощь с выбором — напишите, подскажем.`);
    } catch (e) { /* заблокировавший бота человек: фиксируем попытку, завтра попробуем снова */ }
    try { db.prepare('UPDATE checkout_events SET reminded_at = CURRENT_TIMESTAMP, status = ? WHERE id = ?').run('reminded', r.id); } catch (e) {}
    await new Promise((x) => setTimeout(x, 300));
  }
}
function maybeMorningDigest() {
  try {
    if (new Date().getHours() < 9) return;
    const today = new Date().toISOString().slice(0, 10);
    if (getSetting('last_digest_date') === today) return;
    setSetting('last_digest_date', today);
    let publish = null;
    try { publish = JSON.parse(getSetting('publish_last') || 'null'); } catch (e) { publish = null; }
    notifyTgAdmins(digestText(db, { backupAt: getSetting('last_backup_at'), publish }));
  } catch (e) { console.error('digest failed:', redactSecrets(e.message)); }
}
function ownerTick() {
  try { maybeMorningDigest(); } catch (e) {}
  try { cleanupCheckoutEvents(db); } catch (e) {}
  sendCheckoutReminders().catch(() => {});
}
setInterval(ownerTick, 10 * 60 * 1000).unref?.();
// ---------- /Владелец ----------

const orderRateLimit = new Map();
const ORDER_COOLDOWN_MS = Math.max(Number(process.env.ORDER_COOLDOWN_MS || 5000), 0);

// Номер заказа выдаёт сервер: витрина без бэкенда может предложить уже занятый код,
// поэтому берём следующий из счётчика и пропускаем совпадения.
function allocateOrderCode() {
  for (let i = 0; i < 200; i++) {
    const next = (parseInt(getSetting('last_order_num') || '1175', 10) || 1175) + 1;
    setSetting('last_order_num', next);
    const code = `TG-${next}`;
    if (!db.prepare('SELECT 1 AS x FROM orders WHERE order_code = ?').get(code)) return code;
  }
  return `TG-${Date.now()}`;
}

// Маяк «начал оформление»: только случайный sessionId, id/qty и сумма —
// никаких телефонов и имён. На статике без сервера шлём в пустоту (catch на фронте).

app.post('/api/lead', (req, res) => {
  const lip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!lookupAllowed(lip, 30)) return res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const type = cleanText(b.type || 'callback').slice(0, 24);
    const name = cleanText(b.name || '').slice(0, 100);
    const contact = cleanText(b.contact || '').slice(0, 80);
    const details = cleanText(b.details || '').slice(0, 300);
    if (!name || !contact) return res.status(400).json({ error: 'Укажите имя и контакт для связи' });
    const label = type === 'tradein' ? `Trade-In оценка: ${name} (${details || 'без деталей'})` : `Обратный звонок: ${details || 'Консультация'}`;
    const msg = `🔔 НОВАЯ ЗАЯВКА НА СВЯЗЬ (${type === 'tradein' ? 'Trade-In' : 'Звонок'})\n👤 ${name}\n📞 ${contact}\n💬 ${details || '—'}`;
    notifyTgAdmins(msg);
    maxNotifyAdmin(msg).catch(() => {});
    res.json({ ok: true, label });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось отправить заявку' });
  }
});

app.post('/api/checkout-started', (req, res) => {
  const lip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!lookupAllowed(lip, 60)) return res.status(429).json({ error: 'Слишком много запросов.' });
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const sid = String(b.sessionId || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sid)) return res.status(400).json({ error: 'Bad session' });
    const raw = Array.isArray(b.cart) ? b.cart.slice(0, 50) : [];
    const cart = [];
    for (const it of raw) {
      const id = Number(it && it.id);
      const qty = Number(it && it.qty);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ error: 'Bad cart item' });
      cart.push({ id, qty });
    }
    if (!cart.length) return res.status(400).json({ error: 'Пустая корзина' });
    const total = Math.max(0, Math.trunc(Number(b.total)) || 0);
    db.prepare("INSERT INTO checkout_events (session_id, cart_json, total, status) VALUES (?,?,?,'started')").run(sid, JSON.stringify(cart), total);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Не записалось' }); }
});


// ---------- CMS Bridge: WooCommerce / OpenCart 4 / PrestaShop 8 ----------
let cmsBridge = null;
try { cmsBridge = require('./cms-bridge'); } catch (_) {}

app.get('/wp-json/wc/v3/products', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM products ORDER BY id ASC').all();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const slice = rows.slice((page - 1) * perPage, page * perPage);
    res.setHeader('X-WP-Total', String(rows.length));
    res.setHeader('X-WP-TotalPages', String(Math.ceil(rows.length / perPage)));
    res.json(cmsBridge ? slice.map((p) => cmsBridge.toWooCommerceRestProduct(p)) : slice);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/opencart/products', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM products ORDER BY id ASC').all();
    res.json({
      engine: 'OpenCart 4.0.2.3',
      total: rows.length,
      products: rows.map((p) => ({
        product_id: p.id,
        model: 'REF-' + String(p.id).padStart(4, '0'),
        sku: 'WOP-' + String(p.id).padStart(4, '0'),
        name: p.name,
        manufacturer: p.brand,
        category: p.category,
        price: p.old_price || p.price,
        special: p.old_price && p.old_price > p.price ? p.price : null,
        quantity: p.stock != null ? p.stock : 5,
        status: p.stock === 0 ? 0 : 1,
        image: cmsBridge ? cmsBridge.absImageUrl(p.image) : p.image,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/prestashop/products', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM products ORDER BY id ASC').all();
    res.json({
      engine: 'PrestaShop 8.1',
      total: rows.length,
      products: rows.map((p) => ({
        id: p.id,
        reference: 'REF-' + String(p.id).padStart(4, '0'),
        name: p.name,
        brand: p.brand,
        category: p.category,
        price_tax_incl: p.price,
        wholesale_price: p.old_price || p.price,
        quantity: p.stock != null ? p.stock : 5,
        active: p.stock === 0 ? 0 : 1,
        cover_image: cmsBridge ? cmsBridge.absImageUrl(p.image) : p.image,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cms/export/:engine', (req, res) => {
  if (!cmsBridge) return res.status(500).json({ error: 'cms-bridge unavailable' });
  const engine = String(req.params.engine || 'woocommerce').toLowerCase();
  const rows = db.prepare('SELECT * FROM products ORDER BY id ASC').all();
  if (engine === 'woocommerce' || engine === 'wc') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="watchop-woocommerce-products.csv"');
    return res.send(cmsBridge.toWooCommerceCsv(rows));
  }
  if (engine === 'opencart' || engine === 'oc') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="watchop-opencart-products.csv"');
    return res.send(cmsBridge.toOpenCartCsv(rows));
  }
  if (engine === 'opencart-sql') {
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="watchop-opencart-seed.sql"');
    return res.send(cmsBridge.toOpenCartSql(rows));
  }
  if (engine === 'prestashop' || engine === 'ps') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="watchop-prestashop-products.csv"');
    return res.send(cmsBridge.toPrestaShopCsv(rows));
  }
  return res.status(400).json({ error: 'Unsupported CMS engine. Use woocommerce, opencart, opencart-sql, or prestashop' });
});

['woocommerce', 'opencart', 'prestashop'].forEach((engine) => {
  app.post('/api/webhooks/' + engine, (req, res) => {
    const lip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!lookupAllowed(lip, 60)) return res.status(429).json({ error: 'Too many requests' });
    try {
      if (!cmsBridge) return res.status(500).json({ error: 'cms-bridge unavailable' });
      const norm = cmsBridge.normalizeCmsWebhookOrder(engine, req.body || {});
      const code = norm.code && /^TG-\d{4,6}$/.test(norm.code) ? norm.code : allocateOrderCode();
      const customer = {
        fio: cleanText(norm.customer_name || 'Клиент ' + engine.toUpperCase()).slice(0, 100),
        phone: cleanText(norm.customer_phone || '').slice(0, 30),
        email: '',
        address: cleanText(norm.customer_comment || '').slice(0, 300),
        delivery: 'СДЭК',
      };
      db.prepare('INSERT OR IGNORE INTO orders (order_code, items_json, total, status, customer_json, owner_tg, promo_code, discount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(code, JSON.stringify(norm.items || []), norm.total || 0, 'Новый', JSON.stringify(customer), null, null, 0);
      res.json({ ok: true, engine, code, total: norm.total });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

app.post('/api/order', async (req, res) => {
  try {
    return await handleApiOrder(req, res);
  } catch (e) {
    console.error('Order API error:', maskPhone(redactSecrets(e.message)));
    if (!res.headersSent) return res.status(500).json({ error: 'Не удалось оформить заказ. Попробуйте ещё раз.' });
    return res.end();
  }
});

async function handleApiOrder(req, res) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (orderRateLimit.has(ip) && now - orderRateLimit.get(ip) < ORDER_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Слишком быстро. Попробуйте ещё раз.' });
  }
  orderRateLimit.set(ip, now);

  // Повторная отправка той же формы (двойной клик, ретрай после таймаута):
  // ключ из заголовка X-Idempotency-Key или тела. Дубликат возвращает тот же заказ.
  const idemKey = String((req.headers && req.headers['x-idempotency-key']) || (req.body && req.body.idemKey) || '').slice(0, 64);
  if (idemKey) {
    const claimed = claimIdempotencyKey(idemKey);
    if (claimed.ok && claimed.duplicate) {
      return res.json({ orderCode: claimed.orderCode, total: claimed.total, duplicate: true });
    }
  }

  const { items, initData } = req.body;
  const tiRaw = req.body.tradein;
  const ti = tiRaw && typeof tiRaw === 'object' && !Array.isArray(tiRaw)
    ? {
        model: cleanText(tiRaw.model).slice(0, 100),
        year: cleanText(tiRaw.year).slice(0, 40),
        cond: TI_COND_TEXT[String(tiRaw.cond)] ? String(tiRaw.cond) : '',
        productId: Number.isSafeInteger(Number(tiRaw.productId)) && Number(tiRaw.productId) > 0 ? Number(tiRaw.productId) : null,
      }
    : null;
  if (tiRaw && (!ti || !ti.model || !ti.cond)) return res.status(400).json({ error: 'Trade-In: укажите модель и состояние часов' });
  if (!Array.isArray(items) || (!items.length && !ti) || items.length > 50) return res.status(400).json({ error: 'Пустой заказ' });

  const cRaw = req.body.customer || {};
  if (typeof cRaw !== 'object' || Array.isArray(cRaw) ||
      ['fio', 'phone', 'email', 'address', 'delivery'].some((key) => cRaw[key] !== undefined && typeof cRaw[key] !== 'string')) {
    return res.status(400).json({ error: 'Некорректные данные покупателя' });
  }
  const customer = {
    fio: cleanText(cRaw.fio).slice(0, 100),
    phone: cleanText(cRaw.phone).slice(0, 30),
    email: cleanText(cRaw.email).slice(0, 100),
    address: cleanText(cRaw.address).slice(0, 300),
    delivery: normalizeDelivery(db, cleanText(cRaw.delivery))
  };
  // Перекодировать не удалось (байты ни UTF-8, ни cp1251/1252) — не храним «?????»
  if (hasGarbageDeep(customer)) {
    return res.status(400).json({ error: 'Часть символов не читается: отправьте данные в кодировке UTF-8 или windows-1251.' });
  }
  if (!customer.fio || !customer.phone) return res.status(400).json({ error: 'Укажите ФИО и телефон' });
  if (customer.phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Телефон нужно указать полностью — минимум 10 цифр' });

  // Цены и названия берем только из своей БД — значениям от клиента не доверяем.
  const cleanItems = [];
  for (const it of items) {
    const id = it?.id;
    const qty = it?.qty;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad item id' });
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ error: 'Bad item quantity' });
    const prod = db.prepare('SELECT id, name, price FROM products WHERE id = ?').get(id);
    if (!prod) return res.status(400).json({ error: 'Товар не найден' });
    cleanItems.push({ id: prod.id, name: String(prod.name).slice(0, 200), price: prod.price, qty });
  }
  if (ti) {
    const target = ti.productId ? db.prepare('SELECT name FROM products WHERE id = ?').get(ti.productId) : null;
    cleanItems.push({
      id: 0,
      name: `Trade-In: ${ti.model}${ti.year ? ', ' + ti.year : ''} — ${TI_COND_TEXT[ti.cond]}${target ? '; обмен на ' + String(target.name).slice(0, 120) : ''}`,
      price: 0,
      qty: 1,
      ti: 1,
    });
  }
  if (!cleanItems.length) return res.status(400).json({ error: 'Пустой заказ' });
  const serverTotal = cleanItems.reduce((s, i) => s + i.price * i.qty, 0);
  // Промокод проверяется по ценам базы, а не по сумме клиента: из запроса берётся
  // только сам код, а право на скидку, бренд и минимальный чек считает сервер.
  const promoRaw = typeof req.body.promo === 'string' ? cleanText(req.body.promo).slice(0, 24) : '';
  const promoEval = promoRaw
    ? evaluatePromo(getSetting('promo_codes'), promoRaw, cleanItems, (id) => db.prepare('SELECT id, brand, price FROM products WHERE id = ?').get(id))
    : null;
  if (promoEval && !promoEval.ok) return res.status(400).json({ error: promoEval.error });
  const discountRub = promoEval ? promoEval.discountRub : 0;
  const finalTotal = Math.max(0, serverTotal - discountRub);

  // Мини-апп может приложить initData для проверки подписи; без него — обычный веб-заказ.
  let tgUser = null;
  if (initData) {
    tgUser = verifyTelegramInitData(initData);
    if (!tgUser) return res.status(403).json({ error: 'Bad initData signature' });
  }

  // Резерв остатков + вставка заявки — одной транзакцией: два покупателя не заберут
  // последний экземпляр, а повторный запрос не создаст дубль и не уйдёт в минус.
  let orderCode;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const ci of cleanItems) {
        if (!ci.id) continue; // trade-in / подарки остатков не имеют
        const st = db.prepare('SELECT stock FROM products WHERE id = ?').get(ci.id);
        if (st && st.stock != null && Number(st.stock) < ci.qty) {
          throw { outOfStock: true, name: ci.name };
        }
        if (st && st.stock != null) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(ci.qty, ci.id);
      }
      orderCode = allocateOrderCode();
      db.prepare('INSERT INTO orders (order_code, items_json, total, status, customer_json, owner_tg, promo_code, discount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(orderCode, JSON.stringify(cleanItems), finalTotal, ti ? 'Trade-In' : 'Новый', JSON.stringify(customer), tgUser ? String(tgUser.id) : null, promoEval ? promoEval.code : null, discountRub);
      if (idemKey && /^[A-Za-z0-9-]{8,64}$/.test(idemKey)) rememberIdempotencyKey(idemKey, orderCode);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) {}
      throw e;
    }
  } catch (e) {
    if (e && e.outOfStock) return res.status(409).json({ error: `К сожалению, «${String(e.name || 'товар').slice(0, 80)}» уже разобрали. Менеджер предложит аналог.` });
    throw e;
  }
  auditLog({ actor: tgUser ? 'tg:' + tgUser.id : 'site', entity: 'order', entityId: orderCode, action: 'create', neW: { total: finalTotal, items: cleanItems.length }, source: 'api' });
  try {
    const sid = String((req.body && req.body.sid) || '').slice(0, 64);
    if (/^[A-Za-z0-9-]{8,64}$/.test(sid)) db.prepare("UPDATE checkout_events SET status = 'ordered', updated_at = CURRENT_TIMESTAMP WHERE session_id = ?").run(sid);
  } catch (e) {}

  const itemsText = cleanItems.map((i, idx) => `${idx + 1}. ${i.name} — ${i.qty} шт. x ${Number(i.price).toLocaleString('ru-RU')} ₽`).join('\n');
  const promoLine = promoEval && discountRub > 0
    ? `\nПромокод ${promoEval.code}: −${promoEval.percent}% (${Number(discountRub).toLocaleString('ru-RU')} ₽)`
    : (promoEval ? `\nПромокод ${promoEval.code}: скидка не применилась (0 ₽)` : '');
  const totalLine = discountRub > 0
    ? `Итого: ${Number(finalTotal).toLocaleString('ru-RU')} ₽ (до скидки ${Number(serverTotal).toLocaleString('ru-RU')} ₽)`
    : `Итого: ${Number(serverTotal).toLocaleString('ru-RU')} ₽`;
  const clientTag = tgUser ? `\nКлиент TG: @${tgUser.username || tgUser.first_name} (id ${tgUser.id})` : '';
  const custLine = `\n👤 ${customer.fio}\n📞 ${customer.phone}${customer.email ? `\n✉️ ${customer.email}` : ''}\n📍 ${customer.address || '—'}\n🚚 ${customer.delivery}`;
  const notifyMsg = `НОВАЯ ЗАЯВКА ${orderCode}\n\nСостав:\n${itemsText}\n\n${totalLine}${promoLine}${clientTag}${custLine}\nРеквизиты:\n${getSetting('payment_details')}`;

  notifyTgAdmins(notifyMsg, {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('В сборку', `st_${orderCode}_work`), Markup.button.callback('Оплачен', `st_${orderCode}_paid`)],
      [Markup.button.callback('Отменить', `st_${orderCode}_cancel`)]
    ])
  });

  maxNotifyAdmin(notifyMsg, orderCode).catch((e) => console.error('MAX Send Error:', redactSecrets(e.message)));

  res.json({ orderCode, total: finalTotal, discount: discountRub, promo: promoEval ? promoEval.code : '' });
}

// ---------- Telegram bot ----------
if (isValidEnv(process.env.TG_BOT_TOKEN)) {
  tgBot = new Telegraf(process.env.TG_BOT_TOKEN);
  tgBot.use(session());
  const isTgAdmin = isTgAdminCtx;

  tgBot.command('id', (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

  tgBot.command('stats', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.reply(statsText(db, parseDaysArg(ctx.message && ctx.message.text)));
  });
  tgBot.command('history', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const a = parseHistoryArgs(ctx.message && ctx.message.text);
    ctx.reply(historyText(db, a.limit, a.entity, a.entityId));
  });

  tgBot.start(async (ctx) => {
    const shopKb = tgShopButtons();
    if (!isTgAdmin(ctx)) {
      const payload = ctx.startPayload;
      const codeMatch = String(payload || '').match(/TG-\d+/i);
      if (codeMatch) return handleSiteOrderPayload(ctx, codeMatch[0].toUpperCase(), payload);
      await ctx.reply('Здравствуйте! Магазин Watchop. Отправьте номер заказа (например, TG-1176), менеджер проверит наличие и пришлет реквизиты.');
      if (shopKb.length) return ctx.reply('Каталог и заказ в 1 клик — прямо в Telegram:', Markup.inlineKeyboard([shopKb]));
      return;
    }
    ctx.session = {};
    await ctx.reply(
      `Админ-панель Watchop (Telegram)\nВаш ID: ${ctx.from.id}\nВыберите действие:`,
      tgAdminMenuKb()
    );
    if (shopKb.length) return ctx.reply('Магазин:', Markup.inlineKeyboard([shopKb]));
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

  tgBot.hears('Сводка сайта', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.reply(adminSummary(db, { show_payment: getSetting('show_payment') }),
      Markup.inlineKeyboard([
        [Markup.button.callback('Статистика 7 дней', 'stats_7'), Markup.button.callback('Статистика 30 дней', 'stats_30')],
        [Markup.button.callback('Журнал изменений', 'history_15')]
      ]));
  });
  tgBot.action(/^stats_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery().catch(() => {});
    ctx.reply(statsText(db, Math.max(1, Math.min(366, Number(ctx.match[1]) || 7))));
  });
  tgBot.action('history_15', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery().catch(() => {});
    ctx.reply(historyText(db, 15));
  });
  tgBot.hears('Статистика', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.reply(statsText(db, 7));
  });
  tgBot.hears('Журнал', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.reply(historyText(db, 15) + '\n\nУточнить: /history товар 45 · /history заказ TG-1176');
  });
  tgBot.hears('Фото на стоках', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.reply(stockPhotoReport(db));
  });
  tgBot.hears('Товары и цены', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    showShelvesTg(ctx);
  });
  tgBot.action(/^tg_disc_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const id = Number(ctx.match[1]);
    const prod = db.prepare('SELECT id, name, price, old_price FROM products WHERE id = ?').get(id);
    if (!prod) return ctx.answerCbQuery('Нет такого товара');
    ctx.session = { step: 'wait_discount', prodId: id };
    const stored = Math.trunc(Number(prod.old_price)) || 0;
    ctx.reply(
      `Скидка для #${id} ${prod.name}\nТекущая цена: ${Number(prod.price).toLocaleString('ru-RU')} ₽${stored > prod.price ? `, до уценки: ${stored.toLocaleString('ru-RU')} ₽` : ''}\n\nПришлите процент (например 20) или «Отмена»:`,
      Markup.inlineKeyboard([[Markup.button.callback('Снять скидку', `tg_disc_clear_${id}`)]])
    );
  });
  tgBot.action(/^tg_disc_clear_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const id = Number(ctx.match[1]);
    const prod = db.prepare('SELECT id, name, price, old_price FROM products WHERE id = ?').get(id);
    if (!prod) return ctx.answerCbQuery('Нет такого товара');
    const res = discountOff(prod);
    if (!res.ok) return ctx.answerCbQuery(res.error);
    db.prepare('UPDATE products SET price = ?, old_price = 0 WHERE id = ?').run(res.price, id);
    ctx.session = {};
    ctx.answerCbQuery('Скидка снята');
    ctx.reply(`#${id} ${prod.name}: скидка снята, цена снова ${res.price.toLocaleString('ru-RU')} ₽.\nЧтобы витрина без сервера (GitHub Pages) увидела это, нажмите «Экспорт каталога» и закоммитьте products-data.js.`);
  });
  // ---------- Каталог: полки, страницы, карточка, правка поля ----------
  const catRowLabel = (p) => `#${p.id} ${p.name.slice(0, 26)} · ${Number(p.price).toLocaleString('ru-RU')} ₽${(Math.trunc(Number(p.old_price)) || 0) > Number(p.price) ? ' −' : ''}${Number(p.is_hit) ? ' ★' : ''}`;

  function showShelvesTg(ctx) {
    const shelves = catalogShelves(db);
    ctx.session = { step: 'cat', category: 'Все товары', page: 1, query: '' };
    ctx.reply(
      `Каталог: ${shelves[0].count} позиций. Выбери полку, а «Найти» ищет по названию, бренду, серии и описанию.`,
      Markup.inlineKeyboard([
        ...shelves.map((s, i) => [Markup.button.callback(`${s.category} (${s.count})`, `cat_shelf_${i}`)]),
        [Markup.button.callback('Найти', 'cat_find'), Markup.button.callback('Сводка сайта', 'cat_summary')],
      ])
    );
  }

  function showCatalogPageTg(ctx) {
    const s = ctx.session || {};
    const res = catalogPage(db, { category: s.category, query: s.query, page: s.page });
    s.category = res.category; s.query = res.query; s.page = res.page; s.step = 'cat';
    const rows = res.items.map((p) => [Markup.button.callback(catRowLabel(p), `cat_item_${p.id}`)]);
    if (res.pages > 1) {
      const nav = [res.page > 1 ? Markup.button.callback('← ', 'cat_prev') : Markup.button.callback(`· ${res.page} ·`, 'cat_noop')];
      nav.push(Markup.button.callback(`${res.page} / ${res.pages}`, 'cat_noop'));
      if (res.page < res.pages) nav.push(Markup.button.callback(' →', 'cat_next'));
      rows.push(nav);
    }
    rows.push([Markup.button.callback('Полки', 'cat_root'), Markup.button.callback('Найти', 'cat_find')]);
    ctx.reply(`${res.query ? `Поиск «${res.query}»` : `Полка: ${res.category}`} — позиций: ${res.total}`, Markup.inlineKeyboard(rows));
  }

  function showProductTg(ctx, id) {
    const p = productById(db, id);
    if (!p) return ctx.reply('Товар не найден — вернись к полкам.');
    ctx.session = { ...(ctx.session || {}), step: 'cat', prodId: p.id };
    ctx.reply(
      productCardText(p),
      Markup.inlineKeyboard([
        Object.keys(PRODUCT_FIELD_LABELS).map((f) => Markup.button.callback(PRODUCT_FIELD_LABELS[f], `pf_${f}_${p.id}`)),
        [Markup.button.callback(Number(p.is_hit) ? 'Убрать из хитов' : 'В хиты', `pf_hit_${p.id}`), Markup.button.callback('Скидка', `tg_disc_${p.id}`)],
        [Markup.button.callback('Удалить', `pf_del_${p.id}`), Markup.button.callback('К списку', 'cat_back')],
      ])
    );
  }

  tgBot.action('cat_noop', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); });
  tgBot.action('cat_root', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); showShelvesTg(ctx); });
  tgBot.action('cat_back', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); showCatalogPageTg(ctx); });
  tgBot.action(/^cat_shelf_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const shelf = catalogShelves(db)[Number(ctx.match[1])];
    if (!shelf) return ctx.answerCbQuery('Полки изменились — открой заново');
    ctx.answerCbQuery(shelf.category);
    ctx.session = { step: 'cat', category: shelf.category, page: 1, query: '' };
    showCatalogPageTg(ctx);
  });
  tgBot.action('cat_prev', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); const s = ctx.session || {}; s.page = Math.max(1, (s.page || 1) - 1); showCatalogPageTg(ctx); });
  tgBot.action('cat_next', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); const s = ctx.session || {}; s.page = (s.page || 1) + 1; showCatalogPageTg(ctx); });
  tgBot.action('cat_find', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { ...(ctx.session || {}), step: 'cat_find' };
    ctx.reply('Что ищем? Слово из названия, бренда, серии или описания:');
  });
  tgBot.action(/^cat_item_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    showProductTg(ctx, Number(ctx.match[1]));
  });
  tgBot.action('cat_summary', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.reply(adminSummary(db, { show_payment: getSetting('show_payment') }));
  });
  tgBot.action(/^pf_(name|brand|series|category|price|stock|specs|image)_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const field = ctx.match[1];
    const p = productById(db, Number(ctx.match[2]));
    if (!p) return ctx.answerCbQuery('Товар не найден');
    ctx.answerCbQuery();
    ctx.session = { ...(ctx.session || {}), step: 'pf_wait', field, prodId: p.id };
    const hint = field === 'category' ? `Полки: ${allStoreCategories(db).join(', ')}`
      : field === 'image' ? 'Ссылка http(s)://… или пришли фото файлом; «Отмена» отбивает шаг'
      : field === 'price' ? 'Только число, например 58990'
      : field === 'stock' ? 'Число штук (0 — под заказ)'
      : 'Новое значение:';
    ctx.reply(`${PRODUCT_FIELD_LABELS[field]} товара #${p.id}\nСейчас: ${p[field] || '—'}\n\n${hint}`);
  });
  tgBot.action(/^pf_hit_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const res = toggleProductHit(db, Number(ctx.match[1]));
    ctx.answerCbQuery(res.ok ? (res.hit ? 'в хитах' : 'убран из хитов') : res.error);
    if (res.ok) showProductTg(ctx, res.row.id);
  });
  tgBot.action(/^pf_del_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const p = productById(db, Number(ctx.match[1]));
    if (!p) return ctx.answerCbQuery('Товар не найден');
    ctx.answerCbQuery();
    ctx.reply(
      `Удалить #${p.id} ${p.name}?\nПотом позицию можно вернуть только из файла products-data.js или заведением зановo.`,
      Markup.inlineKeyboard([[Markup.button.callback('Да, удалить', `pf_del_yes_${p.id}`), Markup.button.callback('Отмена', `cat_item_${p.id}`)]])
    );
  });
  tgBot.action(/^pf_del_yes_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const res = deleteProductById(db, Number(ctx.match[1]));
    ctx.answerCbQuery(res.ok ? 'Удалено' : res.error);
    if (!res.ok) return ctx.reply(res.error);
    ctx.reply(`Удалён #${res.id} «${res.name}». Проверь расхождение с файлом: «Экспорт каталога».`);
    showCatalogPageTg(ctx);
  });

  tgBot.hears('Тексты и контакты', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.reply('Что меняем?', Markup.inlineKeyboard([
      [Markup.button.callback('Заголовок баннера', 'tg_cfg_hero_title')],
      [Markup.button.callback('Телефон', 'tg_cfg_phone'), Markup.button.callback('Email', 'tg_cfg_email')],
      [Markup.button.callback('Адрес', 'tg_cfg_address')],
      [Markup.button.callback('Доставка', 'tg_cfg_delivery_methods'), Markup.button.callback('Категории', 'tg_cfg_extra_categories')],
      [Markup.button.callback('Ссылка ТГ', 'tg_cfg_tg_link'), Markup.button.callback('Ссылка MAX', 'tg_cfg_max_link')],
      [Markup.button.callback('ИП ФИО', 'tg_cfg_legal_name'), Markup.button.callback('ИНН', 'tg_cfg_legal_inn'), Markup.button.callback('ОГРНИП', 'tg_cfg_legal_ogrnip')]
    ]));
  });
  tgBot.action(/^tg_cfg_(.+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    if (!isEditableSetting(ctx.match[1])) return ctx.answerCbQuery('Эта настройка из бота не меняется');
    ctx.session = { step: 'wait_cfg', key: ctx.match[1] };
    ctx.reply(`Текущее:\n${getSetting(ctx.match[1])}\n\nОтправьте новое значение:`);
  });

  // ---------- Заявки: фильтр по статусу, поиск, карточка, смена статуса ----------
  function showOrdersTg(ctx) {
    const s = ctx.session || {};
    const breakdown = orderStatusBreakdown(db);
    const res = ordersPage(db, { status: s.ordStatus, query: s.ordQuery, page: s.ordPage });
    s.ordStatus = res.status; s.ordQuery = res.query; s.ordPage = res.page; s.step = 'ord';
    const rows = res.items.map((o) => [Markup.button.callback(`${o.order_code} · ${Number(o.total).toLocaleString('ru-RU')} ₽ · ${o.status}`, `ord_item_${o.order_code}`)]);
    if (!rows.length) rows.push([Markup.button.callback('пусто', 'ord_noop')]);
    if (res.pages > 1) {
      rows.push([
        res.page > 1 ? Markup.button.callback('← ', 'ord_prev') : Markup.button.callback('·', 'ord_noop'),
        Markup.button.callback(`${res.page} / ${res.pages}`, 'ord_noop'),
        res.page < res.pages ? Markup.button.callback(' →', 'ord_next') : Markup.button.callback('·', 'ord_noop'),
      ]);
    }
    const present = [['Все', breakdown.reduce((n, x) => n + x.count, 0)], ...breakdown.map((x) => [x.status, x.count])];
    for (let i = 0; i < present.length; i += 3) {
      rows.push(present.slice(i, i + 3).map(([st, c], j) => Markup.button.callback(`${st} (${c})`, `ord_st_${i + j}`)));
    }
    rows.push([Markup.button.callback('Найти', 'ord_find'), Markup.button.callback('Новая заявка', 'ord_new'), Markup.button.callback('Сводка сайта', 'cat_summary')]);
    ctx.reply(
      `Заявок: ${res.total}${res.status !== 'Все' ? ` со статусом «${res.status}»` : ''}${res.query ? `, поиск «${res.query}»` : ''}`,
      Markup.inlineKeyboard(rows)
    );
  }

  function showOrderTg(ctx, code) {
    const text = orderCardText(db, code);
    if (!text) return ctx.reply(`Заявка ${code} не найдена.`);
    ctx.session = { ...(ctx.session || {}), step: 'ord', ordCode: code };
    ctx.reply(
      text,
      Markup.inlineKeyboard([
        Object.keys(ORDER_STATUS_BUTTONS).map((k) => Markup.button.callback(ORDER_STATUS_BUTTONS[k], `ord_set_${code}_${k}`)),
        [Markup.button.callback('Удалить заявку', `ord_del_${code}`), Markup.button.callback('К списку', 'ord_root')],
      ])
    );
  }

  tgBot.action(/^ord_del_(TG-\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const code = ctx.match[1];
    ctx.answerCbQuery();
    ctx.reply(
      `Удалить заявку ${code} вместе с составом и данными покупателя?\nОтменить это можно только из резервной копии базы.`,
      Markup.inlineKeyboard([[Markup.button.callback('Да, удалить', `ord_del_yes_${code}`), Markup.button.callback('Отмена', `ord_item_${code}`)]])
    );
  });
  tgBot.action(/^ord_del_yes_(TG-\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const res = deleteOrderByCode(db, ctx.match[1]);
    ctx.answerCbQuery(res.ok ? 'Удалено' : res.error);
    if (!res.ok) return ctx.reply(res.error);
    ctx.reply(`Заявка ${res.code} удалена (${Number(res.total).toLocaleString('ru-RU')} ₽, статус «${res.status}»).`);
    showOrdersTg(ctx);
  });

  tgBot.hears('Последние заказы', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.session = { step: 'ord', ordStatus: 'Все', ordQuery: '', ordPage: 1 };
    showOrdersTg(ctx);
  });
  tgBot.action('ord_noop', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); });
  tgBot.action('ord_root', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); showOrdersTg(ctx); });
  tgBot.action('ord_prev', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); const s = ctx.session || {}; s.ordPage = Math.max(1, (s.ordPage || 1) - 1); showOrdersTg(ctx); });
  tgBot.action('ord_next', (ctx) => { if (!isTgAdmin(ctx)) return; ctx.answerCbQuery(); const s = ctx.session || {}; s.ordPage = (s.ordPage || 1) + 1; showOrdersTg(ctx); });
  tgBot.action(/^ord_st_(\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const present = ['Все', ...orderStatusBreakdown(db).map((x) => x.status)];
    const st = present[Number(ctx.match[1])];
    if (!st) return ctx.answerCbQuery('Список изменился — открой заново');
    ctx.answerCbQuery(st);
    const s = ctx.session || {}; s.ordStatus = st; s.ordPage = 1;
    showOrdersTg(ctx);
  });
  tgBot.action('ord_find', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { ...(ctx.session || {}), step: 'ord_find' };
    ctx.reply('Поиск по заявкам: номер (TG-1176), фамилия, телефон или название товара:');
  });
  tgBot.action('ord_new', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { ...(ctx.session || {}), step: 'ord_new_items' };
    ctx.reply('Новая заявка вручную.\nШаг 1/3. Состав: ID товаров через запятую, количество — через x. Например: 12x2, 45');
  });
  tgBot.action(/^ord_item_(TG-\d+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    showOrderTg(ctx, ctx.match[1]);
  });
  tgBot.action(/^ord_set_(TG-\d+)_(\w+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const status = ORDER_STATUS_BUTTONS[ctx.match[2]];
    const res = setOrderStatus(db, ctx.match[1], status);
    ctx.answerCbQuery(res.ok ? `Статус: ${res.status}` : res.error);
    if (res.ok) showOrderTg(ctx, res.code);
  });
  function showDesignTg(ctx) {
    const cur = storeDesignName(db);
    ctx.reply(
      'Дизайн витрины: сейчас «' + STORE_DESIGNS[cur] + '». Переключение меняет public/index.html и корень, дальше — «Экспорт каталога» + коммит.',
      Markup.inlineKeyboard([
        [Markup.button.callback((cur === 'stealth' ? '● ' : '') + 'Stealth Titanium', 'design_stealth'),
          Markup.button.callback((cur === 'classic' ? '● ' : '') + 'Classic Light', 'design_classic')],
      ])
    );
  }
  tgBot.hears('Дизайн', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.session = {};
    showDesignTg(ctx);
  });
  tgBot.action(/^design_(stealth|classic)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    const res = setStoreDesign(__dirname, ctx.match[1]);
    if (!res.ok) return ctx.reply(res.error);
    ctx.reply('Включён дизайн «' + res.label + '». Проверь витрину, затем жми «Экспорт каталога» и коммить.');
  });
  tgBot.hears('Экспорт каталога', (ctx) => {    if (!isTgAdmin(ctx)) return;
    const preview = summarizeDiff(diffCatalog(fileCatalog(), catalogFromDb()));
    ctx.reply(
      `Выгрузка каталога из рабочей базы в products-data.js\n\n${preview}\n\nФайл перезапишется целиком, текущая копия уйдёт в products-data.js.bak.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Выгрузить', 'tg_export_yes'), Markup.button.callback('Выгрузить и опубликовать', 'tg_export_publish')],
        [Markup.button.callback('Отмена', 'tg_export_no')],
      ])
    );
  });
  tgBot.action('tg_export_publish', async (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery('Готовлю публикацию');
    const prev = await publishPreview();
    if (!prev.ok) return ctx.reply(prev.error);
    ctx.reply(
      `Публикация на GitHub Pages\n\nВ базе: ${prev.dbRows}, в файле сейчас: ${prev.fileRows}.\nВетка: ${prev.branch}, доступ: ${prev.via}.\nИзменённые файлы (${prev.files.length}):\n${prev.files.map((f) => `  ${f}`).join('\n') || '  — пусто —'}\n\nБот выгрузит каталог, синхронизирует зеркала, сделает коммит и push. В коммит попадут только файлы каталога и фото, ничего другого в рабочем дереве не трогается.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Подтвердить публикацию', 'tg_publish_yes'), Markup.button.callback('Отмена', 'tg_export_no')],
      ])
    );
  });
  tgBot.action('tg_publish_yes', async (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery('Публикую');
    const who = ctx.from.username ? `@${ctx.from.username}` : `id ${ctx.from.id}`;
    const res = await publishCatalog(who);
    try { setSetting('publish_last', JSON.stringify({ ok: res.ok, at: new Date().toISOString(), error: res.ok ? null : String(res.error || '').slice(0, 200) })); } catch (e) {}
    auditLog({ actor: 'tg:' + ctx.from.id, entity: 'publish', action: 'publish', neW: { ok: res.ok, sha: res.sha || null }, source: 'bot' });
    ctx.reply(res.ok ? res.text : res.error);
  });
  tgBot.action('tg_export_no', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery('Отменено');
    ctx.reply('Экспорт отменён. Выберите действие:', tgAdminMenuKb());
  });
  tgBot.action('tg_export_yes', async (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery('Выгружаю');
    const res = exportCatalog(true);
    if (res.blocked) return ctx.reply(res.text);
    const lines = [
      `Готово: в products-data.js записано ${res.rows} позиций.`,
      `Позиций, которых не было в файле: ${res.diff.onlyInDb.length}.`,
      `Позиций из файла, которых нет в базе: ${res.diff.onlyInFile.length} — они из файла ушли.`,
      res.written.length ? `Записано: ${res.written.join(', ')}` : 'Файлы не записаны.',
      res.failed.length ? `Ошибки записи: ${res.failed.join('; ')}` : '',
      'Файл нужно закоммитить и пересобрать GitHub Pages — витрина без бэкенда берёт каталог из него.',
    ].filter(Boolean);
    await ctx.reply(lines.join('\n'));
    try {
      await ctx.replyWithDocument({ source: CATALOG_FILES[0], filename: 'products-data.js' });
    } catch (e) {
      ctx.reply(`Файл не приложить: ${e.message}`);
    }
  });
  tgBot.action(/^st_(TG-\d+)_(.+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const [, code, st] = ctx.match;
    const res = setOrderStatus(db, code, ORDER_STATUS_BUTTONS[st] || st);
    ctx.answerCbQuery(res.ok ? `Статус: ${res.status}` : res.error);
    if (res.ok) ctx.reply(`Статус ${code}: ${res.status}`);
  });

  async function saveTgPhoto(ctx) {
    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];
    if (!best) return '';
    const link = await ctx.telegram.getFileLink(best.file_id);
    const resp = await fetch(link.href);
    if (!resp.ok) throw new Error(`Telegram отдал ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const fileName = `watch_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(uploadsDir, fileName), buf);
    console.log(`TG photo saved: ${fileName} (${(buf.length / 1024).toFixed(0)} KB)`);
    return `/uploads/${fileName}`;
  }

  tgBot.on('photo', async (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const s = ctx.session || {};
    const editing = s.step === 'pf_wait' && s.field === 'image';
    if (s.step !== 'add_img' && !editing) return;
    try {
      const saved = await saveTgPhoto(ctx);
      if (!saved) return ctx.reply('В сообщении нет фото.');
      if (editing) {
        const res = setProductField(db, s.prodId, 'image', saved);
        ctx.session = { ...s, step: 'cat' };
        if (!res.ok) return ctx.reply(res.error);
        return showProductTg(ctx, s.prodId);
      }
      finishAddingProductTg(ctx, saved);
    } catch (e) {
      console.error('TG photo save failed:', redactSecrets(e.message));
      ctx.reply('Не удалось сохранить фото. Отправьте ссылку.');
    }
  });

  tgBot.on('text', (ctx) => {
    const txt = ctx.message.text.trim();
    if (!isTgAdmin(ctx)) {
      const whoId = String(ctx.from?.id || '');
      if (pendingOrderAuth.has(whoId)) {
        if (txt === 'Отмена') { pendingOrderAuth.delete(whoId); return ctx.reply('Отменено.'); }
        if (/^\d{4}$/.test(txt)) return answerOrderAuth(ctx, txt);
        const m2 = txt.match(/TG-\d+/i);
        if (m2) return handleClientOrderLookupTg(ctx, m2[0].toUpperCase());
        return ctx.reply('Жду 4 цифры телефона для заявки. Для отмены напишите «Отмена».');
      }
      const m = txt.match(/TG-\d+/i);
      if (m) return handleClientOrderLookupTg(ctx, m[0].toUpperCase());
      const tag = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      notifyTgAdmins(`Сообщение от клиента (${tag}, ID ${ctx.from.id}):\n${txt}`);
      return ctx.reply('Спасибо! Менеджер получил сообщение и скоро ответит.');
    }
    const s = ctx.session || {};
    if (txt === 'Отмена') { ctx.session = {}; return ctx.reply('Отменено. Выберите действие:', tgAdminMenuKb()); }
    if (txt === 'Админы') { ctx.session = {}; return showTgAdminsPanel(ctx); }
    if (s.step === 'wait_admin_id') {
      const r = addTgAdminId(txt);
      ctx.session = {};
      if (r === 'bad') return ctx.reply('Похоже, это не Telegram ID: нужно число, например 397602448. Сам человек узнаёт свой командой /id.', tgAdminsPanelKb());
      if (r === 'env') return ctx.reply('Этот ID уже админ из .env.', tgAdminsPanelKb());
      return showTgAdminsPanel(ctx);
    }
    if (s.step === 'wait_admin_username') {
      const r = addTgAdminUsername(txt);
      ctx.session = {};
      if (r === 'bad') return ctx.reply('Юзернейм выглядит неправильно: латиница, цифры и подчёркивание, 3-32 знака, без @.', tgAdminsPanelKb());
      if (r === 'env') return ctx.reply('Этот юзернейм уже админ из .env.', tgAdminsPanelKb());
      return showTgAdminsPanel(ctx);
    }
    if (txt === 'Промокоды' || txt === '/promo') { ctx.session = {}; return showTgPromoPanel(ctx); }
    if (txt === 'Бекап БД' || txt === '/backup') { ctx.session = {}; return handleBackupRequest(ctx); }
    if (s.step === 'wait_promo_add') {
      const r = upsertPromoRule(getSetting('promo_codes'), txt);
      ctx.session = {};
      if (!r.ok) return ctx.reply(r.error, tgPromoKb());
      setSetting('promo_codes', r.serialized);
      const cond = [r.brand ? `только ${r.brand}` : '', r.minTotal ? `от ${r.minTotal.toLocaleString('ru-RU')} ₽` : ''].filter(Boolean).join(', ');
      return showTgPromoPanel(ctx, `Промокод ${r.code} сохранён: −${r.percent}%${cond ? ` (${cond})` : ''}.`);
    }
    if (s.step === 'wait_promo_rm') {
      const r = removePromoRule(getSetting('promo_codes'), txt);
      ctx.session = {};
      if (!r.ok) return ctx.reply(r.error, tgPromoKb());
      setSetting('promo_codes', r.serialized);
      return showTgPromoPanel(ctx, `Промокод ${r.code} убран.`);
    }
    if (s.step === 'wait_pay') { setSetting('payment_details', txt); ctx.session = {}; return ctx.reply('Реквизиты обновлены!'); }
    if (s.step === 'wait_cfg') {
      if (!isEditableSetting(s.key)) { ctx.session = {}; return ctx.reply('Эта настройка из бота не меняется.'); }
      setSetting(s.key, cleanText(txt));
      ctx.session = {};
      return ctx.reply('Сохранено!'); }
    if (s.step === 'cat_find') {
      ctx.session = { ...(ctx.session || {}), step: 'cat', query: txt, page: 1 };
      return showCatalogPageTg(ctx);
    }
    if (s.step === 'ord_find') {
      ctx.session = { ...(ctx.session || {}), step: 'ord', ordQuery: txt, ordPage: 1 };
      return showOrdersTg(ctx);
    }
    if (s.step === 'ord_new_items') {
      const r = parseManualItems(txt);
      if (!r.ok) return ctx.reply(`${r.error}\nПришли состав ещё раз или «Отмена».`);
      ctx.session = { ...(ctx.session || {}), step: 'ord_new_fio', ordItems: r.items };
      return ctx.reply('Шаг 2/3. ФИО покупателя:');
    }
    if (s.step === 'ord_new_fio') {
      ctx.session = { ...(ctx.session || {}), step: 'ord_new_phone', ordFio: txt };
      return ctx.reply('Шаг 3/3. Телефон покупателя:');
    }
    if (s.step === 'ord_new_phone') {
      const res = createManualOrder(db, { items: s.ordItems, fio: s.ordFio, phone: txt });
      ctx.session = { ...(ctx.session || {}), step: 'ord' };
      if (!res.ok) {
        ctx.session.step = 'ord_new_items';
        return ctx.reply(`${res.error}\nНачни заново: пришли состав (ID через запятую).`);
      }
      return showOrderTg(ctx, res.code);
    }
    if (s.step === 'pf_wait') {
      const res = setProductField(db, s.prodId, s.field, txt);
      if (!res.ok) return ctx.reply(`${res.error}\nПришли значение ещё раз или «Отмена».`);
      ctx.session = { ...(ctx.session || {}), step: 'cat' };
      return showProductTg(ctx, s.prodId);
    }
    if (s.step === 'wait_discount') {
      const id = s.prodId;
      const prod = db.prepare('SELECT id, name, price, old_price FROM products WHERE id = ?').get(id);
      ctx.session = {};
      if (!prod) return ctx.reply('Товар не найден — обновите список в «Товары и цены».');
      const res = discountFor(prod, txt.replace(/\D/g, ''));
      if (!res.ok) return ctx.reply(`${res.error} Пример: 20`);
      db.prepare('UPDATE products SET price = ?, old_price = ? WHERE id = ?').run(res.price, res.oldPrice, id);
      return ctx.reply(
        `#${id} ${prod.name}: −${res.percent}%\nБыло ${res.oldPrice.toLocaleString('ru-RU')} ₽ → стало ${res.price.toLocaleString('ru-RU')} ₽. На витрине старая цена стоит зачёркнутой и серой — без красного.\nЧтобы GitHub Pages увидел цену, нажмите «Экспорт каталога» и закоммитьте products-data.js.`,
        Markup.inlineKeyboard([[Markup.button.callback('Снять скидку', `tg_disc_clear_${id}`)]])
      );
    }
    if (s.step === 'wait_import') return runImportPreview(ctx, txt);
    if (s.step === 'confirm_import') {
      ctx.session = {};
      return ctx.reply('Импорт подтверждается кнопкой «Записать» под разбором — текстом не принимаю, чтобы не записать случайно.', tgAdminMenuKb());
    }
    if (s.step === 'add_brand') { s.draft.brand = txt.toUpperCase(); s.step = 'add_series'; return ctx.reply('Шаг 2/6. Серия (fenix, Forerunner, Apple Watch, Galaxy Watch, Suunto...):'); }
    if (s.step === 'add_series') { s.draft.series = txt; s.step = 'add_cat'; return ctx.reply('Шаг 3/6. Категория (Спортивные часы / Дайвинг компьютеры / Фитнес-трекеры):'); }
    if (s.step === 'add_cat') { s.draft.category = txt; s.step = 'add_name'; return ctx.reply('Шаг 4/6. Полное название:'); }
    if (s.step === 'add_name') { s.draft.name = txt; s.step = 'add_price'; return ctx.reply('Шаг 5/6. Цена (только число):'); }
    if (s.step === 'add_price') { s.draft.price = parseInt(txt.replace(/\D/g, ''), 10) || 0; s.step = 'add_specs'; return ctx.reply('Шаг 5.5/6. Описание/характеристики:'); }
    if (s.step === 'add_specs') { s.draft.specs = txt; s.step = 'add_img'; return ctx.reply('Шаг 6/6. Отправьте ФОТО с телефона или ссылку (или - для стандартного):'); }
    if (s.step === 'add_img') {
      const img = txt.startsWith('http') ? txt : 'https://pitergsm.ru/upload/iblock/3a6/dro4iv6iw9lyxqshlw9bxyi7npov6jt8.jpg';
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

  // Заказ с витрины: если код уже есть в БД (свой бэкенд) — показываем его.
  // Если витрина без бэкенда (GitHub Pages) — создаём заявку из deep link TG-XXXX_IDxQTYxPRICE_...
  // Названия и цены берутся только из базы: ссылку может прислать кто угодно.
  function parseOrderPayload(payload) {
    const rest = String(payload || '').split('_').slice(1);
    const items = [];
    const unknown = [];
    const stale = [];
    let promo = '';
    const byId = (id) => db.prepare('SELECT id, name, price FROM products WHERE id = ?').get(id);
    for (const part of rest) {
      const promoPart = part.match(/^PROMO([A-Za-z0-9_-]{1,24})$/);
      if (promoPart) { promo = promoPart[1].toUpperCase(); continue; }
      const tiPart = part.match(/^TI(\d+)x(\d+)x(.+)$/);
      if (tiPart) {
        const cond = TI_COND_TEXT[tiPart[1]] ? tiPart[1] : '3';
        const pid = Number(tiPart[2]);
        let model = String(tiPart[3]);
        try { model = decodeURIComponent(model); } catch (e) { /* процент-последовательность битая — берём как есть */ }
        model = model.slice(0, 100);
        const target = pid ? db.prepare('SELECT name FROM products WHERE id = ?').get(pid) : null;
        items.push({ id: 0, name: `Trade-In: ${model} — ${TI_COND_TEXT[cond]}${target ? '; обмен на ' + String(target.name).slice(0, 120) : ''}`, price: 0, qty: 1, ti: 1 });
        continue;
      }
      let m = part.match(/^(\d+)x(\d+)x(\d+)$/);
      if (m) {
        const prod = byId(Number(m[1]));
        if (prod) {
          // Разошлась цена — значит под этим id в базе другой товар (витрина отдаёт
          // устаревший products-data.js). Молча подставить базу = оформить не то,
          // что человек видел на экране, поэтому заявку не создаём вовсе.
          if (Number(m[3]) !== Number(prod.price)) stale.push({ id: prod.id, site: Number(m[3]), db: Number(prod.price) });
          else items.push({ id: prod.id, name: String(prod.name).slice(0, 200), price: prod.price, qty: Math.min(Number(m[2]) || 1, 99) });
        } else unknown.push(m[1]);
        continue;
      }
      m = part.match(/^(\d+)x(\d+)$/);
      if (m) {
        const prod = byId(Number(m[1]));
        if (prod) items.push({ id: prod.id, name: String(prod.name).slice(0, 200), price: prod.price, qty: Math.min(Number(m[2]) || 1, 99) });
        else unknown.push(m[1]);
      }
    }
    // Совместимость со старым форматом TG-XXXX_ID_PRICE
    if (!items.length && !unknown.length && !stale.length && rest.length >= 2 && /^\d+$/.test(rest[0] || '') && /^\d+$/.test(rest[1] || '')) {
      const prod = byId(parseInt(rest[0], 10));
      if (prod) items.push({ id: prod.id, name: String(prod.name).slice(0, 200), price: prod.price, qty: 1 });
      else unknown.push(rest[0]);
    }
    return { items, unknown, stale, promo };
  }

  function samePayload(order, items) {
    try {
      const stored = JSON.parse(order.items_json || '[]');
      if (stored.length !== items.length) return false;
      const key = (list) => list.map((i) => `${i.id ?? i.name}x${i.qty}`).sort().join('_');
      return key(stored) === key(items);
    } catch (e) {
      return false;
    }
  }

  function handleSiteOrderPayload(ctx, code, payload) {
    let order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(code);
    const parsed = parseOrderPayload(payload);
    // Витрина отдаёт каталог, который расходится с базой (старый products-data.js
    // на Pages): под теми же id там другие товары. Оформлять такое по базе —
    // значит прислать клиенту не то, что он выбирал.
    if (parsed.stale.length) {
      const clientTag = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Клиент');
      const detail = parsed.stale.map((s) => `id ${s.id}: сайт ${s.site} ₽ / база ${s.db} ₽`).join('\n');
      notifyTgAdmins(
        `⚠️ ЗАКАЗ ${code} НЕ СОЗДАН: каталог на витрине расходится с базой\n👤 ${clientTag} (ID: ${ctx.from.id})\n${detail}\nНужно обновить файл: кнопка «Экспорт каталога» в админке, затем коммит products-data.js.`
      );
      return ctx.reply(`Каталог на сайте сейчас расходится с нашей базой, поэтому заявку по этим позициям не создали, чтобы не перепутать товар. Напишите менеджеру — подтвердим наличие и цену вручную.`);
    }
    // Одинаковый номер у двух покупателей статической витрины — не их вина: счётчик
    // живёт в их браузере. Совпал состав — показываем существующую заявку,
    // не совпал — берём свободный номер и говорим об этом админу.
    if (order && parsed.items.length && !samePayload(order, parsed.items)) order = null;
    if (!order && parsed.items.length) {
      const subtotal = parsed.items.reduce((s, i) => s + i.price * i.qty, 0);
      // Промокод из deep link витрины проверяется здесь же: ссылка может быть
      // отредактирована, поэтому скидку считает сервер по ценам базы.
      const promoCode = String(parsed.promo || '').trim();
      const promoEval = promoCode
        ? evaluatePromo(getSetting('promo_codes'), promoCode, parsed.items, (id) => db.prepare('SELECT id, brand, price FROM products WHERE id = ?').get(id))
        : null;
      const discountRub = promoEval && promoEval.ok ? promoEval.discountRub : 0;
      const total = Math.max(0, subtotal - discountRub);
      const taken = (c) => !!db.prepare('SELECT 1 AS x FROM orders WHERE order_code = ?').get(c);
      let wanted = taken(code) ? allocateOrderCode() : code;
      const siteStatus = parsed.items.some((i) => i.ti) ? 'Trade-In (сайт)' : 'Новый (сайт)';
      const insertSite = (c) => db.prepare('INSERT INTO orders (order_code, items_json, total, status, owner_tg, promo_code, discount) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c, JSON.stringify(parsed.items), total, siteStatus, String(ctx.from.id), promoCode || null, discountRub);
      try {
        insertSite(wanted);
      } catch (e) {
        wanted = allocateOrderCode();
        insertSite(wanted);
      }
      order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(wanted);
      if (order) {
        const clientTag = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Клиент');
        const list = parsed.items.map((i) => `• ${i.name} × ${i.qty}`).join('\n');
        const promoNote = promoCode
          ? (discountRub > 0
            ? `\n🎟 Промокод ${promoCode}: −${Number(discountRub).toLocaleString('ru-RU')} ₽`
            : `\n🎟 Промокод ${promoCode} не применён: ${promoEval ? promoEval.error : 'не проверен'}`)
          : '';
        notifyTgAdmins(
          `🔔 НОВАЯ ЗАЯВКА С САЙТА ${wanted}${wanted === code ? '' : ' (витрина предложила занятый номер ' + code + ')'}\n👤 Клиент: ${clientTag} (ID: ${ctx.from.id})\n📦\n${list}\n💰 ${Number(total).toLocaleString('ru-RU')} ₽${promoNote}`
        );
      }
    }
    if (!order) {
      if (parsed.unknown.length) return ctx.reply(`Не нашёл в каталоге позиции: ${parsed.unknown.join(', ')}. Отправьте заказ заново или напишите менеджеру.`);
      return ctx.reply('Не удалось распознать состав заказа. Отправьте номер (например, TG-1176) или напишите менеджеру.');
    }
    try { recordBotOpened(db, String(ctx.from.id), order.order_code); } catch (e) {}
    return handleClientOrderLookupTg(ctx, order.order_code);
  }

  // Номера заявок идут по порядку — без проверки любой может перебирать TG-XXXX
  // и читать чужие составы. Поэтому чужую непривязанную заявку показываем только
  // за последними 4 цифрами телефона из заказа (как в /api/order-status).
  const pendingOrderAuth = new Map();
  function orderPhoneLast4(order) {
    try {
      const digits = String((JSON.parse(order.customer_json || '{}').phone) || '').replace(/\D/g, '');
      return digits.length >= 4 ? digits.slice(-4) : '';
    } catch (e) { return ''; }
  }
  function bindOrderOwner(code, tgId) {
    db.prepare('UPDATE orders SET owner_tg = ? WHERE order_code = ?').run(String(tgId), String(code).toUpperCase());
  }
  function showOrderToRequester(ctx, order) {
    const code = order.order_code;
    const items = JSON.parse(order.items_json || '[]');
    const list = items.map((i) => `• ${i.name} (${Number(i.price).toLocaleString('ru-RU')} ₽)`).join('\n');
    ctx.reply(`Ваш заказ ${code} найден!\n\n${list}\nИтого: ${Number(order.total).toLocaleString('ru-RU')} ₽\n\nРеквизиты:\n${getSetting('payment_details')}`);
    const tag = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    notifyTgAdmins(`Клиент ${tag} обратился по заказу ${code}`);
  }
  // Ответ на 4 цифры телефона для непривязанной заявки. Возвращает true,
  // если сообщение поглощено проверкой (тесты и on('text') используют это).
  function answerOrderAuth(ctx, rawDigits) {
    const requester = String(ctx.from?.id || '');
    const pend = pendingOrderAuth.get(requester);
    if (!pend) return false;
    const digits = String(rawDigits || '').trim();
    if (!/^\d{4}$/.test(digits)) {
      ctx.reply('Нужны ровно 4 цифры — последние цифры телефона из заказа. Для отмены напишите «Отмена».');
      return true;
    }
    pend.tries += 1;
    const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(pend.code);
    if (!order) { pendingOrderAuth.delete(requester); return ctx.reply('Заявка ' + pend.code + ' не найдена.'); }
    if (digits === orderPhoneLast4(order)) {
      pendingOrderAuth.delete(requester);
      bindOrderOwner(order.order_code, requester);
      order.owner_tg = requester;
      notifyTgAdmins('Клиент ' + (ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name) + ' подтвердил телефон и привязался к заявке ' + order.order_code);
      return showOrderToRequester(ctx, order);
    }
    if (pend.tries >= 3) {
      pendingOrderAuth.delete(requester);
      return ctx.reply('Трижды мимо — проверка сброшена. Напишите номер заявки заново или обратитесь к менеджеру.');
    }
    return ctx.reply('Не совпало с телефоном из заказа. Осталось попыток: ' + (3 - pend.tries) + '.');
  }
  function handleClientOrderLookupTg(ctx, code) {
    const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(code);
    if (!order) return ctx.reply(`Заказ ${code} не найден.`);
    const requester = String(ctx.from?.id || '');
    const admin = tgAdminIdList().includes(requester);
    if (admin || String(order.owner_tg || '') === requester) return showOrderToRequester(ctx, order);
    if (order.owner_tg && String(order.owner_tg) !== requester) {
      return ctx.reply(`Заказ ${code} оформлен другим покупателем. Состав и реквизиты пришлёт менеджер — напишите, если нужна помощь.`);
    }
    if (!orderPhoneLast4(order)) {
      bindOrderOwner(order.order_code, requester);
      order.owner_tg = requester;
      notifyTgAdmins('Клиент ' + (ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name) + ' привязался к заявке ' + order.order_code + ' (в заказе нет телефона для проверки)');
      return showOrderToRequester(ctx, order);
    }
    pendingOrderAuth.set(requester, { code: order.order_code, tries: 0 });
    return ctx.reply('Заявка ' + order.order_code + ' ещё ни за кем не закреплена. В целях защиты номеров от перебора пришлите последние 4 цифры телефона, указанного при заказе (или «Отмена»).');
  }

  tgBot.hears('Импорт товаров', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.session = { step: 'wait_import' };
    ctx.reply(
      'Пришли таблицу — текстом в чат или файлом .csv / .txt.\n\n' +
      'Столбцы: бренд;серия;категория;название;цена;описание;фото\n' +
      'Разделитель — ; или таб или запятая, первая строка-шапка распознаётся сама.\n\n' +
      'Пример:\nGARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990;AMOLED, титан;https://…\n\n' +
      `Категории (строго): ${IMPORT_CATEGORIES.join(', ')}\n\n` +
      'Сначала покажу разбор: сколько новых, сколько уже есть, что не читается. В базу ничего не запишется без кнопки «Записать».',
      Markup.inlineKeyboard([[Markup.button.callback('Отмена', 'imp_no')]])
    );
  });

  function runImportPreview(ctx, body) {
    const parsed = parseImportTable(body, db);
    if (!parsed.rows.length) {
      ctx.session = {};
      return ctx.reply(
        parsed.errors.length
          ? `Ни одна строка не подошла. Ошибки:\n${parsed.errors.slice(0, 8).map((e) => `  строка ${e.line}: ${e.reason}`).join('\n')}\n\nФормат: бренд;серия;категория;название;цена`
          : 'Пусто — не нашёл ни одной строки. Формат: бренд;серия;категория;название;цена',
        Markup.inlineKeyboard([[Markup.button.callback('Ещё раз', 'imp_retry'), Markup.button.callback('Отмена', 'imp_no')]])
      );
    }
    const cls = classifyImportRows(db, parsed.rows);
    ctx.session = { step: 'confirm_import', rows: cls.fresh };
    const kb = cls.fresh.length
      ? Markup.inlineKeyboard([[Markup.button.callback(`Записать ${cls.fresh.length}`, 'imp_yes'), Markup.button.callback('Отмена', 'imp_no')]])
      : Markup.inlineKeyboard([[Markup.button.callback('Понятно', 'imp_no')]]);
    return ctx.reply(importPreviewText(cls.fresh, cls.known, parsed.errors), kb);
  }

  tgBot.action('imp_retry', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { step: 'wait_import' };
    ctx.reply('Хорошо, жду таблицу снова.');
  });
  tgBot.action('imp_no', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery('Отменено');
    ctx.session = {};
    ctx.reply('Импорт отменён. Выберите действие:', tgAdminMenuKb());
  });
  tgBot.action('imp_yes', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const rows = (ctx.session && Array.isArray(ctx.session.rows)) ? ctx.session.rows : [];
    ctx.session = {};
    if (!rows.length) return ctx.answerCbQuery('Записывать нечего');
    const res = insertImportedRows(db, rows);
    ctx.answerCbQuery(res.error ? 'Ошибка' : `+${res.added}`);
    if (res.error) return ctx.reply(`Импорт остановлен: ${res.error}. Ни одна строка не записана — транзакция откатана.`);
    ctx.reply(
      `Записано ${res.added} позиций. Проверить: «Товары и цены».\nЧтобы витрина без сервера их увидела: «Экспорт каталога» → коммит products-data.js.`,
      tgAdminMenuKb()
    );
  });

  tgBot.on('document', async (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const s = ctx.session || {};
    if (s.step !== 'wait_import') return;
    const doc = ctx.message && ctx.message.document;
    if (!doc) return;
    const name = String(doc.file_name || '');
    const mime = String(doc.mime_type || '');
    if (/excel|spreadsheet|xlsx/i.test(mime) || /\.xlsx?$/i.test(name)) {
      ctx.session = {};
      return ctx.reply('Excel-файл не читаю — сохрани лист как CSV (Файл → Сохранить как → CSV) и пришли его.');
    }
    if (doc.file_size > 2000000) {
      ctx.session = {};
      return ctx.reply(`Файл ${(doc.file_size / 1048576).toFixed(1)} МБ — больше 2 МБ не берём, разрежь таблицу.`);
    }
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const r = await fetch(String(link), { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return ctx.reply('Не удалось скачать файл из Telegram — попробуй ещё раз.');
      const dec = decodeTextBytes(Buffer.from(await r.arrayBuffer()));
      if (!dec.text) return ctx.reply('Файл не читается ни как UTF-8, ни как windows-1251. Пересохраните его в UTF-8 или CSV.');
      ctx.session = { step: 'wait_import' };
      if (dec.encoding !== 'utf-8') ctx.reply(`Файл пришёл в ${dec.encoding} — перекодирую сам.`);
      return runImportPreview(ctx, dec.text);
    } catch (e) {
      ctx.session = {};
      return ctx.reply(`Файл не разобрался: ${redactSecrets(e.message)}`);
    }
  });

  tgBot.action('promo_add', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { step: 'wait_promo_add' };
    ctx.reply('Пришлите правило одной строкой: КОД ПРОЦЕНТ [БРЕНД] [minСУММА].\nПример: VIP20 20 GARMIN min100000', tgPromoKb());
  });
  tgBot.action('promo_rm', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { step: 'wait_promo_rm' };
    ctx.reply('Какой промокод убрать? Пришлите его код.', tgPromoKb());
  });
  tgBot.action('promo_list', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    showTgPromoPanel(ctx);
  });
  tgBot.action('promo_hl', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    setSetting('promo_highlight', getSetting('promo_highlight') === '1' ? '0' : '1');
    showTgPromoPanel(ctx, `Красные ценники ${getSetting('promo_highlight') === '1' ? 'ВКЛЮЧЕНЫ' : 'ВЫКЛЮЧЕНЫ'}.`);
  });
  tgBot.action('adm_add_id', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { step: 'wait_admin_id' };
    ctx.reply('Пришлите Telegram ID числа. Сам человек узнаёт свой командой /id.');
  });
  tgBot.action('adm_add_u', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = { step: 'wait_admin_username' };
    ctx.reply('Пришлите юзернейм без @ (например sheferochekgle). Полный доступ появится при первом сообщении этого человека боту.');
  });
  tgBot.action('adm_list', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    showTgAdminsPanel(ctx);
  });
  tgBot.action('adm_back', (ctx) => {
    if (!isTgAdmin(ctx)) return;
    ctx.answerCbQuery();
    ctx.session = {};
    ctx.reply('Выберите действие:', tgAdminMenuKb());
  });
  tgBot.action(/^adm_rm_id_(.+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const r = removeTgAdminId(ctx.match[1]);
    ctx.answerCbQuery(r === 'ok' ? 'Убран' : 'Не вышло');
    showTgAdminsPanel(ctx);
  });
  tgBot.action(/^adm_rm_u_(.+)$/, (ctx) => {
    if (!isTgAdmin(ctx)) return;
    const r = removeTgAdminUsername(ctx.match[1]);
    ctx.answerCbQuery(r === 'ok' ? 'Убран' : 'Не вышло');
    showTgAdminsPanel(ctx);
  });

  tgBot.telegram.getMe()
    .then((me) => console.log(`Telegram bot @${me.username} polling started`))
    .catch((e) => console.error('TG getMe failed:', redactSecrets(e.description || e.message)));
  tgBot.launch().catch((e) => console.error('TG polling error:', redactSecrets(e.description || e.message)));
  process.once('SIGINT', () => tgBot.stop('SIGINT'));
  process.once('SIGTERM', () => tgBot.stop('SIGTERM'));
}

// ---------- MAX bot (полный паритет с Telegram-ботом) ----------
// Документация: https://dev.max.ru/docs-api (домен platform-api2, авторизация через заголовок Authorization)
const MAX_API = 'https://platform-api2.max.ru';
const maxSessions = new Map(); // userId -> { step, draft, prodId, key }

function maxKb(rows, extraButtons) {
  // Кнопки типа message присылают боту заранее заданный текст — меню работает без answers API.
  // extraButtons — готовые кнопки других типов (link), добавляются последним рядом.
  const buttons = rows.map((r) => r.map((t) => ({ type: 'message', text: t, payload: t })));
  if (extraButtons && extraButtons.length) buttons.push(extraButtons);
  return [{
    type: 'inline_keyboard',
    payload: { buttons }
  }];
}

function maxShopLinkButtons() {
  const web = (process.env.WEBAPP_URL || '').trim();
  const shop = (process.env.SHOP_URL || '').trim();
  if (web) return [{ type: 'link', text: 'Открыть магазин', url: web }];
  if (shop) return [{ type: 'link', text: 'Открыть каталог', url: shop }];
  return [];
}

// Админов MAX может быть несколько, как в Telegram: ID через запятую в MAX_ADMIN_ID
// плюс добавленные из бота. MAX в updates не отдаёт юзернейм, поэтому список собран
// по числовым ID — свой ID клиент узнаёт командой /id.
const maxExtraAdminIds = new Set();
// Привязка по имени: MAX в updates не отдаёт юзернейм, только отображаемое имя.
// Админ вводит ожидаемое имя, первый написавший с таким именем привязывается по ID.
const maxPendingAdminNames = new Set();
function loadMaxAdminExtras() {
  for (const part of String(getSetting('max_extra_admin_ids') || '').split(',')) {
    const v = part.trim();
    if (v) maxExtraAdminIds.add(v);
  }
  for (const part of String(getSetting('max_pending_admin_names') || '').split('\n')) {
    const v = part.trim();
    if (v) maxPendingAdminNames.add(v);
  }
}
function saveMaxAdminExtras() {
  setSetting('max_extra_admin_ids', [...maxExtraAdminIds].join(','));
  setSetting('max_pending_admin_names', [...maxPendingAdminNames].join('\n'));
}
function addMaxAdminName(raw) {
  const v = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 64);
  if (v.length < 2) return 'bad';
  maxPendingAdminNames.add(v);
  saveMaxAdminExtras();
  return 'ok';
}
function removeMaxAdminName(raw) {
  const v = String(raw || '').trim();
  for (const n of maxPendingAdminNames) {
    if (n.toLowerCase() === v.toLowerCase()) { maxPendingAdminNames.delete(n); saveMaxAdminExtras(); return 'ok'; }
  }
  return 'none';
}
// Возвращает имя, по которому привязали, или null. Вызывать до админской проверки.
function bindMaxAdminByName(senderId, senderName) {
  if (isMaxAdminId(senderId) || !maxPendingAdminNames.size) return null;
  const name = String(senderName || '').trim();
  if (!name) return null;
  for (const n of maxPendingAdminNames) {
    if (n.toLowerCase() === name.toLowerCase()) {
      maxExtraAdminIds.add(String(senderId));
      maxPendingAdminNames.delete(n);
      saveMaxAdminExtras();
      return n;
    }
  }
  return null;
}
function maxAdminEnvIds() {
  return String(process.env.MAX_ADMIN_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function maxAdminIdList() {
  return [...new Set([...maxAdminEnvIds(), ...maxExtraAdminIds])];
}
// 'ok' | 'bad' | 'env' | 'none': админа из .env убрать нельзя, он база доступа
function addMaxAdminId(raw) {
  const v = String(raw || '').trim();
  if (!/^\d{3,20}$/.test(v)) return 'bad';
  if (maxAdminEnvIds().includes(v)) return 'env';
  maxExtraAdminIds.add(v);
  saveMaxAdminExtras();
  return 'ok';
}
function removeMaxAdminId(raw) {
  const v = String(raw || '').trim();
  if (maxAdminEnvIds().includes(v)) return 'env';
  if (!maxExtraAdminIds.delete(v)) return 'none';
  saveMaxAdminExtras();
  return 'ok';
}
function isMaxAdminId(senderId) {
  const id = String(senderId || '').trim();
  return !!id && maxAdminIdList().includes(id);
}
function maxAdminsText(selfId) {
  const me = String(selfId || '');
  const rows = [];
  for (const id of maxAdminEnvIds()) rows.push(`• ID ${id} — из .env, убрать можно только правкой .env${id === me ? ' (это ты)' : ''}`);
  for (const id of maxExtraAdminIds) rows.push(`• ID ${id} — добавлен через бота${id === me ? ' (это ты)' : ''}`);
  for (const n of maxPendingAdminNames) rows.push(`• имя «${n}» — ждёт первого сообщения`);
  return `Админы MAX (${rows.length}):\n${rows.join('\n') || '— пока никого —'}\n\nАдмин видит админ-меню и получает уведомления о заявках. Свой ID клиент узнаёт командой /id. Имя привязывается к первому написавшему с таким именем.`;
}
function maxAdminsKb() {
  const removable = [...maxExtraAdminIds];
  const rows = [];
  for (let i = 0; i < removable.length; i += 2) rows.push(removable.slice(i, i + 2).map((id) => `Убрать ID ${id}`));
  rows.push(['Добавить по ID', 'Добавить по имени']);
  const removableNames = [...maxPendingAdminNames];
  for (let i = 0; i < removableNames.length; i += 2) rows.push(removableNames.slice(i, i + 2).map((n) => `Убрать имя ${n}`));
  rows.push(['Отмена']);
  return rows;
}

function maxPromoKb() {
  const hl = getSetting('promo_highlight') === '1';
  return [['Добавить промокод', 'Убрать промокод'], [hl ? 'Красные ценники: вкл' : 'Красные ценники: выкл'], ['Отмена']];
}

const MAX_MENU = [['Добавить часы', 'Товары и цены'], ['Реквизиты оплаты', 'Тексты и контакты'], ['Последние заказы', 'Экспорт каталога'], ['Импорт товаров', 'Админы'], ['Сводка сайта', 'Фото на стоках'], ['Статистика', 'Журнал'], ['Промокоды', 'Дизайн'], ['Бекап БД', 'Отмена']];
const MAX_CANCEL = [['Отмена']];
// Кнопки меню и навигации админки. Пока бот ждёт значение поля или шаг мастера,
// нажатие такой кнопки обязано прервать ввод, а не уехать в него текстом.
const MAX_MENU_COMMANDS = new Set(['Добавить часы', 'Товары и цены', 'Полки', 'Реквизиты оплаты', 'Тексты и контакты', 'Доставка', 'Категории', 'Новая заявка', 'Последние заказы', 'Экспорт каталога', 'Импорт товаров', 'Сводка сайта', 'Фото на стоках', 'Статистика', 'Журнал', 'Админы', 'Добавить по ID', 'Добавить по имени', 'Промокоды', 'Дизайн', 'Дизайн: Stealth', 'Дизайн: Classic', 'Бекап БД', 'Добавить промокод', 'Убрать промокод', 'Красные ценники: вкл', 'Красные ценники: выкл', 'К списку', 'К заявкам', 'Найти товар', 'Найти заявку', 'Отмена', 'Подтвердить экспорт', 'Выгрузить и опубликовать', 'Подтвердить публикация']);
function maxIsMenuCommand(text) {
  const t = String(text || '').trim();
  return MAX_MENU_COMMANDS.has(t)
    || /^(?:Убрать ID \d+)$/.test(t)
  || /^Убрать имя .+$/.test(t)
    || /^Полка: .+$/.test(t)
    || /^Заказы: .+$/.test(t)
    || /^Товар #\d+$/i.test(t)
    || /^Заявка TG-\d+$/i.test(t)
    || /^Каталог [←→]$/.test(t)
    || /^Заявки [←→]$/.test(t)
    || /^(?:В хиты|Снять с хитов|Скидка|Удалить|Да, удалить) #\d+$/i.test(t)
    || /^(?:Удалить|Да, удалить) TG-\d+$/i.test(t)
    || /^(?:В сборку|Оплачен|Отменить|Новый|Trade-In) TG-\d+$/i.test(t)
    || new RegExp(`^(${Object.values(PRODUCT_FIELD_LABELS).join('|')}) #\\d+$`, 'i').test(t);
}

async function sendMaxMessage(userId, text, kbRows, extraButtons) {
  if (!isValidEnv(process.env.MAX_BOT_TOKEN)) return false;
  const body = { text: String(text).slice(0, 4000) };
  if (kbRows) body.attachments = maxKb(kbRows, extraButtons);
  try {
    const res = await fetch(`${MAX_API}/messages?user_id=${userId}`, {
      method: 'POST',
      headers: { Authorization: process.env.MAX_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.error(`MAX send failed: ${res.status} for user ${userId}`);
    return res.ok;
  } catch (e) {
    console.error(`MAX send error for user ${userId}: ${redactSecrets(e.message)}`);
    return false;
  }
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
  return [
    [`В сборку ${orderCode}`, `Оплачен ${orderCode}`],
    [`Отменить ${orderCode}`, `Новый ${orderCode}`],
  ];
}

// ---------- Админка MAX: те же экраны, что в Telegram ----------
// MAX не несёт inline-кнопок, поэтому кнопка = текст-команда. Клавиатуры
// собирают эти чистые функции, а работают с базой общие функции админки.
function maxShelvesText(shelves) {
  return `Каталог: ${shelves[0].count} позиций.\n${shelves.map((s) => `  ${s.category} — ${s.count}`).join('\n')}\n\nВыбери полку или «Найти товар».`;
}
function maxShelvesKb(shelves) {
  const rows = [];
  for (let i = 0; i < shelves.length; i += 2) rows.push(shelves.slice(i, i + 2).map((s) => `Полка: ${s.category}`));
  rows.push(['Найти товар', 'Сводка сайта']);
  return rows;
}
function maxCatalogText(res) {
  return [
    `${res.query ? `Поиск «${res.query}»` : `Полка: ${res.category}`} — позиций: ${res.total}, страница ${res.page} из ${res.pages}`,
    ...res.items.map((p) => {
      const off = (Math.trunc(Number(p.old_price)) || 0) > Number(p.price);
      return `#${p.id} ${p.name} — ${Number(p.price).toLocaleString('ru-RU')} ₽${off ? ' −' : ''}${Number(p.is_hit) ? ' ★' : ''}`;
    }),
  ].join('\n');
}
function maxCatalogKb(res) {
  const rows = [];
  for (let i = 0; i < res.items.length; i += 2) rows.push(res.items.slice(i, i + 2).map((p) => `Товар #${p.id}`));
  const nav = [];
  if (res.page > 1) nav.push('Каталог ←');
  if (res.page < res.pages) nav.push('Каталог →');
  if (nav.length) rows.push(nav);
  rows.push(['Полки', 'Найти товар']);
  return rows;
}
function maxProductKb(p) {
  return [
    Object.keys(PRODUCT_FIELD_LABELS).map((f) => `${PRODUCT_FIELD_LABELS[f]} #${p.id}`),
    [Number(p.is_hit) ? `Снять с хитов #${p.id}` : `В хиты #${p.id}`, `Скидка #${p.id}`],
    [`Удалить #${p.id}`, 'К списку'],
  ];
}
function maxOrdersText(res) {
  return [
    `Заявок: ${res.total}${res.status !== 'Все' ? ` со статусом «${res.status}»` : ''}${res.query ? `, поиск «${res.query}»` : ''}`,
    ...res.items.map((o) => `${o.order_code} — ${Number(o.total).toLocaleString('ru-RU')} ₽ [${o.status}] · ${o.created_at || ''}`),
  ].join('\n');
}
function maxOrdersKb(res, breakdown) {
  const rows = res.items.map((o) => [`Заявка ${o.order_code}`]);
  if (res.pages > 1) {
    const nav = [];
    if (res.page > 1) nav.push('Заявки ←');
    if (res.page < res.pages) nav.push('Заявки →');
    rows.push(nav);
  }
  const present = [['Все', breakdown.reduce((n, x) => n + x.count, 0)], ...breakdown.map((x) => [x.status, x.count])];
  for (let i = 0; i < present.length; i += 2) rows.push(present.slice(i, i + 2).map(([st]) => `Заказы: ${st}`));
  rows.push(['Найти заявку', 'Новая заявка', 'Сводка сайта']);
  return rows;
}

async function maxNotifyAdmin(text, orderCode) {
  const ids = maxAdminIdList();
  if (!ids.length) return;
  const kb = orderCode ? maxOrderStatusKb(orderCode) : undefined;
  for (const id of ids) await sendMaxMessage(id, text, kb);
}

async function maxAdminMenu(userId, title) {
  await sendMaxMessage(userId, title || 'Админ-панель Watchop (MAX). Выберите действие:', [...MAX_MENU, ...MAX_CANCEL], maxShopLinkButtons());
}

// Номера заявок идут по порядку — без проверки любой может перебирать TG-XXXX
// и читать чужие составы (а экран «Заявка TG-...» вообще отдавал полную карточку
// с данными покупателя). Поэтому чужую непривязанную заявку показываем только
// за последними 4 цифрами телефона из заказа.
const pendingMaxOrderAuth = new Map();
function maxOrderPhoneLast4(order) {
  try {
    const digits = String((JSON.parse(order.customer_json || '{}').phone) || '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : '';
  } catch (e) { return ''; }
}
function maxBindOrderOwner(code, senderId) {
  db.prepare('UPDATE orders SET owner_max = ? WHERE order_code = ?').run(String(senderId), String(code).toUpperCase());
}
async function maxClientOrderView(senderId, senderName, rawCode, text) {
  const code = String(rawCode || '').toUpperCase();
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(code);
  if (!order) { await sendMaxMessage(senderId, 'Заявка ' + code + ' не найдена.', MAX_MENU); return true; }
  const isAdmin = isMaxAdminId(senderId);
  if (isAdmin || String(order.owner_max || '') === String(senderId)) {
    await maxShowClientOrder(senderId, senderName, code);
    if (!isAdmin) await maxNotifyAdmin('Клиент ' + senderName + ' (' + senderId + ') в MAX по заказу ' + code);
    return true;
  }
  if (order.owner_max && String(order.owner_max) !== String(senderId)) {
    await sendMaxMessage(senderId, 'Заказ ' + code + ' оформлен другим покупателем. Состав и реквизиты пришлёт менеджер.');
    return true;
  }
  if (!maxOrderPhoneLast4(order)) {
    maxBindOrderOwner(code, senderId);
    await maxNotifyAdmin('Клиент ' + senderName + ' (' + senderId + ') привязался к заявке ' + code + ' в MAX (в заказе нет телефона для проверки)');
    await maxShowClientOrder(senderId, senderName, code);
    await maxNotifyAdmin('Клиент ' + senderName + ' (' + senderId + ') в MAX по заказу ' + code + ':\n"' + (text || '') + '"');
    return true;
  }
  pendingMaxOrderAuth.set(String(senderId), { code: order.order_code, tries: 0 });
  await sendMaxMessage(senderId, 'Заявка ' + code + ' ещё ни за кем не закреплена. В целях защиты номеров от перебора пришлите последние 4 цифры телефона, указанного при заказе (или «Отмена»).', MAX_CANCEL);
  return true;
}

async function maxShowClientOrder(senderId, senderName, code) {

  const items = JSON.parse((db.prepare('SELECT items_json FROM orders WHERE order_code = ?').get(code) || {}).items_json || '[]');
  const row = db.prepare('SELECT total FROM orders WHERE order_code = ?').get(code) || { total: 0 };
  const list = items.map((i) => '• ' + i.name + ' (' + Number(i.price).toLocaleString('ru-RU') + ' ₽)').join('\n');
  await sendMaxMessage(senderId, 'Заказ ' + code + ' принят!\n\n' + list + '\nК оплате: ' + Number(row.total).toLocaleString('ru-RU') + ' ₽\n\nРеквизиты:\n' + getSetting('payment_details'));
}
async function answerMaxOrderAuth(senderId, senderName, digits) {
  const pend = pendingMaxOrderAuth.get(String(senderId));
  if (!pend) return false;
  if (!/^\d{4}$/.test(String(digits || '').trim())) {
    await sendMaxMessage(senderId, 'Нужны ровно 4 цифры — последние цифры телефона из заказа. Для отмены напишите «Отмена».');
    return true;
  }
  pend.tries += 1;
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(pend.code);
  if (!order) { pendingMaxOrderAuth.delete(String(senderId)); await sendMaxMessage(senderId, 'Заявка ' + pend.code + ' не найдена.', MAX_MENU); return true; }
  if (String(digits).trim() === maxOrderPhoneLast4(order)) {
    pendingMaxOrderAuth.delete(String(senderId));
    maxBindOrderOwner(order.order_code, senderId);
    await maxNotifyAdmin('Клиент ' + senderName + ' (' + senderId + ') подтвердил телефон и привязался к заявке ' + order.order_code + ' в MAX');
    await maxShowClientOrder(senderId, senderName, order.order_code);
    return true;
  }
  if (pend.tries >= 3) {
    pendingMaxOrderAuth.delete(String(senderId));
    await sendMaxMessage(senderId, 'Трижды мимо — проверка сброшена. Напишите номер заявки заново или обратитесь к менеджеру.', MAX_MENU);
    return true;
  }
  await sendMaxMessage(senderId, 'Не совпало с телефоном из заказа. Осталось попыток: ' + (3 - pend.tries) + '.');
  return true;
}
const MAX_CFG_BUTTONS = {
  'Баннер': 'hero_title', 'Телефон': 'phone', 'Email': 'email', 'Адрес': 'address',
  'Доставка': 'delivery_methods', 'Категории': 'extra_categories',
  'Ссылка ТГ': 'tg_link', 'Ссылка MAX': 'max_link', 'ИП': 'legal_name', 'ИНН': 'legal_inn', 'ОГРНИП': 'legal_ogrnip'
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
  const editingImage = sess?.step === 'max_field' && sess.field === 'image';
  if (photoUrl && isMaxAdminId(senderId) && (sess?.step === 'add_img' || editingImage)) {
    try {
      const resp = await fetch(photoUrl);
      if (!resp.ok) throw new Error(`MAX отдал ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const fileName = `watch_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(uploadsDir, fileName), buf);
      const saved = `/uploads/${fileName}`;
      maxSessions.delete(senderId);
      if (editingImage) {
        const res = setProductField(db, sess.prodId, 'image', saved);
        if (!res.ok) return sendMaxMessage(senderId, res.error, MAX_MENU);
        return sendMaxMessage(senderId, productCardText(res.row), [...maxProductKb(res.row), ...MAX_CANCEL]);
      }
      return sendMaxMessage(senderId, `Часы "${sess.draft.name}" (${Number(sess.draft.price).toLocaleString('ru-RU')} ₽) добавлены! ID: ${finishAddingProductMax(sess.draft, saved)}`, MAX_MENU);
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
  let isMaxAdmin = isMaxAdminId(senderId);

  if (text === '/id') return sendMaxMessage(senderId, `Ваш MAX ID: ${senderId}`);

  if (!isMaxAdmin) {
    const pa = pendingMaxOrderAuth.get(String(senderId));
    if (pa) {
      if (text === 'Отмена') { pendingMaxOrderAuth.delete(String(senderId)); return sendMaxMessage(senderId, 'Отменено.', MAX_MENU); }
      if (/^\d{4}$/.test(text.trim())) return await answerMaxOrderAuth(senderId, senderName, text.trim());
      pendingMaxOrderAuth.delete(String(senderId));
    }
  }

  // Привязка админа по имени — до любых проверок: первое сообщение человека
  // с ожидаемым именем делает его админом и уходит из списка ожидания.
  const boundName = bindMaxAdminByName(senderId, senderName);
  if (boundName) { isMaxAdmin = true; await maxNotifyAdmin(`Новый админ MAX: ${senderName} (${senderId}) — привязан по имени «${boundName}».`); }

  const stMatch = text.match(/^(В сборку|Оплачен|Отменить|Новый|Trade-In)\s+(TG-\d+)$/i);
  if (stMatch) {
    if (!isMaxAdmin) return sendMaxMessage(senderId, 'Менять статус заказа может только администратор.');
    const map = { 'в сборку': 'В сборке', 'оплачен': 'Оплачен', 'отменить': 'Отменен', 'новый': 'Новый', 'trade-in': 'Trade-In' };
    const res = setOrderStatus(db, stMatch[2], map[stMatch[1].toLowerCase()]);
    if (!res.ok) return sendMaxMessage(senderId, res.error, MAX_MENU);
    return sendMaxMessage(senderId, `Статус ${res.code}: ${res.status}`, [...maxOrderStatusKb(res.code), ['К заявкам'], ...MAX_CANCEL]);
  }

  const ordCardMatch = text.match(/^Заявка (TG-\d+)$/i);
  if (ordCardMatch) {
    const code = ordCardMatch[1].toUpperCase();
    if (!isMaxAdmin) return await maxClientOrderView(senderId, senderName, code, text);
    const card = orderCardText(db, code);
    if (!card) return sendMaxMessage(senderId, `Заявка ${code} не найдена.`, MAX_MENU);
    return sendMaxMessage(senderId, card, [...maxOrderStatusKb(code), [`Удалить ${code}`], ['К заявкам'], ...MAX_CANCEL]);
  }
  const ordDelMatch = text.match(/^Удалить (TG-\d+)$/i);
  if (ordDelMatch) {
    const code = ordDelMatch[1].toUpperCase();
    if (!orderCardText(db, code)) return sendMaxMessage(senderId, `Заявка ${code} не найдена.`, MAX_MENU);
    return sendMaxMessage(senderId, `Удалить заявку ${code} вместе с составом и данными покупателя?\nОтменить это можно только из резервной копии базы.`, [[`Да, удалить ${code}`], ['Отмена']]);
  }
  const ordDelYesMatch = text.match(/^Да, удалить (TG-\d+)$/i);
  if (ordDelYesMatch) {
    const res = deleteOrderByCode(db, ordDelYesMatch[1]);
    if (!res.ok) return sendMaxMessage(senderId, res.error, MAX_MENU);
    return sendMaxMessage(senderId, `Заявка ${res.code} удалена (${Number(res.total).toLocaleString('ru-RU')} ₽, статус «${res.status}»).`, MAX_MENU);
  }
  if (text === 'Фото на стоках') {
    return sendMaxMessage(senderId, stockPhotoReport(db), MAX_MENU);
  }

  // Клиентский просмотр заказа по номеру не должен перекрывать админский ввод:
  // админ в шаге «найти заявку» или «новое значение поля» печатает тот же TG-XXXX.
  const stepNow = maxSessions.get(senderId);
  const maxAwaitingInput = !!(stepNow && stepNow.step && stepNow.step !== 'max_cat' && stepNow.step !== 'max_ord');
  const orderMatch = text.match(/TG-\d+/i);
  if (orderMatch && !text.startsWith('/') && !maxAwaitingInput) {
    const code = orderMatch[0].toUpperCase();
    if (await maxClientOrderView(senderId, senderName, code)) return;
  }

  if (!isMaxAdmin) {
    await maxNotifyAdmin(`Сообщение в MAX от ${senderName} (${senderId}):\n${text || '(без текста)'}`);
    return sendMaxMessage(senderId, 'Здравствуйте! Напишите номер заказа (например, TG-1176) или дождитесь менеджера.');
  }

  if (text === 'Статистика' || text === '/stats') {
    return sendMaxMessage(senderId, statsText(db, 7) + '\n\nДля месячной напиши «Статистика 30».', MAX_MENU);
  }
  const ownerStatsM = String(text || '').match(/^Статистика\s+(\d{1,3})$/i);
  if (ownerStatsM) {
    return sendMaxMessage(senderId, statsText(db, Math.max(1, Math.min(366, Number(ownerStatsM[1]) || 7))), MAX_MENU);
  }
  const ownerHistM = String(text || '').match(/^(?:Журнал|\/history)(?:\s+(.*))?$/i);
  if (ownerHistM) {
    const a = parseHistoryArgs(ownerHistM[1] || '');
    return sendMaxMessage(senderId, historyText(db, a.limit, a.entity, a.entityId) + '\n\nУточнить: «Журнал товар 45».', MAX_MENU);
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

  if (sess.step && maxIsMenuCommand(text)) maxSessions.delete(senderId);
  if (sess.step && !maxIsMenuCommand(text)) {
    if (sess.step === 'wait_pay') {
      setSetting('payment_details', text);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, 'Реквизиты оплаты обновлены на сайте!', MAX_MENU);
    }
    if (sess.step === 'wait_cfg') {
      if (!isEditableSetting(sess.key)) {
        maxSessions.delete(senderId);
        return sendMaxMessage(senderId, 'Эта настройка из бота не меняется.', MAX_MENU);
      }
      setSetting(sess.key, cleanText(text));
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, 'Настройка сайта сохранена!', MAX_MENU);
    }
    if (sess.step === 'max_add_admin') {
      const r = addMaxAdminId(cleanText(text));
      maxSessions.delete(senderId);
      if (r === 'bad') return sendMaxMessage(senderId, 'ID — это число из 3–20 цифр. Посмотреть его можно командой /id.', MAX_MENU);
      if (r === 'env') return sendMaxMessage(senderId, `ID ${cleanText(text)} и так админ из .env.\n\n${maxAdminsText(senderId)}`, maxAdminsKb());
      return sendMaxMessage(senderId, `Добавили.\n\n${maxAdminsText(senderId)}`, maxAdminsKb());
    }
    if (sess.step === 'max_add_admin_name') {
      const r = addMaxAdminName(cleanText(text));
      maxSessions.delete(senderId);
      if (r === 'bad') return sendMaxMessage(senderId, 'Нужно имя из 2+ знаков — так, как оно показано в MAX у человека.', MAX_MENU);
      return sendMaxMessage(senderId, `Жду первое сообщение от «${cleanText(text)}» — он станет админом.\n\n${maxAdminsText(senderId)}`, maxAdminsKb());
    }
    if (sess.step === 'max_promo_add') {
      const r = upsertPromoRule(getSetting('promo_codes'), cleanText(text));
      maxSessions.delete(senderId);
      if (!r.ok) return sendMaxMessage(senderId, r.error, maxPromoKb());
      setSetting('promo_codes', r.serialized);
      return sendMaxMessage(senderId, `Промокод ${r.code} сохранён.\n\n${promoRulesText(getSetting('promo_codes'))}`, maxPromoKb());
    }
    if (sess.step === 'max_promo_rm') {
      const r = removePromoRule(getSetting('promo_codes'), cleanText(text));
      maxSessions.delete(senderId);
      if (!r.ok) return sendMaxMessage(senderId, r.error, maxPromoKb());
      setSetting('promo_codes', r.serialized);
      return sendMaxMessage(senderId, `Промокод ${r.code} убран.\n\n${promoRulesText(getSetting('promo_codes'))}`, maxPromoKb());
    }
    if (sess.step === 'max_import') {
      const parsed = parseImportTable(text, db);
      if (!parsed.rows.length) {
        maxSessions.delete(senderId);
        return sendMaxMessage(senderId, parsed.errors.length
          ? `Ни одна строка не подошла:\n${parsed.errors.slice(0, 8).map((e) => `  строка ${e.line}: ${e.reason}`).join('\n')}`
          : 'Пусто — не нашёл ни одной строки.', MAX_MENU);
      }
      const cls = classifyImportRows(db, parsed.rows);
      maxSessions.set(senderId, { step: 'max_import_confirm', rows: cls.fresh });
      const kb = cls.fresh.length ? [[`Записать ${cls.fresh.length}`], ['Отмена']] : [['Отмена']];
      return sendMaxMessage(senderId, importPreviewText(cls.fresh, cls.known, parsed.errors), kb);
    }
    if (sess.step === 'max_import_confirm') {
      const rows = Array.isArray(sess.rows) ? sess.rows : [];
      maxSessions.delete(senderId);
      if (!rows.length) return sendMaxMessage(senderId, 'Записывать нечего.', MAX_MENU);
      const res = insertImportedRows(db, rows);
      if (res.error) return sendMaxMessage(senderId, `Импорт остановлен: ${res.error}. Ни одна строка не записана.`, MAX_MENU);
      return sendMaxMessage(senderId, `Записано ${res.added} позиций. Чтобы витрина без сервера их увидела: «Экспорт каталога» + коммит products-data.js.`, MAX_MENU);
    }
    if (sess.step === 'max_field') {
      const res = setProductField(db, sess.prodId, sess.field, text);
      if (!res.ok) return sendMaxMessage(senderId, `${res.error}\nПришли значение ещё раз или «Отмена».`, MAX_CANCEL);
      maxSessions.delete(senderId);
      return maxShowProduct(res.row.id);
    }
    if (sess.step === 'max_discount') {
      if (/^снять$/i.test(text.trim())) {
        const prod = productById(db, sess.prodId);
        const off = prod ? discountOff(prod) : { ok: false, error: 'Товар не найден.' };
        if (!off.ok) return sendMaxMessage(senderId, off.error, MAX_MENU);
        db.prepare('UPDATE products SET price = ?, old_price = 0 WHERE id = ?').run(off.price, sess.prodId);
        maxSessions.delete(senderId);
        return sendMaxMessage(senderId, `Скидка снята, цена снова ${off.price.toLocaleString('ru-RU')} ₽.`, MAX_MENU);
      }
      const prod = productById(db, sess.prodId);
      const res = prod ? discountFor(prod, text) : { ok: false, error: 'Товар не найден.' };
      if (!res.ok) return sendMaxMessage(senderId, `${res.error} Пример: 20`, MAX_CANCEL);
      db.prepare('UPDATE products SET price = ?, old_price = ? WHERE id = ?').run(res.price, res.oldPrice, sess.prodId);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, `−${res.percent}%: было ${res.oldPrice.toLocaleString('ru-RU')} ₽ → стало ${res.price.toLocaleString('ru-RU')} ₽. На витрине старая цена зачёркнута.\nЧтобы Pages увидел цену: «Экспорт каталога» + коммит products-data.js.`, MAX_MENU);
    }
    if (sess.step === 'max_find') {
      maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_cat', query: text, page: 1 });
      return maxShowCatalog();
    }
    if (sess.step === 'max_ord_find') {
      maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_ord', ordQuery: text, ordPage: 1 });
      return maxShowOrders();
    }
    if (sess.step === 'max_ord_new_items') {
      const r = parseManualItems(text);
      if (!r.ok) return sendMaxMessage(senderId, `${r.error}\nПришли состав ещё раз или «Отмена».`, MAX_CANCEL);
      maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_ord_new_fio', ordItems: r.items });
      return sendMaxMessage(senderId, 'Шаг 2/3. ФИО покупателя:', MAX_CANCEL);
    }
    if (sess.step === 'max_ord_new_fio') {
      maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_ord_new_phone', ordFio: text });
      return sendMaxMessage(senderId, 'Шаг 3/3. Телефон покупателя:', MAX_CANCEL);
    }
    if (sess.step === 'max_ord_new_phone') {
      const res = createManualOrder(db, { items: sess.ordItems, fio: sess.ordFio, phone: text });
      maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_ord' });
      if (!res.ok) {
        maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_ord_new_items' });
        return sendMaxMessage(senderId, `${res.error}\nНачни заново: пришли состав (ID через запятую).`, MAX_CANCEL);
      }
      const card = orderCardText(db, res.code);
      return sendMaxMessage(senderId, card || `Заявка ${res.code} создана.`, [...maxOrderStatusKb(res.code), [`Удалить ${res.code}`], ['К заявкам'], ...MAX_CANCEL]);
    }
    if (sess.step === 'add_brand') { sess.draft.brand = text.toUpperCase(); sess.step = 'add_series'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 2/6. Серия для фильтра (fēnix, Forerunner, Apple Watch, Galaxy Watch, Suunto...):'); }
    if (sess.step === 'add_series') { sess.draft.series = text; sess.step = 'add_cat'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 3/6. Категория (Спортивные часы / Дайвинг компьютеры / Фитнес-трекеры):'); }
    if (sess.step === 'add_cat') { sess.draft.category = text; sess.step = 'add_name'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 4/6. Полное название часов:'); }
    if (sess.step === 'add_name') { sess.draft.name = text; sess.step = 'add_price'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 5/6. Цена в рублях (только число):'); }
    if (sess.step === 'add_price') { sess.draft.price = parseInt(text.replace(/\D/g, ''), 10) || 0; sess.step = 'add_specs'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 5.5/6. Краткое описание/характеристики:'); }
    if (sess.step === 'add_specs') { sess.draft.specs = text; sess.step = 'add_img'; maxSessions.set(senderId, sess); return sendMaxMessage(senderId, 'Шаг 6/6. Отправьте ФОТО часов или ссылку на картинку (или - для стандартного фото):'); }
    if (sess.step === 'add_img') {
      const img = text.startsWith('http') ? text : 'https://pitergsm.ru/upload/iblock/3a6/dro4iv6iw9lyxqshlw9bxyi7npov6jt8.jpg';
      const id = finishAddingProductMax(sess.draft, img);
      maxSessions.delete(senderId);
      return sendMaxMessage(senderId, `Часы "${sess.draft.name}" (${Number(sess.draft.price).toLocaleString('ru-RU')} ₽) добавлены! ID: ${id}`, MAX_MENU);
    }
  }

  if (text === 'Добавить часы') {
    maxSessions.set(senderId, { step: 'add_brand', draft: {} });
    return sendMaxMessage(senderId, 'Шаг 1/6. Бренд (GARMIN, APPLE, SAMSUNG, SUUNTO, POLAR, COROS, HUAWEI, AMAZFIT, CASIO):', MAX_CANCEL);
  }
  function maxShowCatalog() {
    const s = maxSessions.get(senderId) || {};
    const res = catalogPage(db, { category: s.category, query: s.query, page: s.page });
    maxSessions.set(senderId, { ...s, step: 'max_cat', category: res.category, query: res.query, page: res.page });
    return sendMaxMessage(senderId, maxCatalogText(res), [...maxCatalogKb(res), ...MAX_CANCEL]);
  }
  function maxShowProduct(id) {
    const p = productById(db, id);
    if (!p) return sendMaxMessage(senderId, 'Товар не найден — вернись к полкам.', MAX_MENU);
    maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_cat', prodId: p.id });
    return sendMaxMessage(senderId, productCardText(p), [...maxProductKb(p), ...MAX_CANCEL]);
  }

  if (text === 'Товары и цены' || text === '/products' || text === 'Полки') {
    const shelves = catalogShelves(db);
    maxSessions.set(senderId, { step: 'max_cat', category: 'Все товары', page: 1, query: '' });
    return sendMaxMessage(senderId, maxShelvesText(shelves), [...maxShelvesKb(shelves), ...MAX_CANCEL]);
  }
  const shelfMatch = text.match(/^Полка: (.+)$/);
  if (shelfMatch) {
    const category = shelfMatch[1].trim();
    if (category !== 'Все товары' && !IMPORT_CATEGORIES.includes(category)) return sendMaxMessage(senderId, 'Такой полки нет на витрине.', MAX_MENU);
    maxSessions.set(senderId, { step: 'max_cat', category, page: 1, query: '' });
    return maxShowCatalog();
  }
  if (text === 'Найти товар') {
    maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_find' });
    return sendMaxMessage(senderId, 'Что ищем? Слово из названия, бренда, серии или описания:', MAX_CANCEL);
  }
  if (text === 'Каталог ←' || text === 'Каталог →') {
    const s = maxSessions.get(senderId) || {};
    maxSessions.set(senderId, { ...s, page: Math.max(1, (s.page || 1) + (text.endsWith('→') ? 1 : -1)) });
    return maxShowCatalog();
  }
  if (text === 'К списку') return maxShowCatalog();
  const prodMatch = text.match(/^Товар #(\d+)$/i);
  if (prodMatch) return maxShowProduct(Number(prodMatch[1]));
  const hitMatch = text.match(/^(?:В хиты|Снять с хитов) #(\d+)$/i);
  if (hitMatch) {
    const res = toggleProductHit(db, Number(hitMatch[1]));
    if (!res.ok) return sendMaxMessage(senderId, res.error, MAX_MENU);
    return maxShowProduct(res.row.id);
  }
  const fieldMatch = text.match(new RegExp(`^(${Object.values(PRODUCT_FIELD_LABELS).join('|')}) #(\\d+)$`, 'i'));
  if (fieldMatch) {
    const field = Object.keys(PRODUCT_FIELD_LABELS).find((f) => PRODUCT_FIELD_LABELS[f] === fieldMatch[1]);
    const p = productById(db, Number(fieldMatch[2]));
    if (!p) return sendMaxMessage(senderId, 'Товар не найден.', MAX_MENU);
    maxSessions.set(senderId, { step: 'max_field', field, prodId: p.id });
    const hint = field === 'category' ? `Полки: ${IMPORT_CATEGORIES.join(', ')}`
      : field === 'image' ? 'Ссылка http(s)://…, либо пришли фото файлом'
      : field === 'price' ? 'Только число, например 58990'
      : 'Новое значение:';
    return sendMaxMessage(senderId, `${fieldMatch[1]} товара #${p.id}\nСейчас: ${p[field] || '—'}\n\n${hint}`, MAX_CANCEL);
  }
  const discMatch = text.match(/^Скидка #(\d+)$/i);
  if (discMatch) {
    const p = productById(db, Number(discMatch[1]));
    if (!p) return sendMaxMessage(senderId, 'Товар не найден.', MAX_MENU);
    const stored = Math.trunc(Number(p.old_price)) || 0;
    maxSessions.set(senderId, { step: 'max_discount', prodId: p.id });
    return sendMaxMessage(senderId, `Скидка для #${p.id} ${p.name}\nЦена: ${Number(p.price).toLocaleString('ru-RU')} ₽${stored > p.price ? `, до уценки ${stored.toLocaleString('ru-RU')} ₽` : ''}\n\nПришли процент (1–90) или «снять»:`, MAX_CANCEL);
  }
  const delMatch = text.match(/^(?:Удалить #|\/del )(\d+)$/i);
  if (delMatch) {
    const p = productById(db, Number(delMatch[1]));
    if (!p) return sendMaxMessage(senderId, 'Товар не найден.', MAX_MENU);
    return sendMaxMessage(senderId, `Удалить #${p.id} ${p.name}?\nЭто необратимо: вернуть можно только из products-data.js или заведением заново.`, [[`Да, удалить #${p.id}`], ['Отмена']]);
  }
  const delYesMatch = text.match(/^Да, удалить #(\d+)$/i);
  if (delYesMatch) {
    const res = deleteProductById(db, Number(delYesMatch[1]));
    if (!res.ok) return sendMaxMessage(senderId, res.error, MAX_MENU);
    return sendMaxMessage(senderId, `Удалён #${res.id} «${res.name}». Проверь расхождение с файлом: «Экспорт каталога».`, MAX_MENU);
  }
  if (text === 'Админы') {
    return sendMaxMessage(senderId, maxAdminsText(senderId), maxAdminsKb());
  }
  if (text === 'Дизайн') {
    const cur = storeDesignName(db);
    return sendMaxMessage(senderId, 'Дизайн витрины: сейчас «' + STORE_DESIGNS[cur] + '». После смены — «Экспорт каталога» + коммит.', [['Дизайн: Stealth', 'Дизайн: Classic'], ['Отмена']]);
  }
  const designMatch = text.match(/^Дизайн: (Stealth|Classic)$/i);
  if (designMatch) {
    const key = designMatch[1].toLowerCase();
    const res = setStoreDesign(__dirname, key);
    if (!res.ok) return sendMaxMessage(senderId, res.error, MAX_MENU);
    return sendMaxMessage(senderId, 'Включён дизайн «' + res.label + '». Проверь витрину, затем: «Экспорт каталога» + коммит.', MAX_MENU);
  }
  if (text === 'Промокоды') {
    return sendMaxMessage(senderId, `${promoRulesText(getSetting('promo_codes'))}\n\nПравило задаётся строкой «КОД ПРОЦЕНТ [БРЕНД] [minСУММА]», например «VIP20 20 GARMIN min100000». Скидку считает сервер по ценам своей базы, клиент присылает только код.`, maxPromoKb());
  }
  if (text === 'Добавить промокод') {
    maxSessions.set(senderId, { step: 'max_promo_add' });
    return sendMaxMessage(senderId, 'Пришли правило одной строкой: КОД ПРОЦЕНТ [БРЕНД] [minСУММА]', MAX_CANCEL);
  }
  if (text === 'Убрать промокод') {
    maxSessions.set(senderId, { step: 'max_promo_rm' });
    return sendMaxMessage(senderId, 'Какой промокод убрать? Пришли его код.', MAX_CANCEL);
  }
  if (text === 'Красные ценники: вкл' || text === 'Красные ценники: выкл') {
    setSetting('promo_highlight', getSetting('promo_highlight') === '1' ? '0' : '1');
    return sendMaxMessage(senderId, `Красные ценники ${getSetting('promo_highlight') === '1' ? 'ВКЛЮЧЕНЫ' : 'ВЫКЛЮЧЕНЫ'}. Цены и скидки не тронуты.`, maxPromoKb());
  }
  if (text === 'Добавить по ID') {
    maxSessions.set(senderId, { step: 'max_add_admin' });
    return sendMaxMessage(senderId, 'Пришли числовой ID клиента — он узнаёт его командой /id:', MAX_CANCEL);
  }
  if (text === 'Добавить по имени') {
    maxSessions.set(senderId, { step: 'max_add_admin_name' });
    return sendMaxMessage(senderId, 'Пришли отображаемое имя человека в MAX — первый написавший с таким именем станет админом:', MAX_CANCEL);
  }
  const admRmName = text.match(/^Убрать имя (.+)$/);
  if (admRmName) {
    const r = removeMaxAdminName(admRmName[1]);
    const note = r === 'none' ? `Имени «${admRmName[1]}» нет в ожидании.` : `Имя «${admRmName[1]}» убрано из ожидания.`;
    return sendMaxMessage(senderId, `${note}\n\n${maxAdminsText(senderId)}`, maxAdminsKb());
  }
  const admRm = text.match(/^Убрать ID (\d+)$/);
  if (admRm) {
    const r = removeMaxAdminId(admRm[1]);
    const note = r === 'env' ? `ID ${admRm[1]} — админ из .env, убрать его можно только правкой .env.`
      : r === 'none' ? `ID ${admRm[1]} и так не в списке.`
      : `Убрали ID ${admRm[1]}: админ-меню и уведомления ему больше не уходят.`;
    return sendMaxMessage(senderId, `${note}\n\n${maxAdminsText(senderId)}`, maxAdminsKb());
  }
  if (text === 'Сводка сайта') {
    return sendMaxMessage(senderId, adminSummary(db, { show_payment: getSetting('show_payment') }), MAX_MENU);
  }
  if (text === 'Импорт товаров') {
    maxSessions.set(senderId, { step: 'max_import' });
    return sendMaxMessage(senderId,
      'Пришли таблицу текстом.\n\nСтолбцы: бренд;серия;категория;название;цена;описание;фото\n' +
      'Разделитель — ; или таб или запятая, строка-шапка распознаётся.\n\n' +
      'Пример:\nGARMIN;fenix;Спортивные часы;Garmin Fenix 8 43 мм;58990;AMOLED, титан;https://…\n\n' +
      `Категории (строго): ${IMPORT_CATEGORIES.join(', ')}\n\nСначала покажу разбор, в базу запишется только после «Записать».`,
      MAX_CANCEL);
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
    return sendMaxMessage(senderId, 'Что меняем на сайте?', [['Баннер'], ['Телефон', 'Email'], ['Адрес', 'Доставка'], ['Категории'], ['Ссылка ТГ', 'Ссылка MAX'], ['ИП', 'ИНН'], ['ОГРНИП', 'Отмена']]);
  }
  if (MAX_CFG_BUTTONS[text]) {
    const key = MAX_CFG_BUTTONS[text];
    maxSessions.set(senderId, { step: 'wait_cfg', key });
    return sendMaxMessage(senderId, `Текущее:\n${getSetting(key)}\n\nОтправьте новое значение:`, MAX_CANCEL);
  }
  if (text === 'Бекап БД') {
    const r = runBackup('кнопка Бекап БД (MAX)');
    return sendMaxMessage(senderId, r.ok ? ('Бекап готов: ' + r.file.split(/[\\/]/).pop() + '. Файл могу прислать в Telegram — напиши мне там «Бекап БД».') : ('Бекап не получился: ' + r.error), MAX_MENU);
  }
  if (text === 'Экспорт каталога' || text === '/export') {
    const preview = summarizeDiff(diffCatalog(fileCatalog(), catalogFromDb()));
    return sendMaxMessage(senderId, `Выгрузка каталога из рабочей базы в products-data.js\n\n${preview}\n\nФайл перезапишется целиком, текущая копия уйдёт в products-data.js.bak.`, [['Подтвердить экспорт', 'Выгрузить и опубликовать'], ['Отмена']]);
  }
  if (text === 'Выгрузить и опубликовать') {
    const prev = await publishPreview();
    if (!prev.ok) return sendMaxMessage(senderId, prev.error, MAX_MENU);
    return sendMaxMessage(senderId,
      `Публикация на GitHub Pages\n\nВ базе: ${prev.dbRows}, в файле сейчас: ${prev.fileRows}.\nВетка: ${prev.branch}, доступ: ${prev.via}.\nИзменённые файлы (${prev.files.length}):\n${prev.files.map((f) => `  ${f}`).join('\n') || '  — пусто —'}\n\nБот выгрузит каталог, синхронизирует зеркала, сделает коммит и push. В коммит попадут только файлы каталога и фото.`,
      [['Подтвердить публикацию'], ['Отмена']]);
  }
  if (text === 'Подтвердить публикацию') {
    const res = await publishCatalog(`MAX id ${senderId}`);
    try { setSetting('publish_last', JSON.stringify({ ok: res.ok, at: new Date().toISOString(), error: res.ok ? null : String(res.error || '').slice(0, 200) })); } catch (e) {}
    return sendMaxMessage(senderId, res.ok ? res.text : res.error, MAX_MENU);
  }
  if (text === 'Подтвердить экспорт') {
    const res = exportCatalog(true);
    if (res.blocked) return sendMaxMessage(senderId, res.text, MAX_MENU);
    const lines = [
      `Готово: в products-data.js записано ${res.rows} позиций.`,
      `Позиций, которых не было в файле: ${res.diff.onlyInDb.length}.`,
      `Позиций из файла, которых нет в базе: ${res.diff.onlyInFile.length} — они из файла ушли.`,
      res.written.length ? `Записано: ${res.written.join(', ')}` : 'Файлы не записаны.',
      res.failed.length ? `Ошибки записи: ${res.failed.join('; ')}` : '',
      'Файл нужно закоммитить и пересобрать GitHub Pages — витрина без бэкенда берёт каталог из него.',
      'В Telegram-боте тот же экспорт отдаёт файл документом.',
    ].filter(Boolean);
    return sendMaxMessage(senderId, lines.join('\n'), MAX_MENU);
  }
  function maxShowOrders() {
    const s = maxSessions.get(senderId) || {};
    const breakdown = orderStatusBreakdown(db);
    const res = ordersPage(db, { status: s.ordStatus, query: s.ordQuery, page: s.ordPage });
    maxSessions.set(senderId, { ...s, step: 'max_ord', ordStatus: res.status, ordQuery: res.query, ordPage: res.page });
    return sendMaxMessage(senderId, maxOrdersText(res), [...maxOrdersKb(res, breakdown), ...MAX_CANCEL]);
  }
  if (text === 'Последние заказы' || text === '/orders') {
    maxSessions.set(senderId, { step: 'max_ord', ordStatus: 'Все', ordQuery: '', ordPage: 1 });
    return maxShowOrders();
  }
  if (text === 'К заявкам') return maxShowOrders();
  if (text === 'Заявки ←' || text === 'Заявки →') {
    const s = maxSessions.get(senderId) || {};
    maxSessions.set(senderId, { ...s, ordPage: Math.max(1, (s.ordPage || 1) + (text.endsWith('→') ? 1 : -1)) });
    return maxShowOrders();
  }
  const ordFilterMatch = text.match(/^Заказы: (.+)$/);
  if (ordFilterMatch) {
    const s = maxSessions.get(senderId) || {};
    maxSessions.set(senderId, { ...s, step: 'max_ord', ordStatus: ordFilterMatch[1].trim(), ordPage: 1 });
    return maxShowOrders();
  }
  if (text === 'Найти заявку') {
    maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_ord_find' });
    return sendMaxMessage(senderId, 'Поиск по заявкам: номер (TG-1176), фамилия, телефон или название товара:', MAX_CANCEL);
  }
  if (text === 'Новая заявка') {
    maxSessions.set(senderId, { ...(maxSessions.get(senderId) || {}), step: 'max_ord_new_items' });
    return sendMaxMessage(senderId, 'Новая заявка вручную.\nШаг 1/3. Состав: ID товаров через запятую, количество — через x. Например: 12x2, 45', MAX_CANCEL);
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
    const id = finishAddingProductMax({ brand: brand.toUpperCase(), series, category: 'Спортивные часы', name, price, specs: '' }, 'https://pitergsm.ru/upload/iblock/3a6/dro4iv6iw9lyxqshlw9bxyi7npov6jt8.jpg');
    return sendMaxMessage(senderId, `Добавлено! ID: ${id}`, MAX_MENU);
  }

  return maxAdminMenu(senderId, 'Не понял команду. Выберите действие кнопкой:');
}
startMaxBotPolling();

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.type === 'entity.too.large' ? 413 : err.status === 400 ? 400 : 500;
  if (status === 500) console.error('HTTP error:', err.message);
  res.status(status).json({ error: status === 413 ? 'Слишком большой запрос' : status === 400 ? 'Некорректный JSON' : 'Ошибка сервера' });
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
loadTgAdminExtras();
loadMaxAdminExtras();
if (!tgAdminIdList().length && !tgAdminUsernameList().length) console.log('NOTE: TG_ADMIN_ID и TG_ADMIN_USERNAMES пусты — напишите боту /id и впишите свой ID в .env, иначе админка недоступна.');
checkDbIntegrity();
try {
  const last = getSetting('last_backup_at');
  if (!last || Date.now() - Date.parse(last) > 24 * 3600 * 1000) runBackup('startup: старше суток');
} catch (e) { console.error('Backup check failed:', e.message); }
setInterval(() => runBackup('scheduled: раз в сутки'), 24 * 3600 * 1000).unref?.();
const server = process.env.HOST ? app.listen(PORT, HOST, () => console.log(`Watchop running on http://${HOST}:${server.address().port}`)) : app.listen(PORT, () => console.log(`Watchop running on http://${HOST}:${server.address().port}`));

function gracefulShutdown() {
  try { if (server && server.close) server.close(); } catch (e) {}
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); } catch (e) {}
}
process.once("SIGINT", gracefulShutdown);
process.once("SIGTERM", gracefulShutdown);
