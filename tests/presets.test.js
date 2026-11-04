const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { mountFrontend } = require('./helpers/dom');

const PERSISTENT = "{ getItem: (k) => (globalThis.__pstore.has(k) ? globalThis.__pstore.get(k) : null), setItem: (k, v) => globalThis.__pstore.set(k, String(v)) }";

describe('подбор по пресетам и цене, лайтбокс, просмотренное, schema.org', () => {
  let g;

  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 50));
  });

  const setField = (id, v) => { g.document.getElementById(id).value = v; };
  const getField = (id) => String(g.document.getElementById(id).value);

  it('счётчик на пилюле «Хиты» равен числу позиций в выдаче', () => {
    g.resetFilters();
    const declared = g.presetCount('hits');
    assert.ok(declared > 0, 'хиты в каталоге есть');
    g.applyPreset('hits');
    const list = g.getFiltered();
    assert.equal(list.length, declared, `${declared} на пилюле, ${list.length} в выдаче`);
    assert.ok(list.every((p) => Number(p.hit || p.is_hit) === 1), 'в выдаче только хиты');
    g.resetFilters();
  });

  it('границы пресета и поля цены пересекаются, а не перекрывают друг друга', () => {
    g.resetFilters();
    g.applyPreset('premium');
    assert.ok(g.getFiltered().every((p) => Number(p.price) >= 60000), 'премиум — от 60 000');
    setField('price-min', '');
    setField('price-max', '70000');
    g.applyPriceRange();
    const both = g.getFiltered();
    assert.ok(both.length > 0, 'вилка 60 000 — 70 000 не пустая');
    assert.ok(both.every((p) => Number(p.price) >= 60000 && Number(p.price) <= 70000), 'работают обе границы');
    g.setSearchQuery('до 65000');
    const txt = g.getFiltered();
    assert.ok(txt.every((p) => Number(p.price) >= 60000 && Number(p.price) <= 65000), 'текстовый потолок учтён вместе с пресетом');
    g.resetFilters();
  });

  it('перепутанный порядок границ читается как вилка', () => {
    g.resetFilters();
    setField('price-min', '70000');
    setField('price-max', '20000');
    const f = g.priceRangeFromInputs();
    assert.equal(f.min, 20000);
    assert.equal(f.max, 70000);
    assert.equal(String(g.priceRangeLabel(f)).replace(/[  \s]/g, ' '), '20 000 — 70 000 ₽');
    g.resetFilters();
  });

  it('число в запросе и потолок из поля не спорят: ±5% считается внутри диапазона', () => {
    g.resetFilters();
    setField('price-min', '');
    setField('price-max', '30000');
    g.setSearchQuery('60000');
    const list = g.getFiltered();
    assert.equal(list.length, 0, '60 000 ±5% не влезает в потолок 30 000 — пустая выдача честнее подмены');
    g.resetFilters();
  });

  it('выбранный подбор попадает в ссылку и восстанавливается из неё', () => {
    g.resetFilters();
    setField('price-min', '15000');
    g.applyPreset('premium');
    g.applyPriceRange();
    const hash = String(global.location.hash);
    assert.match(hash, /preset=premium/, hash);
    assert.match(hash, /min=15000/, hash);
    g.resetFilters();
    assert.equal(g.state.preset, '');
    assert.equal(getField('price-min'), '', 'сброс чистит поле цены');
    global.location.hash = hash;
    g.route();
    assert.equal(g.state.preset, 'premium', 'пресет приехал по ссылке');
    assert.equal(getField('price-min'), '15000', 'диапазон приехал по ссылке');
    assert.ok(g.getFiltered().every((p) => Number(p.price) >= 60000), 'восстановленный фильтр реально ограничивает выдачу');
    g.resetFilters();
    global.location.hash = '';
  });

  it('счётчик «Фильтры · N» видит пресет и цену', () => {
    g.resetFilters();
    assert.equal(g.activeFilterCount(), 0);
    g.applyPreset('hits');
    assert.equal(g.activeFilterCount(), 1);
    setField('price-max', '40000');
    g.applyPriceRange();
    assert.equal(g.activeFilterCount(), 2);
    assert.match(String(g.document.getElementById('filter-btn-label').textContent), /^Фильтры · 2$/);
    assert.match(String(g.document.getElementById('filter-summary').textContent), /Хиты/, 'в сводке фильтров назван пресет');
    g.resetFilters();
    assert.equal(g.activeFilterCount(), 0);
    setField('price-min', '');
    setField('price-max', '');
  });

  it('фото товара открывается крупно: в лайтбоксе — его же локальное фото', () => {
    g.resetFilters();
    const item = g.state.products.find((p) => String(p.image || '').startsWith('uploads/'));
    assert.ok(item, 'в каталоге есть позиция с локальным фото');
    g.openProduct(item.id);
    g.openLightbox();
    const box = g.document.getElementById('lightbox');
    const img = g.document.getElementById('lightbox-img');
    assert.equal(box.classList.contains('hidden'), false, 'оверлей показан');
    assert.ok(String(img.src).includes('uploads/'), 'в лайтбоксе — локальное фото, а не хотлинк');
    assert.ok(!/unsplash\.com|placeholder/.test(String(img.src)), 'в лайтбоксе нет чужих картинок');
    assert.ok(String(img.src).includes('uploads/catalog/'), 'локальное фото каталога в лайтбоксе');
    assert.ok(String(img.alt).includes(item.name), 'альт подписан названием товара');
    g.closeLightbox();
    assert.equal(box.classList.contains('hidden'), true, 'закрытие прячет оверлей');
  });

  it('ссылка вида javascript: в источник картинки не проходит', () => {
    assert.equal(g.safeImageSrc('javascript:alert(1)'), '');
    assert.equal(g.safeImageSrc('  JaVaScRiPt:alert(1)'), '');
    assert.equal(g.safeImageSrc('data:text/html,hello'), '');
    assert.equal(g.safeImageSrc('vbscript:msgbox(1)'), '');
    assert.match(g.safeImageSrc('/uploads/photo.jpg'), /uploads/);
    assert.match(g.safeImageSrc('https://images.unsplash.com/x'), /unsplash/);
  });

  it('недавно смотрели: без дублей, поднимается наверх и упирается в потолок', () => {
    g.clearRecentViewed();
    const ids = g.state.products.slice(0, 4).map((p) => p.id);
    g.recordRecent(ids[0]);
    g.recordRecent(ids[1]);
    g.recordRecent(ids[0]);
    g.recordRecent(ids[2]);
    assert.deepEqual(g.state.recent.map(Number), [ids[2], ids[0], ids[1]], 'повтор не дублирует, а поднимает');
    for (let i = 0; i < 40; i++) g.recordRecent(g.state.products[i % g.state.products.length].id);
    assert.equal(g.state.recent.length, g.RECENT_MAX, 'длина списка ограничена');
    assert.ok(g.recentItems().length <= 6, 'на витрине показывается не больше шести');
    g.renderCatalog();
    const sec = g.document.getElementById('recent-viewed-section');
    assert.equal(sec.classList.contains('hidden'), false, 'блок виден, когда есть что показать');
    const cards = (String(g.document.getElementById('recent-viewed-grid').innerHTML).match(/data-fav-heart="/g) || []).length;
    assert.ok(cards > 0 && cards <= 6, `карточек в блоке: ${cards}`);
    g.setSearchQuery('fenix');
    g.renderCatalog();
    assert.equal(sec.classList.contains('hidden'), true, 'при поиске личное уступает место выдаче');
    g.setSearchQuery('');
    g.clearRecentViewed();
    assert.equal(g.state.recent.length, 0);
    g.renderCatalog();
    assert.equal(sec.classList.contains('hidden'), true, 'после очистки блок прячется');
  });

  it('пересобранного каталога просмотренное не переживает: старый id — уже другой товар', async () => {
    globalThis.__pstore = new Map();
    const live = mountFrontend({ storage: PERSISTENT });
    const id = live.state.products[0].id;
    live.recordRecent(id);
    assert.equal(live.state.recent.length, 1);
    assert.equal(live.syncCatalogFp(), false, 'первый запуск отпечатка не имеет и ничего не сбрасывает');
    live.state.products = [...live.state.products, { id: 400001, brand: 'TEST', series: 'TestSeries', category: 'Спортивные часы', name: 'Test 1', price: 100, specs: '' }];
    assert.equal(live.syncCatalogFp(), true, 'изменившийся состав распознан');
    assert.equal(live.state.recent.length, 0, 'список сброшен вместе с корзиной и избранным');
    assert.deepEqual(JSON.parse(String(globalThis.__pstore.get('watchop_recent'))), [], 'и в хранилище тоже');
    globalThis.__pstore = undefined;
  });

  it('schema.org на странице товара собирается из реальных данных и не содержит availability', () => {
    g.resetFilters();
    const p = g.state.products.find((x) => Number(x.price) > 0 && String(x.name).length > 0);
    const ld = g.productJsonLd(p);
    assert.equal(ld['@context'], 'https://schema.org');
    assert.equal(ld['@type'], 'Product');
    assert.equal(ld.name, p.name);
    assert.equal(ld.brand.name, p.brand);
    assert.equal(ld.offers.price, Number(p.price), 'цена в разметке — та, что в каталоге');
    assert.equal(ld.offers.priceCurrency, 'RUB');
    assert.equal('availability' in ld, false, 'складских остатков в базе нет — не выдумываем их для поисковика');
    assert.match(String(ld.image), /^https:\/\//, 'image абсолютный, иначе Google его не примет');
    assert.match(String(ld.url), new RegExp('#/p/' + p.id + '$'), 'ссылка ведёт на этот товар');
  });

  it('название с тегом не может закрыть скрипт в JSON-LD', () => {
    const evil = { id: 42, name: '<img src=x onerror=alert(1)>', brand: 'B', category: 'Спортивные часы', price: 1000, specs: 'x', image: '/uploads/a.jpg' };
    g.openProduct(g.state.products[0].id);
    const el = g.document.getElementById('product-jsonld');
    el.textContent = '';
    g.setProductJsonLd(evil);
    const written = String(el.textContent);
    assert.equal(written.includes('<'), false, 'в тексте скрипта не остаётся ни одного <');
    assert.equal(written.includes('</script>'), false);
    assert.match(written, /\\u003c/, 'экранирование видно как \\u003c');
    const parsed = JSON.parse(written);
    assert.equal(parsed.name, evil.name, 'данные при этом читаются как есть');
    g.setProductJsonLd(null);
    assert.equal(String(el.textContent), '', 'уход с товара снимает разметку');
  });

  it('уход в каталог убирает schema прошлого товара, а не оставляет её висеть', () => {
    g.resetFilters();
    const a = g.state.products[0];
    g.openProduct(a.id);
    const el = g.document.getElementById('product-jsonld');
    assert.ok(String(el.textContent).includes(a.name), 'на карточке разметка есть');
    global.location.hash = '#/catalog';
    g.route();
    assert.equal(String(el.textContent), '', 'в каталоге чужой товар в разметке не висит');
    global.location.hash = '';
  });
});

describe('фильтры по бренду и характеристикам, сравнение', () => {
  let g;

  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 50));
  });

  const brandCount = (b) => g.state.products.filter((p) => p.brand === b).length;

  it('бренды берутся из каталога, а число на чипе равно выдаче', () => {
    g.resetFilters();
    g.renderFilters();
    const brands = g.allBrands().filter((b) => b !== 'ALL');
    assert.ok(brands.length > 1, 'брендов несколько');
    for (const b of brands) assert.ok(brandCount(b) > 0, `у бренда ${b} есть позиции`);
    const target = brands.slice().sort((a, b) => brandCount(b) - brandCount(a))[0];
    g.setBrandFilter(target);
    const list = g.getFiltered();
    assert.equal(list.length, brandCount(target), `чип обещает ${brandCount(target)}, выдача ${list.length}`);
    assert.ok(list.every((p) => p.brand === target), 'в выдаче только этот бренд');
    g.setBrandFilter('ALL');
    assert.equal(g.state.activeBrand, 'ALL', 'сброс снимает бренд');
    assert.equal(g.getFiltered().length, g.state.products.length, 'и выдача возвращается к полному каталогу');
  });

  it('метки характеристик существуют только если по ним есть позиции', () => {
    g.resetFilters();
    const counts = {};
    for (const k of ['amoled', 'solar', 'sapphire', 'titanium', 'size_s', 'size_m', 'size_l']) {
      g.toggleSpecFilter(k);
      counts[k] = g.getFiltered().length;
      g.toggleSpecFilter(k);
    }
    assert.ok(Object.values(counts).some((n) => n > 0), 'хотя бы одна метка что-то находит: ' + JSON.stringify(counts));
    for (const k of Object.keys(counts)) {
      if (!counts[k]) continue;
      g.toggleSpecFilter(k);
      assert.equal(g.getFiltered().length, counts[k], `метка ${k}: повторный замер совпадает`);
      assert.ok(g.state.activeSpecs.includes(k), 'метка отмечена активной');
      g.toggleSpecFilter(k);
    }
    assert.deepEqual(g.state.activeSpecs, []);
  });

  it('несколько меток — пересечение, а не объединение', () => {
    g.resetFilters();
    g.toggleSpecFilter('amoled');
    const amoled = g.getFiltered();
    assert.ok(amoled.length > 0, 'по amoled что-то есть');
    g.toggleSpecFilter('titanium');
    const both = g.getFiltered();
    assert.ok(both.length <= amoled.length, 'вторая метка сужает, а не расширяет');
    const brand = g.allBrands().find((b) => b !== 'ALL');
    g.setBrandFilter(brand);
    assert.ok(g.getFiltered().every((p) => p.brand === brand), 'бренд + метки работают вместе');
    g.resetFilters();
    assert.equal(g.activeFilterCount(), 0, 'сброс снимает и бренд, и метки');
  });

  it('бренд и метки доезжают по ссылке', () => {
    g.resetFilters();
    const brand = g.allBrands().find((b) => b !== 'ALL');
    g.setBrandFilter(brand);
    g.toggleSpecFilter('solar');
    const hash = String(global.location.hash);
    assert.ok(hash.includes('brand='), hash);
    assert.match(hash, /spec=solar/, hash);
    g.resetFilters();
    global.location.hash = hash;
    g.route();
    assert.equal(g.state.activeBrand, brand, 'бренд восстановлен из ссылки');
    assert.deepEqual(g.state.activeSpecs, ['solar'], 'метка восстановлена из ссылки');
    assert.ok(g.getFiltered().every((p) => p.brand === brand), 'и реально ограничивает выдачу');
    // мусорная метка в ссылке игнорируется, а не ломает фильтр
    global.location.hash = '#/catalog?spec=马戏团&brand=' + encodeURIComponent(brand);
    g.route();
    assert.deepEqual(g.state.activeSpecs, [], 'неизвестной метке в state не место');
    assert.equal(g.state.activeBrand, brand, 'бренд при этом применился');
    g.resetFilters();
    global.location.hash = '';
  });

  it('счётчик «Фильтры · N» и сводка видят бренд и метки', () => {
    g.resetFilters();
    const first = g.allBrands().find((b) => b !== 'ALL');
    g.setBrandFilter(first);
    g.toggleSpecFilter('solar');
    assert.equal(g.activeFilterCount(), 2);
    g.renderFilters();
    g.renderCatalog();
    const sum = String(g.document.getElementById('filter-summary').textContent);
    assert.match(sum, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'в сводке назван бренд');
    assert.match(String(g.document.getElementById('filter-btn-label').textContent), /^Фильтры · 2$/);
    g.resetFilters();
  });

  it('сравнение: потолок четыре, повтор убирает, панель показывает число', () => {
    g.resetFilters();
    g.clearCompare();
    const ids = g.state.products.slice(0, 6).map((p) => p.id);
    for (const id of ids) g.toggleCompare({ stopPropagation() {} }, id);
    assert.equal(g.state.compare.length, 4, 'в сравнении не больше четырёх');
    const first = g.state.compare[0];
    g.toggleCompare({ stopPropagation() {} }, first);
    assert.equal(g.state.compare.includes(first), false, 'повторное нажатие убирает');
    assert.equal(g.state.compare.length, 3);
    assert.equal(String(g.document.getElementById('compare-count').textContent), '3', 'панель считает вслух');
    assert.equal(g.document.getElementById('compare-bar').classList.contains('hidden'), false, 'панель видна, когда есть что сравнивать');
  });

  it('таблица сравнения несёт реальные поля и экранирует название', () => {
    g.resetFilters();
    const picks = g.state.products.filter((p) => Number(p.price) > 0).slice(0, 3).map((p) => p.id);
    g.clearCompare();
    for (const id of picks) g.toggleCompare({ stopPropagation() {} }, id);
    g.openCompareModal();
    const box = String(g.document.getElementById('compare-table-box').innerHTML);
    for (const id of picks) {
      const p = g.state.products.find((x) => x.id === id);
      assert.ok(box.includes(p.name), 'название в таблице');
      assert.ok(box.includes('#/p/' + p.id), 'колонка ведёт на страницу товара');
      assert.ok(box.includes(Number(p.price).toLocaleString('ru-RU')), 'цена в таблице');
    }
    assert.ok(box.includes('<table'), 'это таблица, а не набор строк');
    const evil = { id: 4242, name: '<img src=x onerror=alert(1)>', brand: 'B', series: 'S', category: 'C', price: 1000, specs: 'x' };
    g.state.products = [...g.state.products, evil];
    g.state.compare = [evil.id];
    g.openCompareModal();
    const html2 = String(g.document.getElementById('compare-table-box').innerHTML);
    assert.equal(html2.includes('<img src=x'), false, 'название с тегом не попадает в разметку как тег');
    assert.ok(html2.includes('&lt;img'), html2.slice(0, 80));
    g.state.products = g.state.products.filter((p) => p.id !== evil.id);
    g.clearCompare();
    assert.equal(g.document.getElementById('compare-bar').classList.contains('hidden'), true, 'пустое сравнение прячет панель');
  });

  it('сравнение переживает перезагрузку и сбрасывается при пересборке каталога', () => {
    globalThis.__pstore = new Map();
    const live = mountFrontend({ storage: PERSISTENT });
    const id = live.state.products[1].id;
    live.toggleCompare({ stopPropagation() {} }, id);
    assert.deepEqual(JSON.parse(String(globalThis.__pstore.get('watchop_compare'))), [id], 'записано в хранилище');
    const reloaded = mountFrontend({ storage: PERSISTENT });
    assert.deepEqual(reloaded.state.compare.map(Number), [id], 'прочитано после перезагрузки');
    reloaded.syncCatalogFp();
    reloaded.state.products = [...reloaded.state.products, { id: 400002, brand: 'TEST', series: 'T', category: 'Спортивные часы', name: 'Test 2', price: 1500, specs: '' }];
    assert.equal(reloaded.syncCatalogFp(), true, 'пересборка распознана');
    assert.equal(reloaded.state.compare.length, 0, 'список сравнения сброшен вместе с остальными');
    globalThis.__pstore = undefined;
  });

  it('промокод: сумму считает сервер, витрина её только показывает', async () => {
    const srv = mountFrontend({ fetch: "async (url, opts) => ({ ok: true, json: async () => ({ code: 'WATCH10', percent: 10, subtotal: 100000, discount: 10000, total: 90000 }) })" });
    srv.state.cart = [{ id: srv.state.products[0].id, qty: 1 }];
    srv.document.getElementById('promo-input').value = 'watch10';
    await srv.applyPromoCode();
    assert.equal(srv.state.promoCode, 'WATCH10');
    assert.equal(srv.state.promoDiscountRub, 10000, 'скидку в рублях вернул сервер, витрина её только показывает');
    assert.match(srv.document.getElementById('promo-status').textContent.replace(/[\u0020\u00a0\u202f]/g, ' '), /10 000/);
    assert.equal(srv.document.getElementById('cart-discount-row').classList.contains('hidden'), false, 'строка скидки видна');
    srv.clearPromo();
    assert.equal(srv.state.promoCode, '', 'сброс чистит и код, и скидку');
    assert.equal(srv.state.promoDiscountRub, 0);
  });

  it('отклонённый промокод очищается и показывает ошибку', async () => {
    const rejected = mountFrontend({ fetch: "async () => ({ ok: false, status: 400, json: async () => ({ error: 'Промокод не найден или истёк' }) })" });
    rejected.state.cart = [{ id: rejected.state.products[0].id, qty: 1 }];
    rejected.document.getElementById('promo-input').value = 'NETAKOGO';
    await rejected.applyPromoCode();
    assert.equal(rejected.state.promoCode, '', 'отклонённый код не остаётся');
    assert.equal(rejected.state.promoDiscountRub, 0);
    assert.match(rejected.document.getElementById('promo-status').textContent, /не найден/);
  });

  it('на статической витрине промокод не выдумывает скидку, а уходит в deep link', () => {
    const pages = mountFrontend({ location: { hostname: 'ssrjkk.github.io', protocol: 'https:' }, fetch: "async () => ({ ok: false })" });
    assert.equal(pages.IS_STATIC_DEMO, true, 'хост *.github.io опознан как статический');
    pages.document.getElementById('promo-input').value = 'watch10';
    pages.applyPromoCode();
    assert.equal(pages.state.promoCode, 'WATCH10');
    assert.equal(pages.state.promoDiscountRub, 0, 'без сервера скидку не рисуем — посчитает сервер в боте');
    assert.match(pages.document.getElementById('promo-status').textContent, /сервер/i);
    assert.equal(pages.deepLinkPromo(), 'WATCH10');
    const link = pages.tgOrderLink('TG-1234', [{ id: 5, qty: 1, price: 1000 }]);
    assert.match(link, /\?start=TG-1234_5x1x1000_PROMOWATCH10$/, link);
    pages.clearPromo();
    assert.equal(pages.tgOrderLink('TG-1234', [{ id: 5, qty: 1, price: 1000 }]).includes('PROMO'), false, 'без кода в ссылке его нет');
    pages.clearPromo();
    assert.equal(pages.deepLinkPromo(), '', 'мусорный код в deep link не кладём');
  });
});
