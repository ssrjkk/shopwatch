const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Playwright — объявленная dev-зависимость. Сюит честно пропускается, если пакета
// или браузера нет (например, в чистом CI без шага установки), а не падает на require:
// падение на загрузке файла валило весь npm test и красило CI.
let chromium = null;
let skipReason = '';
try {
  chromium = require('playwright').chromium;
} catch (e) {
  skipReason = 'playwright не установлен: npm i -D playwright && npx playwright install chromium';
}
if (chromium) {
  try {
    if (!fs.existsSync(chromium.executablePath())) skipReason = 'браузер chromium не скачан: npx playwright install chromium';
  } catch (e) {
    skipReason = 'браузер chromium не скачан: npx playwright install chromium';
  }
}

describe('E2E витрина: каталог → корзина → промо → оформление', { skip: skipReason || false }, () => {
  const PORT = 3221;
  const BASE = `http://localhost:${PORT}`;
  let child;
  let tmp;
  let browser;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-e2e-'));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: tmp,
      env: { ...process.env, PORT: String(PORT), TG_BOT_TOKEN: '', TG_ADMIN_ID: '', MAX_BOT_TOKEN: '', MAX_ADMIN_ID: '', ORDER_COOLDOWN_MS: '300' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 20000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('OneWatch running')) { clearTimeout(t); resolve(); }
      });
      child.on('error', reject);
    });
    try {
      const { DatabaseSync } = require('node:sqlite');
      const seedDb = new DatabaseSync(path.join(tmp, 'watchop.db'));
      try { seedDb.exec('UPDATE products SET stock = 1000'); } catch (e) {}
      seedDb.close();
    } catch (e) {}
    browser = await chromium.launch();
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) { child.kill(); await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); }); }
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  });

  async function funnel(viewport, label) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 120)));
    await page.goto(`${BASE}/#/catalog`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('#products-grid > *', { timeout: 20000 });
    // hero витрины берётся из настроек сервера, а не из строки теста
    const srv = await (await fetch(`${BASE}/api/state`)).json();
    assert.ok(srv.settings.hero_title, label + ': на сервере пустой hero_title');
    assert.equal((await page.textContent('#ui-hero-title')).trim(), srv.settings.hero_title.trim(), label + ': hero = настройка сервера');
    // пагинация: 10 по умолчанию
    assert.equal(await page.locator('#products-grid > *').count(), 10, label + ': 10 cards');
    // добавить в корзину (клик через JS: устойчиво к липкой шапке)
    await page.evaluate(() => { const b = document.querySelector('[data-cart-btn]'); if (b) b.click(); });
    await page.waitForFunction(() => document.getElementById('cart-badge').textContent.trim() === '1', null, { timeout: 10000 });
    // показать ещё — без скролла страницы (клик через JS, без автоскролла драйвера)
    const y0 = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => document.getElementById('show-more-btn').click());
    await page.waitForFunction(() => document.querySelectorAll('#products-grid > *').length === 20, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.scrollY), y0, label + ': no autoscroll');
    // корзина: количество +/-
    await page.goto(`${BASE}/#/cart`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('#cart-list > *', { timeout: 15000 });
    assert.equal(await page.locator('#cart-list > *').count(), 1, label + ': one cart row');
    const plus = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#cart-list button')].filter((b) => b.textContent.trim() === '+');
      if (btns[0]) { btns[0].click(); return true; }
      return false;
    });
    assert.ok(plus, label + ': qty button present');
    await page.waitForFunction(() => document.getElementById('cart-badge').textContent.trim() === '2', null, { timeout: 10000 });
    // оформление
    await page.getByRole('button', { name: 'Перейти к оформлению' }).click();
    await page.waitForSelector('#view-checkout:not(.hidden)', { timeout: 15000 });
    await page.locator('#f-fio').fill('Покупатель');
    await page.locator('#f-phone').fill('+7 000 000-00-00');
    await page.getByRole('button', { name: 'Подтвердить заказ' }).click();
    await page.waitForSelector('#view-order-success:not(.hidden)', { timeout: 20000 });
    const code = await page.textContent('#order-code-badge');
    assert.match(code.trim(), /^TG-\d+$/, label + ': order code');
    assert.match(await page.textContent('#view-order-success'), /Модель зарезервирована/, label + ': success note');
    assert.deepEqual(errors, [], label + ': no page errors: ' + errors.join(' | '));
    await page.close();
  }

  it('мобильный 375px: полный фуннел без ошибок', async () => {
    await funnel({ width: 375, height: 667 }, 'mobile');
  });

  it('десктоп 1280px: полный фуннел без ошибок', async () => {
    await funnel({ width: 1280, height: 800 }, 'desktop');
  });

  // Контраст — не «на глаз»: в обеих темах считаем реальные computed-цвета,
  // прозрачные слои композим на родителя, и ни один текст не имеет права
  // падать ниже WCAG 4.5. Так темы не разъезжаются после правки стилей.
  it('контраст текста витрины не ниже 4.5', async () => {
    const audit = () => {
      const parse = (s) => { const m = (String(s).match(/[\d.]+/g) || ['0', '0', '0']).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
      const lum = (a) => { const t = a.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]; };
      const over = (layers, base) => layers.reduce((acc, c) => [0, 1, 2].map((k) => Math.round(c[k] * c[3] + acc[k] * (1 - c[3]))), base);
      const bgOf = (el) => {
        const layers = [];
        let n = el;
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c[3] >= 0.999) return over(layers, c.slice(0, 3));
          if (c[3] > 0) layers.push(c);
          n = n.parentElement;
        }
        return over(layers, parse(getComputedStyle(document.body).backgroundColor).slice(0, 3));
      };
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 80) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.2) continue;
        const fg = parse(st.color);
        if (fg[3] < 0.5) continue;
        const bg = bgOf(el);
        const l1 = lum(fg.slice(0, 3)), l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (ratio < 4.5) bad.push(`${Math.round(ratio * 10) / 10}: ${text.slice(0, 40)} (${st.color} на rgb(${bg.join(',')}))`);
      }
      return bad;
    };
    // Тема на витрине одна (светлая): переключателя больше нет, поэтому и проверка одна.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 45000 });
      await page.waitForSelector('#products-grid > *', { timeout: 20000 });
      const views = ['#/catalog', '#/p/1', '#/cart', '#/about'];
      const found = [];
      for (const v of views) {
        await page.evaluate((h) => { location.hash = h; }, v);
        await page.waitForTimeout(600);
        for (const b of await page.evaluate(audit)) found.push('светлая ' + v + ' → ' + b);
      }
      await page.close();
      assert.deepEqual(found, [], 'текст, который не читается: \n' + found.join('\n'));
    }
  });
});
