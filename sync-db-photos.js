// Восстановление путей фото (image + gallery) в живой базе watchop.db из products-data.js
// и автоматическая пересъёмка docs/screenshots/*.png с уже живыми ракурсами (если поднят :3000 и доступен Playwright).
const fs = require('fs');
const path = require('path');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  ({ DatabaseSync } = require('./sqlite-compat.js'));
}

const ROOT = process.env.WATCHOP_DIR ? path.resolve(process.env.WATCHOP_DIR) : __dirname;
const DB = path.join(ROOT, 'watchop.db');
const catalogPath = path.join(ROOT, 'products-data.js');

if (!fs.existsSync(DB)) {
  console.error('База watchop.db не найдена в:', DB);
  process.exit(1);
}

const catalog = require(catalogPath);
const rows = Array.isArray(catalog) ? catalog : catalog.products;

// 0. Проверка наличия всех файлов на диске (public/uploads/catalog/*)
const missing = [];
for (const r of rows) {
  const list = [r.image, ...(Array.isArray(r.images) ? r.images : [])].filter(Boolean);
  for (const p of list) {
    const rel = String(p).replace(/^\/+/, '');
    if (/^https?:/i.test(rel)) continue;
    if (!fs.existsSync(path.join(ROOT, 'public', rel))) missing.push(r.id + ' -> ' + rel);
  }
}
console.log('Позиций в каталоге:', rows.length, '| Недостающих файлов на диске:', missing.length);
if (missing.length) {
  console.error('Примеры отсутствующих файлов:', missing.slice(0, 5).join(', '));
  process.exit(1);
}

// 1. Бэкап живой базы перед записью
const backupsDir = path.join(ROOT, 'backups');
fs.mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = path.join(backupsDir, 'watchop-prephotofix-' + stamp + '.db');
const src = new DatabaseSync(DB);
try {
  src.exec("VACUUM INTO '" + bak.replace(/'/g, "''") + "'");
  console.log('Создан бэкап БД:', path.basename(bak), (fs.statSync(bak).size / 1048576).toFixed(2) + ' МБ');
} finally {
  src.close();
}

// 2. Обновление image и gallery в транзакции
const db = new DatabaseSync(DB);
try {
  const upd = db.prepare('UPDATE products SET image = ?, gallery = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  let updated = 0, withGallery = 0;
  for (const r of rows) {
    const extra = Array.isArray(r.images) ? r.images : [];
    if (extra.length) withGallery++;
    upd.run(String(r.image || ''), extra.length ? JSON.stringify(extra) : '[]', r.id);
    updated++;
  }
  db.exec('COMMIT');
  const demoLeft = db.prepare("SELECT COUNT(*) AS c FROM products WHERE image LIKE 'uploads/demo/%' OR gallery LIKE '%uploads/demo/%'").get().c;
  console.log('Обновлено строк в watchop.db:', updated, '| С доп. ракурсами (gallery):', withGallery, '| Осталось uploads/demo:', demoLeft);
} catch (e) {
  try { db.exec('ROLLBACK'); } catch (_) {}
  console.error('ОШИБКА (выполнен ROLLBACK):', e.message);
  process.exit(1);
} finally {
  db.close();
}

// 3. Опциональная пересъёмка docs/screenshots/{catalog,product}-1280-light.png с живыми фото
(async () => {
  let pw;
  try {
    pw = require('playwright');
  } catch (_) {
    try { pw = require('D:/Dev/Temp/opencode/shot/node_modules/playwright'); } catch (_2) {}
  }
  if (!pw || !pw.chromium) return;
  const base = process.env.SHOP_BASE_URL || 'http://127.0.0.1:3000';
  try {
    const res = await fetch(base + '/healthz');
    if (!res.ok) return;
  } catch (_) {
    return;
  }
  const outDir = path.join(ROOT, 'docs', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + '/#/catalog', { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('#products-grid > *', { timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, 'catalog-1280-light.png') });

    await page.goto(base + '/#/p/411', { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('#product-detail-box img', { timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, 'product-1280-light.png') });
    console.log('Скриншоты docs/screenshots/{catalog,product}-1280-light.png пересняты с живыми фото.');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.warn('Пересъёмка скриншотов пропущена:', e.message);
});
