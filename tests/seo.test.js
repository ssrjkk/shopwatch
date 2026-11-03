const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mountFrontend } = require('./helpers/dom');
const cmsBridge = require('../cms-bridge');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const HTML_NO_SCRIPTS = HTML.split(/<script[\s\S]*?<\/script>/gi).join('');

describe('SEO, Schema.org, Accessibility (a11y), CMS и безопасность витрины', () => {
  let g;

  before(async () => {
    g = mountFrontend({ location: { origin: 'https://ssrjkk.github.io', pathname: '/shopwatch/' } });
    await new Promise((r) => setTimeout(r, 30));
  });

  it('1. Техническое SEO: lang="ru", UTF-8, viewport, robots, canonical, title и description', () => {
    assert.match(HTML, /<html lang="ru">/);
    assert.match(HTML, /<meta charset="UTF-8"\s*\/>/i);
    assert.match(HTML, /<meta name="viewport" content="width=device-width, initial-scale=1\.0"\s*\/>/);
    assert.match(HTML, /<meta name="robots" content="index, follow, max-image-preview:large/);
    assert.match(HTML, /<link rel="canonical" href="https:\/\/ssrjkk\.github\.io\/shopwatch\/"\s*\/>/);

    const titleMatch = HTML.match(/<title>([^<]+)<\/title>/);
    assert.ok(titleMatch, 'тег <title> присутствует');
    assert.ok(titleMatch[1].length >= 30 && titleMatch[1].length <= 120, `длина title оптимальна: ${titleMatch[1].length}`);
    assert.match(titleMatch[1], /Watchop.*Garmin/i);

    const descMatch = HTML.match(/<meta name="description" content="([^"]+)"/);
    assert.ok(descMatch, 'meta description присутствует');
    assert.ok(descMatch[1].length >= 80 && descMatch[1].length <= 220, `длина description оптимальна: ${descMatch[1].length}`);
    assert.match(descMatch[1], /347/);
  });

  it('2. Social SEO: полная разметка Open Graph (включая og:locale и og:site_name) и Twitter Cards', () => {
    for (const prop of ['og:title', 'og:type', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:description', 'og:locale', 'og:site_name']) {
      assert.ok(HTML.includes(`property="${prop}"`), `отсутствует ${prop}`);
    }
    for (const tw of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
      assert.ok(HTML.includes(`name="${tw}"`), `отсутствует ${tw}`);
    }
  });

  it('3. Schema.org Store + SearchAction: валидный JSON-LD магазина и поиска в #schema-jsonld', () => {
    const m = HTML.match(/<script id="schema-jsonld" type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(m, 'скрипт #schema-jsonld найден');
    const storeLd = JSON.parse(m[1]);
    assert.equal(storeLd['@context'], 'https://schema.org');
    assert.equal(storeLd['@type'], 'Store');
    assert.equal(storeLd.name, 'Watchop');
    assert.equal(storeLd.currenciesAccepted, 'RUB');
    assert.ok(storeLd.potentialAction && storeLd.potentialAction['@type'] === 'SearchAction', 'SearchAction для быстрых ссылок поисковика');
  });

  it('4. Schema.org Product + динамический document.title при переходе в товар и обратно', () => {
    const p = g.state.products[0];
    g.openProduct(p.id);
    const rawLd = g.document.getElementById('product-jsonld').textContent;
    assert.ok(rawLd.length > 10, 'JSON-LD товара записан');
    const prodLd = JSON.parse(rawLd);
    assert.equal(prodLd['@type'], 'Product');
    assert.equal(prodLd.sku, 'REF-' + String(p.id).padStart(4, '0'));
    assert.equal(prodLd.name, p.name);
    assert.equal(prodLd.offers.price, p.price);
    assert.equal(prodLd.offers.priceCurrency, 'RUB');
    assert.match(String(g.document.title), new RegExp(p.name.slice(0, 12)));

    // Возврат в каталог очищает только product-jsonld и возвращает каталожный title
    g.setProductJsonLd(null);
    assert.equal(g.document.getElementById('product-jsonld').textContent, '');
    assert.match(String(g.document.title), /Watchop/);
  });

  it('5. Индексация без JS (<noscript>) и семантические ориентиры (a11y landmarks)', () => {
    assert.match(HTML_NO_SCRIPTS, /<noscript>[\s\S]*Watchop[\s\S]*<\/noscript>/, 'блок <noscript> для поисковых ботов');
    for (const tag of ['<header', '<nav', '<main', '<aside', '<footer', '<h1']) {
      assert.ok(HTML_NO_SCRIPTS.includes(tag), `семантический тег ${tag} присутствует`);
    }
    const h1Count = (HTML_NO_SCRIPTS.match(/<h1\b/g) || []).length;
    assert.equal(h1Count, 1, 'ровно один главный заголовок <h1> в разметке страницы');
  });

  it('6. Zero-CLS и доступность карточек: явные width/height, alt, lazy-loading и 585-ценовой блок', () => {
    const sample = g.state.products.find((x) => Number(x.old_price) > Number(x.price)) || g.state.products[0];
    const card = g.productCardHTML(sample);
    assert.match(card, /width="600"\s+height="600"/, 'явные размеры изображения предотвращают CLS');
    assert.match(card, /loading="lazy"/, 'ленивая загрузка картинок сетки');
    assert.match(card, /decoding="async"/, 'асинхронное декодирование картинок');
    assert.match(card, /По коду WATCH10:/, 'клубная цена 585 Золотой в карточке');
    assert.match(card, /Арт\. REF-\d{4}/, 'артикул товара в карточке');
  });

  it('7. Безопасность: защита от XSS в карточке, поиске, JSON-LD и блокировка опасных URI', () => {
    const xssProd = {
      id: 9999,
      brand: '<script>alert(1)</script>',
      series: 'fēnix',
      category: 'Спортивные часы',
      name: '"><img src=x onerror=alert(2)>',
      price: 50000,
      old_price: 60000,
      image: 'javascript:alert(3)',
      specs: '</script><script>alert(4)</script>',
    };
    const card = g.productCardHTML(xssProd);
    assert.equal(card.includes('<script>'), false, 'скрипты в полях товара экранированы');
    assert.equal(card.includes('<img src=x'), false, 'выход из атрибута заблокирован (&quot;&gt;&lt;img)');
    assert.ok(card.includes('&quot;&gt;&lt;img src=x'), 'инъекция экранирована в безопасные сущности');
    assert.equal(g.safeImageSrc('javascript:alert(1)'), '');
    assert.equal(g.safeImageSrc('data:text/html,<script>alert(1)</script>'), '');
    assert.equal(g.safeImageSrc('vbscript:msgbox(1)'), '');
  });

  it('8. CMS-интеграция: экспорт 347 товаров в WooCommerce CSV, OpenCart CSV/SQL, PrestaShop CSV и нормализация вебхуков', () => {
    const items = g.state.products;
    assert.equal(items.length, 347);
    const wcCsv = cmsBridge.toWooCommerceCsv(items);
    const ocCsv = cmsBridge.toOpenCartCsv(items);
    const ocSql = cmsBridge.toOpenCartSql(items);
    const psCsv = cmsBridge.toPrestaShopCsv(items);
    assert.ok(wcCsv.includes('Regular price') && wcCsv.split('\n').length >= 348);
    assert.ok(ocCsv.includes('product_id;model;sku') && ocCsv.split('\n').length >= 348);
    assert.ok(ocSql.includes('INSERT INTO oc_product') && ocSql.includes('COMMIT;'));
    assert.ok(psCsv.includes('Product ID;Active (0/1)') && psCsv.split('\n').length >= 348);

    const wcOrder = cmsBridge.normalizeCmsWebhookOrder('woocommerce', { id: 101, total: 62320, billing: { first_name: 'Алексей', phone: '+79990001122' } });
    assert.equal(wcOrder.total, 62320);
    assert.equal(wcOrder.customer_name, 'Алексей');
  });

  it('9. Catalog Photo Integrity: zero cross-category/cross-brand photo collisions and PDP gallery switching works', async () => {
    const products = g.state.products;
    assert.equal(products.length, 347);

    // Verify all local catalog images exist on disk and are > 5KB
    for (const p of products) {
      assert.ok(p.image, `Product #${p.id} missing image`);
      if (p.image.startsWith('uploads/')) {
        const full1 = path.join(ROOT, 'public', p.image);
        const full2 = path.join(ROOT, p.image);
        assert.ok(fs.existsSync(full1), `Missing public/${p.image} for #${p.id}`);
        assert.ok(fs.existsSync(full2), `Missing ${p.image} for #${p.id}`);
        assert.ok(fs.statSync(full1).size > 5000, `Image public/${p.image} too small`);
      }
    }

    // Verify Garmin fishfinders do not use Deeper spherical image (bf348a64fec3.jpg)
    const garminEcho = products.filter((p) => p.category === 'Эхолоты' && p.brand === 'GARMIN');
    assert.ok(garminEcho.length >= 30);
    for (const p of garminEcho) {
      assert.equal(p.image, 'uploads/catalog/b9d6f4ef6615.jpg', `Garmin fishfinder #${p.id} should use Garmin Striker Vivid photo`);
    }

    // Verify Deeper uses bf348a64fec3.jpg
    const deeper = products.filter((p) => p.category === 'Эхолоты' && p.brand !== 'GARMIN');
    for (const p of deeper) {
      assert.equal(p.image, 'uploads/catalog/bf348a64fec3.jpg');
    }

    // Verify Hunting & Dog Collars use c1a51daed239.jpg (Alpha 300 + TT25) and not orange eTrex
    const hunting = products.filter((p) => p.category === 'Охота и дрессировка');
    assert.equal(hunting.length, 9);
    for (const p of hunting) {
      assert.equal(p.image, 'uploads/catalog/c1a51daed239.jpg');
    }

    // Verify Accessories & Bike computers have accurate sub-type photos (strap, charger cable, glass, silicone case, bike computer)
    const p333 = products.find((p) => p.id === 333); // Ремешок QuickFit
    const p340 = products.find((p) => p.id === 340); // Кабель зарядки
    const p343 = products.find((p) => p.id === 343); // Защитное стекло
    const p345 = products.find((p) => p.id === 345); // Силиконовый чехол
    const bike = products.find((p) => p.category === 'Велокомпьютеры');
    assert.ok(p333.image.includes('strap-'), 'QuickFit strap must use strap photo');
    assert.equal(p340.image, 'uploads/catalog/1a03db850d60.jpg');
    assert.equal(p343.image, 'uploads/catalog/60612ffd7012.jpg');
    assert.equal(p345.image, 'uploads/catalog/8a692ef52c16.jpg');
    const p346 = products.find((p) => p.id === 346); // Чехол Edge Red — без хотлинков
    assert.equal(p346.image, 'uploads/catalog/8a692ef52c16.jpg');
    assert.ok(!String(p346.image).startsWith('http'), 'no hotlink photos in catalog');
    assert.equal(bike.image, 'uploads/catalog/7ccfea8dd6a3.jpg');

    // Verify non-Garmin watch brands do not collide with Garmin photos
    const garminWatchImgs = new Set(products.filter((p) => p.brand === 'GARMIN' && (p.category === 'Спортивные часы' || p.category === 'Дайвинг компьютеры')).map((p) => p.image));
    for (const p of products.filter((p) => p.brand !== 'GARMIN' && p.category === 'Спортивные часы')) {
      assert.ok(!garminWatchImgs.has(p.image), `Brand ${p.brand} product #${p.id} collides with Garmin image ${p.image}`);
    }

    // Verify PDP main image #product-main-img shows exactly one honest photo (no fake angles)
    g.openProduct(1);
    const detailHtml = g.document.getElementById('product-detail-box').innerHTML;
    assert.match(detailHtml, /id="product-main-img"/, 'PDP must render #product-main-img');
    assert.ok(!detailHtml.includes('switchProductGalleryPhoto'), 'PDP must not render fake multi-angle switcher');
    assert.ok(!detailHtml.includes('product-3d-stage'), 'PDP must not render SVG 3D stage');
    assert.ok(!detailHtml.includes('renderModelStudioSVG'), 'PDP must not embed drawn renders');
    assert.equal((detailHtml.match(/id="product-main-img"/g) || []).length, 1, 'PDP has exactly one main photo');
    assert.match(detailHtml, /По коду WATCH10:/, 'PDP must render 585 Золотой club price box');
    g.setProductJsonLd(null);
  });
});
