const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mountFrontend, withIds } = require('./helpers/dom');

const SEED = withIds(require(path.join(__dirname, '..', 'public', 'products-data.js')));
const TOTAL = SEED.length;
const countBy = (fn) => SEED.filter(fn).length;
const prices = (rows) => rows.map((p) => Number(p.price));

describe('витрина: поиск, фильтры и оформление на статическом хостинге', () => {
  let g;

  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 50));
  });

  function search(q) {
    g.document.getElementById('search-input').value = q;
    g.renderCatalog();
    return g.state.filtered.slice();
  }

  it('в каталоге столько позиций, сколько в файле-источнике', () => {
    assert.equal(g.state.products.length, TOTAL);
    assert.equal(search('').length, TOTAL);
  });

  it('при нуле результатов счётчик не показывает цифры прошлого запроса', () => {
    search('Fenix 8');
    assert.ok(g.document.getElementById('found-count').textContent !== 'Найдено: 0');
    search('ывапролджее');
    assert.equal(g.document.getElementById('found-count').textContent, 'Найдено: 0');
    assert.match(g.document.getElementById('grid-status').textContent, /Ничего не найдено/);
    assert.equal(g.document.getElementById('products-grid').innerHTML, '');
    assert.equal(g.document.getElementById('grid-reset').classList.contains('hidden'), false, 'кнопка сброса видна');
    g.resetSearch();
    assert.equal(g.document.getElementById('found-count').textContent, `Найдено: ${TOTAL}`);
    assert.equal(g.document.getElementById('grid-reset').classList.contains('hidden'), true, 'кнопка сброса скрыта');
  });

  it('ищет по названию, бренду, серии, категории и характеристикам', () => {
    assert.equal(search('эхолот').length, countBy((p) => p.category === 'Эхолоты'));
    assert.ok(search('чехол').length > 0);
    assert.ok(search('CHIRP').length > 0, 'поиск по тексту характеристик');
    assert.ok(search('Garmin Edge 840').length > 0);
  });

  it('понимает транслит и разные падежи', () => {
    const garmin = countBy((p) => p.brand === 'GARMIN');
    assert.ok(garmin > 100);
    assert.equal(search('гармин').length, garmin);
    assert.ok(search('феникс').length > 0, 'феникс -> fēnix');
    assert.ok(search('самсунг').length > 0, 'самсунг -> samsung');
    const beg = search('бега');
    assert.ok(beg.length > 0, 'бега -> бег из описания категории');
    assert.equal(search('для бега').length, beg.length, 'предлог не ломает запрос');
    assert.equal(search('купить эхолот').length, search('эхолот').length, 'пустые слова игнорируются');
    assert.ok(search('смарт').length > 0, 'смарт-часы ищутся');
    assert.ok(search('смарт часы').length > 0);
    assert.ok(search('подводная охота').length > 0, 'дайверские запросы');
  });

  it('фильтрует по цене', () => {
    const cheap = search('до 60000');
    assert.ok(cheap.length > 0 && cheap.length < TOTAL);
    assert.equal(cheap.length, countBy((p) => p.price <= 60000), '«до» не ищется как слово в описаниях');
    const mid = search('40000-50000');
    assert.ok(mid.length > 0);
    assert.equal(mid.length, countBy((p) => p.price >= 40000 && p.price <= 50000));
    const from = search('от 200000');
    assert.ok(from.length > 0);
    assert.equal(from.length, countBy((p) => p.price >= 200000));
    const combo = search('эхолот до 30000');
    assert.equal(combo.length, countBy((p) => p.category === 'Эхолоты' && p.price <= 30000));
    const grouped = search('60 000');
    assert.ok(grouped.length > 0, 'цена с пробелом разбирается');
    assert.equal(grouped.length, countBy((p) => p.price >= 57000 && p.price <= 63000), 'голое число = цена ±5%');
    const exact = search('215000');
    assert.ok(exact.length > 0, 'голое число понимается как цена');
    assert.ok(prices(exact).every((x) => x >= 215000 * 0.95 && x <= 215000 * 1.05));
    assert.ok(search('edge 1040').length > 0, 'номер модели остаётся текстовым запросом');
    assert.ok(search('edge 1040').every((p) => /edge/i.test(p.name + ' ' + p.specs)));
  });

  it('нормализует пробелы и регистр', () => {
    assert.equal(search('Fenix 8').length, search('fenix   8').length);
    assert.equal(search('ФЕНИКС').length, search('феникс').length);
  });

  it('популярные сортируются по хитам, в том числе с флагом is_hit из БД', () => {
    const hits = countBy((p) => p.hit);
    assert.ok(hits > 0);
    g.document.getElementById('sort-select').value = 'popular';
    const first = search('')[0];
    assert.equal(g.isHit(first), true, 'первым идёт хит');
    g.state.products = [
      { id: 1, brand: 'B', series: 'S', category: 'Аксессуары', name: 'Обычный', price: 100, specs: '' },
      { id: 2, brand: 'A', series: 'S', category: 'Аксессуары', name: 'Хит из базы', price: 200, specs: '', is_hit: 1 },
    ];
    search('');
    assert.equal(g.state.filtered[0].name, 'Хит из базы');
    g.renderHits();
    assert.match(g.document.getElementById('hits-grid').innerHTML, /Хит из базы/);
    g.state.products = SEED.map((p) => ({ ...p }));
    search('');
  });

  it('ввод в поиске с другой страницы переключает каталог и пишет запрос в hash', () => {
    g.switchTab('contacts');
    assert.equal(g.state.currentView, 'contacts');
    g.document.getElementById('search-input').value = 'эхолот';
    g.onSearchInput();
    assert.equal(g.state.currentView, 'catalog', 'поиск сам открывает каталог');
    g.renderSuggestionsNow();
    assert.equal(decodeURIComponent(global.location.hash), '#/catalog?q=эхолот');
    assert.ok(g.state.filtered.length > 0);
  });

  it('hash-маршрут переносит запрос в поле и обратно', () => {
    global.location.hash = '#/catalog?q=' + encodeURIComponent('эхолот');
    g.route();
    assert.equal(g.document.getElementById('search-input').value, 'эхолот');
    assert.equal(g.state.filtered.length, countBy((p) => p.category === 'Эхолоты'));
    g.syncCatalogHash();
    assert.equal(decodeURIComponent(global.location.hash), '#/catalog?q=эхолот');
  });

  it('клик по категории сбрасывает висящий запрос вместо пустой сетки', () => {
    g.document.getElementById('search-input').value = 'триатлон';
    g.renderCatalog();
    assert.ok(g.state.filtered.length > 0);
    global.location.hash = '#/c/' + encodeURIComponent('Спортивные часы');
    g.route();
    assert.equal(g.document.getElementById('search-input').value, '', 'запрос сброшен');
    assert.equal(g.state.filtered.length, countBy((p) => p.category === 'Спортивные часы'));
  });

  it('«Каталог», логотип и «Все товары» возвращают полный каталог', () => {
    global.location.hash = '#/c/' + encodeURIComponent('Эхолоты');
    g.route();
    assert.equal(g.state.activeCategory, 'Эхолоты');
    global.location.hash = '#/catalog';
    g.route();
    assert.equal(g.state.activeCategory, 'Все товары');
    assert.equal(g.state.activeSeries, 'Все модели');
    assert.equal(g.state.filtered.length, TOTAL);
    global.location.hash = '#/s/' + encodeURIComponent('fēnix');
    g.route();
    assert.equal(g.state.activeSeries, 'fēnix');
    g.goAllProducts();
    assert.equal(g.state.activeSeries, 'Все модели');
    assert.equal(g.state.filtered.length, TOTAL);
    g.document.getElementById('search-input').value = 'эхолот';
    g.onSearchInput();
    g.goCatalogHome();
    assert.equal(g.document.getElementById('search-input').value, '');
    assert.equal(g.state.filtered.length, TOTAL);
  });

  it('ссылка «назад в каталог» ведёт туда, откуда пришёл покупатель', () => {
    global.location.hash = '#/c/' + encodeURIComponent('Эхолоты');
    g.route();
    const anyEcholot = g.state.filtered[0];
    global.location.hash = '#/p/' + anyEcholot.id;
    g.route();
    assert.equal(g.state.currentView, 'product');
    assert.equal(g.document.getElementById('product-back-link').href, '#/c/' + encodeURIComponent('Эхолоты'));
  });

  it('заказ на GitHub Pages доходит до success и deep link, без обращения к API', async () => {
    let calls = 0;
    const pages = mountFrontend({
      location: { hostname: 'ssrjkk.github.io', protocol: 'https:' },
      fetch: 'async () => { (global.__calls = (global.__calls || 0) + 1); return { ok: true, json: async () => ({}) }; }',
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pages.IS_STATIC_DEMO, true);
    calls = global.__calls || 0;
    assert.equal(calls, 0, '/api/state на статическом хостинге не зовём');
    pages.state.cart = [];
    pages.addToCart(null, pages.state.products[0].id);
    pages.addToCart(null, pages.state.products[1].id);
    pages.document.getElementById('f-fio').value = 'Иван Тестов';
    pages.document.getElementById('f-phone').value = '+7 900 000-00-00';
    pages.document.getElementById('f-delivery').value = 'СДЭК';
    await pages.submitOrder();
    assert.equal(pages.state.cart.length, 0, 'корзина очищена');
    assert.match(pages.document.getElementById('order-code-badge').textContent, /^TG-\d+$/);
    assert.match(pages.document.getElementById('order-tg-btn').href, /\?start=TG-\d+_\d+x1x\d+_\d+x1x\d+$/);
    assert.equal(global.__calls || 0, 0, 'и /api/order тоже не зовём');
    assert.equal(pages.state.currentView, 'order-success');
  });

  it('если бэкенд не отвечает, витрина не показывает ошибку, а уходит в deep link', async () => {
    const broken = mountFrontend({ fetch: 'async () => ({ ok: false, status: 404, json: async () => ({}) })' });
    await new Promise((r) => setTimeout(r, 50));
    broken.state.cart = [];
    broken.addToCart(null, broken.state.products[3].id);
    broken.document.getElementById('f-fio').value = 'Пётр';
    broken.document.getElementById('f-phone').value = '+7 900 111-22-33';
    broken.document.getElementById('cart-error').classList.add('hidden');
    await broken.submitOrder();
    assert.match(broken.document.getElementById('order-code-badge').textContent, /^TG-\d+$/);
    assert.equal(broken.document.getElementById('cart-error').classList.contains('hidden'), true, 'ошибка не показана');
    assert.equal(broken.state.cart.length, 0);
  });

  it('бэкенд с настоящей ошибкой — её видим, заказ не притворяется принятым', async () => {
    const api = mountFrontend({ fetch: 'async () => ({ ok: false, status: 400, json: async () => ({ error: "Товар не найден" }) })' });
    await new Promise((r) => setTimeout(r, 50));
    api.state.cart = [];
    api.addToCart(null, api.state.products[0].id);
    api.document.getElementById('f-fio').value = 'Сидор';
    api.document.getElementById('f-phone').value = '+7 900 000-00-01';
    await api.submitOrder();
    assert.equal(api.document.getElementById('cart-error').classList.contains('hidden'), false);
    assert.match(api.document.getElementById('cart-error').textContent, /Товар не найден/);
    assert.equal(api.state.cart.length, 1, 'корзина не очищена');
  });

  it('быстрый заказ из корзины открывает бота с составом и не трогает API', () => {
    const pages = mountFrontend({ location: { hostname: 'ssrjkk.github.io', protocol: 'https:' } });
    pages.state.cart = [];
    pages.addToCart(null, pages.state.products[5].id);
    pages.addToCart(null, pages.state.products[5].id);
    pages.quickOrder();
    assert.match(pages.document.getElementById('order-tg-btn').href, new RegExp('\\?start=TG-\\d+_' + pages.state.products[5].id + 'x2x\\d+$'));
    assert.equal(pages.state.cart.length, 1, 'быстрый заказ корзину не чистит — это переход в чат');
    assert.equal(pages.state.currentView, 'order-success');
  });

  it('index.html и public/index.html не расходятся', () => {
    const fs = require('fs');
    const a = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.equal(a, b, 'копии витрины различаются — обновите public/index.html');
    const d1 = fs.readFileSync(path.join(__dirname, '..', 'products-data.js'), 'utf8');
    const d2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'products-data.js'), 'utf8');
    assert.equal(d1, d2, 'копии каталога различаются');
  });
});
