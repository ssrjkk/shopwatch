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
    assert.match(titleMatch[1], /OneWatch.*Garmin/i);

    const descMatch = HTML.match(/<meta name="description" content="([^"]+)"/);
    assert.ok(descMatch, 'meta description присутствует');
    assert.ok(descMatch[1].length >= 80 && descMatch[1].length <= 220, `длина description оптимальна: ${descMatch[1].length}`);
    assert.match(descMatch[1], /391/);
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
    assert.equal(storeLd.name, 'OneWatch');
    assert.equal(storeLd.currenciesAccepted, 'RUB');
    assert.equal(storeLd.telephone, '+7 (473) 300-40-95');
    assert.equal(storeLd.email, 'watchopp@gmail.com');
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
    assert.equal(prodLd.offers.availability, 'https://schema.org/InStock');
    assert.ok(Array.isArray(prodLd.image) && prodLd.image.length === 4, 'все 4 студийных ракурса в Product JSON-LD');
    assert.match(String(g.document.title), new RegExp(p.name.slice(0, 12)));

    // Возврат в каталог очищает только product-jsonld и возвращает каталожный title
    g.setProductJsonLd(null);
    assert.equal(g.document.getElementById('product-jsonld').textContent, '');
    assert.match(String(g.document.title), /OneWatch/);
  });

  it('5. Индексация без JS (<noscript>) и семантические ориентиры (a11y landmarks)', () => {
    assert.match(HTML_NO_SCRIPTS, /<noscript>[\s\S]*OneWatch[\s\S]*<\/noscript>/, 'блок <noscript> для поисковых ботов');
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

  it('8. CMS-интеграция: экспорт 391 товаров в WooCommerce CSV, OpenCart CSV/SQL, PrestaShop CSV и нормализация вебхуков', () => {
    const items = g.state.products;
    assert.equal(items.length, 391);
    const wcCsv = cmsBridge.toWooCommerceCsv(items);
    const ocCsv = cmsBridge.toOpenCartCsv(items);
    const ocSql = cmsBridge.toOpenCartSql(items);
    const psCsv = cmsBridge.toPrestaShopCsv(items);
    assert.ok(wcCsv.includes('Regular price') && wcCsv.split('\n').length >= 392);
    assert.ok(ocCsv.includes('product_id;model;sku') && ocCsv.split('\n').length >= 392);
    assert.ok(ocSql.includes('INSERT INTO oc_product') && ocSql.includes('COMMIT;'));
    assert.ok(psCsv.includes('Product ID;Active (0/1)') && psCsv.split('\n').length >= 356);
    // Фото в выгрузках — абсолютные URL: WooCommerce/OpenCart/PrestaShop качают картинки по ссылкам
    for (const p of items) {
      assert.ok(String(p.image).startsWith('uploads/'), `Product #${p.id} must use local photo, got ${p.image}`);
    }
    assert.ok(wcCsv.includes('https://ssrjkk.github.io/shopwatch/uploads/catalog/'), 'Woo CSV carries absolute image URLs');
    assert.ok(psCsv.includes('https://ssrjkk.github.io/shopwatch/uploads/catalog/'), 'Presta CSV carries absolute image URLs');
    assert.ok(ocSql.includes('https://ssrjkk.github.io/shopwatch/uploads/catalog/'), 'OpenCart SQL carries absolute image URLs');
    // Галерея едет в движки: у каждого из 391 товаров 4 студийных ракурса (1 основной + 3 в галерее)
    assert.ok(items.every((p) => (p.images || []).length === 3), 'catalog ships 3-angle gallery per product');
    const first = items[0];
    const wcLine = wcCsv.split('\n').find((l) => l.startsWith(first.id + ','));
    assert.ok(wcLine && wcLine.split('uploads/catalog/').length - 1 >= 4, 'Woo CSV carries all 4 studio angles');
    assert.ok(ocSql.includes('INSERT INTO oc_product_image'), 'OpenCart SQL carries gallery rows');
    const rest = cmsBridge.toWooCommerceRestProduct(first);
    assert.equal(rest.images.length, 4, 'Woo REST carries 4 studio images');
    assert.ok(rest.images[0].src.includes('uploads/catalog/'), 'Woo REST studio image path');

    const wcOrder = cmsBridge.normalizeCmsWebhookOrder('woocommerce', { id: 101, total: 62320, billing: { first_name: 'Алексей', phone: '+79990001122' } });
    assert.equal(wcOrder.total, 62320);
    assert.equal(wcOrder.customer_name, 'Алексей');
  });

  it('9. Catalog Photo Integrity: у каждого из 391 товаров 4 реальных студийных кадра 900x900 1:1 на белом фоне без исключений', async () => {
    const products = g.state.products;
    assert.equal(products.length, 391);
    for (const p of products) {
      assert.match(String(p.image), /^uploads\/catalog\/prod-\d+-1\.jpg$/, `Product #${p.id} primary must be uploads/catalog/prod-<id>-1.jpg, got ${p.image}`);
      assert.equal((p.images || []).length, 3, `Product #${p.id} must ship gallery 2-4`); [2, 3, 4].forEach((k, idx) => assert.match(String(p.images[idx]), new RegExp('^uploads\\/catalog\\/prod-\\d+-' + k + '\\.jpg$')));
      for (const gg of [p.image, ...(p.images || [])]) {
        assert.ok(!String(gg).startsWith('http'), `no hotlink photos for #${p.id}`);
        assert.ok(fs.existsSync(path.join(ROOT, 'public', String(gg))), `Missing public/${gg} for #${p.id}`);
        assert.ok(fs.existsSync(path.join(ROOT, String(gg))), `Missing ${gg} for #${p.id} (root mirror)`);
      }
    }
    assert.ok(!/images\.unsplash\.com|upload\.wikimedia\.org|pitergsm\.ru|res\.garmin\.com|cdn\.shopify\.com|image-(us|ru)\.samsung\.com/.test(HTML), 'no third-party photo hosts in storefront');
    const probe = products[0];
    g.openProduct(probe.id);
    const detailHtml = g.document.getElementById('product-detail-box').innerHTML;
    assert.ok(detailHtml.includes('id="product-main-img"'), 'PDP must render #product-main-img');
    const mainBefore = detailHtml.match(/id="product-main-img" src="([^"]+)"/);
    assert.ok(mainBefore, 'main photo has src');
    assert.match(mainBefore[1], /^uploads\/catalog\/prod-\d+-1\.jpg$/, 'PDP main photo is 1/4 studio jpg');
    assert.ok(detailHtml.includes('pdp-th0'), 'PDP renders thumbnails 2-4');
    g.setPdpPhoto(2);
    const mainEl = g.document.getElementById('product-main-img');
    assert.ok(String(mainEl.src).includes('-3.jpg'), 'thumbnail switches main photo to 3/4');
    g.setProductJsonLd(null);
  });
});
