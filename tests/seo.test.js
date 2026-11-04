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
    // Галерея едет в движки: WooCommerce — все кадры через запятую, OpenCart — oc_product_image, REST — массив images
    const withGallery = items.find((p) => (p.images || []).length > 0);
    assert.ok(withGallery, 'catalog has gallery products for CMS export');
    const wcLine = wcCsv.split('\n').find((l) => l.startsWith(withGallery.id + ','));
    assert.ok(wcLine && wcLine.split('uploads/catalog/').length - 1 >= 2, 'Woo CSV carries all gallery angles');
    assert.ok(ocSql.includes('INSERT INTO oc_product_image'), 'OpenCart SQL carries gallery rows');
    const rest = cmsBridge.toWooCommerceRestProduct(withGallery);
    assert.ok(rest.images.length >= 2 && rest.images[0].src.includes('uploads/catalog/'), 'Woo REST carries gallery images');

    const wcOrder = cmsBridge.normalizeCmsWebhookOrder('woocommerce', { id: 101, total: 62320, billing: { first_name: 'Алексей', phone: '+79990001122' } });
    assert.equal(wcOrder.total, 62320);
    assert.equal(wcOrder.customer_name, 'Алексей');
  });

  it('9. Catalog Photo Integrity: уникальные официальные фото, галерея реальных ракурсов в PDP работает', async () => {
    const products = g.state.products;
    assert.equal(products.length, 391);

    // Все локальные фото каталога существуют на диске и весят больше 5 КБ
    for (const p of products) {
      assert.ok(p.image, `Product #${p.id} missing image`);
      if (p.image.startsWith('uploads/')) {
        const full1 = path.join(ROOT, 'public', p.image);
        const full2 = path.join(ROOT, p.image);
        assert.ok(fs.existsSync(full1), `Missing public/${p.image} for #${p.id}`);
        assert.ok(fs.existsSync(full2), `Missing ${p.image} for #${p.id}`);
        assert.ok(fs.statSync(full1).size > 5000, `Image public/${p.image} too small`);
      } else {
        assert.fail(`Product #${p.id} must use local photo, got ${p.image}`);
      }
      for (const extra of p.images || []) {
        assert.ok(String(extra).startsWith('uploads/'), `Gallery of #${p.id} must be local, got ${extra}`);
        assert.ok(!String(extra).includes('..'), `Gallery of #${p.id} must not escape catalog`);
        const gfull = path.join(ROOT, 'public', String(extra));
        assert.ok(fs.existsSync(gfull), `Missing gallery file public/${extra} for #${p.id}`);
        assert.ok(!String(extra).startsWith('http'), `no hotlink photos in gallery of #${p.id}`);
      }
    }

    // Рисованных заглушек больше нет: ни одна позиция не ссылается на старые общие кадры
    const retired = ['b9d6f4ef6615.jpg', '7ccfea8dd6a3.jpg', '117ad77b91d1.jpg', 'c1a51daed239.jpg'];
    for (const p of products) {
      for (const f of [p.image, ...(p.images || [])]) {
        assert.ok(!retired.some((r) => String(f).includes(r)), `Product #${p.id} still uses retired placeholder ${f}`);
      }
    }

    // Бывшие «общие» полки теперь на уникальных официальных фото Garmin:
    // эхолоты/вело/GPS — только grm-*, охота — grm-* (Alpha/TT), аксессуары — grm-/strap-/cable-case
    const grmEcho = products.filter((p) => p.category === 'Эхолоты' && p.brand === 'GARMIN');
    assert.ok(grmEcho.length >= 30);
    for (const p of grmEcho) {
      assert.match(p.image, /^uploads\/catalog\/(grm-|1a03db|60612ffd)/, `Garmin fishfinder #${p.id} must use its own official photo`);
    }
    const bike = products.filter((p) => p.category === 'Велокомпьютеры');
    assert.ok(bike.length >= 25);
    for (const p of bike) {
      assert.match(p.image, /^uploads\/catalog\/(grm-|strap-)/, `Bike product #${p.id} must use its own official photo`);
    }
    const gps = products.filter((p) => p.category === 'GPS навигаторы');
    assert.ok(gps.length >= 20);
    for (const p of gps) {
      assert.match(p.image, /^uploads\/catalog\/grm-/, `GPS product #${p.id} must use its own official photo`);
    }
    const hrm = products.filter((p) => p.category === 'Пульсометры');
    assert.ok(hrm.length >= 3);
    for (const p of hrm) {
      assert.match(p.image, /^uploads\/catalog\/(grm-|hrm-)/, `HRM product #${p.id} must use its own official photo`);
    }
    // Часы Garmin: у каждой модели своё официальное фото (семейство), без межмодельных подмен.
    // Исключение: Instinct 2X снят с CDN Garmin — у тройки 2X эксклюзивные реальные кадры Instinct
    // (c6c21c631092.jpg, dc44ad2d853f.jpg), не делящиеся ни с одной другой моделью.
    // Флагманы ноября (348-355) — проверенные официальные кадры новинок.
    const legacy2x = new Set(['c6c21c631092.jpg', 'dc44ad2d853f.jpg']);
    const flagships = new Set(['151ac55518b4.jpg', 'e47c1ab7782b.jpg', '50b0168da31b.jpg', 'b9be435821f2.jpg', '21e6e8b54831.jpg', 'abab639295cb.jpg', '705b4833de45.jpg', 'b51f6af2a838.jpg']);
    const garminWatches = products.filter((p) => p.brand === 'GARMIN' && ['Спортивные часы', 'Дайвинг компьютеры', 'Фитнес-трекеры'].includes(p.category));
    assert.ok(garminWatches.length >= 120);
    for (const p of garminWatches) {
      const f = String(p.image).split('/').pop();
      const ok = /^uploads\/catalog\/(wch-|grm-|apl-|descent-|edge-|garmin-|hrm-)/.test(p.image) || (legacy2x.has(f) && [12, 75, 76].includes(p.id)) || (flagships.has(f) && p.id >= 348 && p.id <= 355);
      assert.ok(ok, `Garmin watch #${p.id} must use its own official family photo, got ${p.image}`);
    }
    // COROS: по-модельные официальные кадры. Vertix 2S Space — белые (28-r0..r2),
    // чёрные с бахромой вычищены; Earth без белых фото удалён из каталога.
    for (const p of products.filter((x) => x.brand === 'COROS')) {
      assert.match(p.image, /^uploads\/catalog\/(coros-|b51f6af2a838|2[89]-r\d+\.jpg|165-r\d+\.jpg|166-r\d+\.jpg|167-r\d+\.jpg|170-r\d+\.jpg)/, `COROS #${p.id} must use its own official photo`);
    }
    // Suunto: официальные кадры suunto.com, локально. fa58 был гармином —
    // вычищен: Race S только белые 25-r*. Вертикали Canyon — оранжевые 24-r*.
    for (const p of products.filter((x) => x.brand === 'SUUNTO')) {
      assert.match(p.image, /^uploads\/catalog\/(suunto-|0c0cc5828a34|705b4833de45|2[45]-r\d+\.jpg|150-r\d+\.jpg|151-r\d+\.jpg|354-r\d+\.jpg)/, `SUUNTO #${p.id} must use its own official shot, got ${p.image}`);
      assert.ok(!String(p.image).includes('fa58d622c06a'), `SUUNTO #${p.id} still uses Garmin photo fa58`);
    }
    // Casio: официальные кадры дилера-референса AllTime, локально. Старых общих
    // плейсхолдеров (rangeman/dw5600) в каталоге больше нет — ни primary, ни галереи.
    const casioLegacy = new Set(['casio-rangeman.jpg', 'casio-dw5600.jpg']);
    for (const p of products.filter((x) => x.brand === 'CASIO')) {
      const f = String(p.image).split('/').pop();
      assert.ok(String(p.image).startsWith('uploads/catalog/casio-'), `CASIO #${p.id} must use official shot, got ${p.image}`);
      assert.ok(!casioLegacy.has(f), `CASIO #${p.id} still uses legacy placeholder ${f}`);
      for (const g of p.images || []) {
        assert.ok(!casioLegacy.has(String(g).split('/').pop()), `CASIO #${p.id} gallery still uses legacy placeholder ${g}`);
      }
    }

    // Verify Deeper uses bf348a64fec3.jpg
    const deeper = products.filter((p) => p.category === 'Эхолоты' && p.brand !== 'GARMIN');
    for (const p of deeper) {
      assert.equal(p.image, 'uploads/catalog/bf348a64fec3.jpg');
    }

    // Охота: 9 позиций на официальных фото (Alpha 300/TT25, Astro, DriveTrack, Tread, PRO 550)
    const hunting = products.filter((p) => p.category === 'Охота и дрессировка');
    assert.equal(hunting.length, 9);
    for (const p of hunting) {
      assert.match(p.image, /^uploads\/catalog\/grm-/, `Hunting #${p.id} must use official photo`);
    }

    // Точечная проверка исправленных позиций: трансмиттеры, кабели, чехлы, чехлы Striker, Varia, Rally, датчики, ошейники, HRM
    const must = {
      318: 'uploads/catalog/descent-t2-transmitter.jpg',
      319: 'uploads/catalog/descent-t1-transmitter.jpg',
      340: 'uploads/catalog/garmin-usbc-usbc-1m.jpg',
      341: 'uploads/catalog/garmin-usba-usbc-05m.jpg',
      345: 'uploads/catalog/edge-case-black.jpg',
      346: 'uploads/catalog/edge-case-red.jpg',
      230: 'uploads/catalog/grm-010-13130-00.jpg',
      231: 'uploads/catalog/grm-010-13131-00.jpg',
      244: 'uploads/catalog/grm-010-02890-00.jpg',
      246: 'uploads/catalog/grm-010-02703-01.jpg',
      248: 'uploads/catalog/grm-010-02252-00.jpg',
      249: 'uploads/catalog/grm-010-01674-00.jpg',
      252: 'uploads/catalog/grm-010-02388-03.jpg',
      255: 'uploads/catalog/grm-010-13118-05.jpg',
      256: 'uploads/catalog/grm-010-13383-01.jpg',
      257: 'uploads/catalog/grm-010-12845-30.jpg',
      258: 'uploads/catalog/grm-010-12843-30.jpg',
      260: 'uploads/catalog/grm-010-12563-02.jpg',
      261: 'uploads/catalog/grm-010-12563-00.jpg',
      271: 'uploads/catalog/grm-010-02734-00.jpg',
      272: 'uploads/catalog/grm-010-02782-00.jpg',
      273: 'uploads/catalog/grm-010-02759-00.jpg',
      347: 'uploads/catalog/wch-fenix9.jpg',
      28: 'uploads/catalog/28-r0.jpg',
      165: 'uploads/catalog/coros-pace-black.jpg',
      281: 'uploads/catalog/grm-010-02755-70.jpg',
      284: 'uploads/catalog/grm-010-02602-30.jpg',
      330: 'uploads/catalog/hrm-600.jpg',
      331: 'uploads/catalog/grm-010-13314-00.jpg',
      332: 'uploads/catalog/grm-010-13383-01.jpg',
      333: null, // ремешок — strap-*
    };
    for (const [id, img] of Object.entries(must)) {
      const p = products.find((x) => x.id === Number(id));
      assert.ok(p, `Product #${id} exists`);
      if (img) assert.equal(p.image, img, `Product #${id} photo`);
      else assert.ok(String(p.image).includes('strap-'), `QuickFit strap #${id} must use strap photo`);
    }
    assert.equal(products.find((p) => p.id === 343).image, 'uploads/catalog/60612ffd7012.jpg');
    // Apple: только официальные кадры apple.com, локально (новая линейка — apl-*, прошлые — проверенные legacy-кадры)
    const appleLegacy = new Set(['ac502e2323a5.jpg', 'f52aeeb5346a.jpg', '161cd1030748.jpg', '2e854a960bcd.jpg', '312d50ca27f4.jpg', '4449d1120508.jpg']);
    for (const p of products.filter((x) => x.brand === 'APPLE')) {
      const f = String(p.image).split('/').pop();
      assert.ok(String(p.image).startsWith('uploads/catalog/apl-') || appleLegacy.has(f), `Apple #${p.id} must use official apple.com shot, got ${p.image}`);
    }

    // Verify non-Garmin watch brands do not collide with Garmin photos
    const garminWatchImgs = new Set(products.filter((p) => p.brand === 'GARMIN' && (p.category === 'Спортивные часы' || p.category === 'Дайвинг компьютеры')).map((p) => p.image));
    for (const p of products.filter((p) => p.brand !== 'GARMIN' && p.category === 'Спортивные часы')) {
      assert.ok(!garminWatchImgs.has(p.image), `Brand ${p.brand} product #${p.id} collides with Garmin image ${p.image}`);
    }

    // Покрытие ракурсами: норма — 4–5 реальных кадров на позицию (primary + галерея).
    // Исключения — только там, где у официального референса физически нет больше
    // белых кадров (проверено вручную по сайтам производителей):
    // - аксессуары Garmin с 1–2 официальными кадрами (крепления, кабели, чехлы,
    //   датчики, ошейники, трансмиттеры, стекла, ремешки QuickFit)
    // - снятый с CDN Instinct 2X (12, 75, 76), Suunto Canyon (24, 142 — всего 3 белых),
    //   Huawei без части цветов (30, 171, 172, 173, 174, 180), Watch 6 Classic Silver (137),
    //   GTS 4 Mini Mint (187), Baby-G BGD-565U-1 (395)
    const FEWER_THAN_4_OK = new Set([
      12, 75, 76, 219, 226, 227, 228, 229, 230, 231, 232, 233, 256, 279, 322, 328,
      329, 330, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 362,
      24, 142, 143, 30, 171, 172, 173, 174, 180, 137, 187, 395,
      28, 29, 162, 164, 165, 166, 167, 176, 188, 25, 144, 145, 150,
      // 146/147 Charcoal и 163 Earth удалены: честных фото нет вообще
      // wch-аудит: 14/89 (MARQ Athlete без белых углов), 348 (Bounce 2 без чёрных углов)
      14, 89, 348,
    ]);
    const counts = [0, 0, 0, 0, 0, 0];
    for (const p of products) counts[Math.min(1 + (p.images || []).length, 5)]++;
    const with4 = counts[4] + counts[5];
    assert.ok(with4 / products.length >= 0.8, `gallery coverage >=80%: ${with4}/${products.length}`);
    assert.equal(counts[0], 0, 'no photo-less products');
    for (const p of products) {
      const n = 1 + (p.images || []).length;
      if (n < 4) assert.ok(FEWER_THAN_4_OK.has(p.id), `Product #${p.id} has only ${n} photos without documented exception`);
    }
    g.openProduct(1);
    let detailHtml = g.document.getElementById('product-detail-box').innerHTML;
    assert.match(detailHtml, /id="product-main-img"/, 'PDP must render #product-main-img');
    assert.equal((detailHtml.match(/id="product-main-img"/g) || []).length, 1, 'PDP has exactly one main photo');
    assert.ok(!detailHtml.includes('switchProductGalleryPhoto'), 'PDP must not render fake multi-angle switcher');
    assert.ok(!detailHtml.includes('product-3d-stage'), 'PDP must not render SVG 3D stage');
    assert.ok(!detailHtml.includes('renderModelStudioSVG'), 'PDP must not embed drawn renders');
    assert.match(detailHtml, /По коду WATCH10:/, 'PDP must render 585 Золотой club price box');
    g.setProductJsonLd(null);

    // PDP товара с галереей: миниатюры переключают главное фото, все кадры локальные
    const withGallery = products.find((p) => (p.images || []).length > 0);
    assert.ok(withGallery, 'catalog has products with real multi-angle gallery');
    g.openProduct(withGallery.id);
    detailHtml = g.document.getElementById('product-detail-box').innerHTML;
    assert.ok(detailHtml.includes('pdp-th0'), 'PDP gallery renders thumbnails');
    const mainBefore = detailHtml.match(/id="product-main-img" src="([^"]+)"/);
    assert.ok(mainBefore, 'main photo has src');
    g.setPdpPhoto(1);
    const detailAfter = g.document.getElementById('product-detail-box').innerHTML;
    void detailAfter;
    const mainEl = g.document.getElementById('product-main-img');
    assert.ok(mainEl && mainEl.src !== mainBefore[1], 'thumbnail switches main photo');
    assert.match(String(mainEl.src), /^uploads\/catalog\/(wch-|grm-|apl-|descent-|edge-|garmin-|hrm-|coros-)/, 'gallery photo is local official shot');
    g.setProductJsonLd(null);
  });
});
