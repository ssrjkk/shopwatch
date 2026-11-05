const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { mountFrontend } = require('./helpers/dom');

describe('catalog virtualization', () => {
  let g;

  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 50));
  });

  function seed350() {
    g.state.products = Array.from({ length: 350 }, (_, i) => ({
      id: 1000 + i, brand: i % 2 ? 'GARMIN' : 'APPLE', series: i % 2 ? 'fēnix' : 'Apple Watch',
      category: 'Спортивные часы', name: 'Watch ' + i, price: 10000 + i, image: 'x.jpg', specs: 's',
    }));
    g.document.getElementById('search-input').value = '';
    g.renderCatalog();
  }

  const domCards = () => g.document.getElementById('products-grid').children.length;
  const scrollTop = (px) => { g.window.scrollY = px; g.renderWindow(); };

  it('пагинация по умолчанию: 10 позиций, шаг 10, кнопка «Показать ещё»', () => {
    g.setPageSize(10);
    seed350();
    assert.equal(g.state.pageSize, 10);
    assert.equal(g.state.shownMax, 10);
    assert.equal(domCards(), 10, 'первый чанк — 10 позиций');
    assert.equal(g.document.getElementById('grid-shown').textContent, '10');
    assert.equal(g.document.getElementById('grid-total').textContent, '350');
    assert.equal(g.document.getElementById('grid-status').textContent, 'Показано 1–10 из 350 — листайте вниз или нажмите «Показать ещё»');
    assert.equal(g.document.getElementById('found-count').textContent, 'Найдено: 350');
    assert.equal(g.state.windowTo, 10);
  });

  it('«Показать ещё» добавляет шаг и не скроллит страницу', () => {
    g.setPageSize(10);
    seed350();
    g.window.scrollY = 5000;
    g.showMore();
    assert.equal(domCards(), 20, 'стало 20 позиций');
    assert.equal(g.state.shownMax, 20);
    assert.equal(g.window.scrollY, 5000, 'скролл не тронут');
    assert.equal(g.document.getElementById('grid-status').textContent, 'Показано 1–20 из 350 — листайте вниз или нажмите «Показать ещё»');
    g.window.scrollY = 0;
  });

  it('шаг 10/20/30/40/50/100 переключается, мусор отбрасывается в 10', () => {
    seed350();
    for (const step of [20, 30, 40, 50, 100]) {
      g.setPageSize(String(step));
      assert.equal(g.state.pageSize, step);
      assert.equal(domCards(), step <= 60 ? step : g.WINDOW_CARDS, 'при шаге ' + step);
    }
    g.setPageSize('zzz');
    assert.equal(g.state.pageSize, 10);
    g.setPageSize(10);
  });

  it('виртуализация держит в DOM не больше WINDOW_CARDS при большом лимите', () => {
    g.setPageSize(100);
    seed350();
    assert.ok(domCards() <= g.WINDOW_CARDS, 'в DOM не больше окна: ' + domCards());
    g.showMore(); g.showMore(); g.showMore();
    assert.ok(domCards() <= g.WINDOW_CARDS, 'после догрузки в DOM не больше окна');
    assert.equal(g.state.shownMax, 350);
    assert.equal(g.document.getElementById('grid-status').textContent, 'Показаны все 350');
    assert.equal(g.document.getElementById('show-more-btn').classList.contains('hidden'), true, 'кнопка прячется в конце');
    // Избранное тоже виртуализируется через WINDOW_CARDS и не перестраивает DOM впустую на скролле
    g.state.favorites = g.state.products.slice(0, 120).map((x) => x.id);
    g.renderFavorites();
    const favDom = g.document.getElementById('favorites-grid').children.length;
    assert.ok(favDom <= g.WINDOW_CARDS, 'в избранном в DOM не больше окна: ' + favDom);
    const prevHtml = g.document.getElementById('favorites-grid').innerHTML;
    g.renderFavorites();
    assert.equal(g.document.getElementById('favorites-grid').innerHTML, prevHtml, 'повторный рендер избранного на том же скролле сохраняет окно');
    g.state.favorites = [];
    g.setPageSize(10);
  });

  it('короткий список и смена фильтра сбрасывают лимит к шагу', () => {
    g.setPageSize(10);
    g.state.products = Array.from({ length: 12 }, (_, i) => ({ id: 2000 + i, brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Tiny ' + i, price: 5000 + i, image: 'x.jpg', specs: 's' }));
    g.document.getElementById('search-input').value = '';
    g.renderCatalog();
    assert.equal(domCards(), 10, 'из 12 показано 10');
    assert.equal(g.document.getElementById('grid-status').textContent, 'Показано 1–10 из 12 — листайте вниз или нажмите «Показать ещё»');
    g.showMore();
    assert.equal(domCards(), 12, 'догрузили остаток');
    assert.equal(g.document.getElementById('grid-status').textContent, 'Показаны все 12');
    g.setPageSize(10);
    seed350();
    g.showMore();
    assert.equal(g.state.shownMax, 20);
    g.document.getElementById('search-input').value = 'garmin';
    g.renderCatalog();
    assert.equal(g.state.shownMax, 10, 'фильтр сбрасывает лимит к шагу');
    assert.equal(domCards(), 10);
    g.document.getElementById('search-input').value = '';
    g.renderCatalog();
  });

  it('escapes HTML in product fields (stored XSS protection)', () => {
    g.state.products = [{ id: 7, brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: '<img src=x onerror=alert(1)>', price: 100, image: '" onerror=alert(2)', specs: '<script>alert(3)</script>' }];
    g.document.getElementById('search-input').value = '';
    g.renderCatalog();
    const html = g.document.getElementById('products-grid').innerHTML;
    assert.ok(!html.includes('<img src=x'), 'сырой тег не попал в разметку');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'имя экранировано');
    assert.ok(html.includes('src="&quot; onerror=alert(2)"') || !html.includes('" onerror=alert(2)"'), 'атрибут src экранирован');
    assert.equal(g.esc('<a href="x">&\'"'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&quot;');
  });

  it('favorite toggle does not re-render the grid', () => {
    seed350();
    const visible = g.state.filtered[0].id;
    const beforeHtml = g.document.getElementById('products-grid').innerHTML;
    g.toggleFav({ stopPropagation() {} }, visible);
    assert.ok(g.state.favorites.includes(visible));
    assert.equal(g.document.getElementById('products-grid').innerHTML, beforeHtml);
    assert.ok(g.hearts.get(visible).every((h) => h.classList.contains('text-red-500')));
    g.toggleFav({ stopPropagation() {} }, visible);
    assert.ok(!g.state.favorites.includes(visible));
  });

  it('deep link points to the bot with order and cart payload', () => {
    const items = [{ id: 15, qty: 2, price: 25900 }, { id: 3, qty: 1, price: 10000 }];
    assert.equal(g.tgOrderLink('TG-1176', items), 'https://t.me/wwwatchshop_bot?start=TG-1176_15x2x25900_3x1x10000');
    assert.equal(g.tgOrderLink('consult'), 'https://t.me/wwwatchshop_bot');
    // без настроенного бота ссылка уводит в контакты, а не в пустоту
    const saved = g.state.settings.tg_link;
    g.state.settings = { ...g.state.settings, tg_link: '' };
    assert.equal(g.tgOrderLink('TG-1176', items), '#contacts?start=TG-1176_15x2x25900_3x1x10000');
    assert.equal(g.tgOrderLink('consult'), '#contacts');
    g.state.settings = { ...g.state.settings, tg_link: saved };
  });

  it('hits section renders flagged products', () => {
    seed350();
    g.state.products.forEach((p, i) => { p.hit = i < 3 ? 1 : 0; });
    g.renderHits();
    assert.ok(g.document.getElementById('hits-grid').innerHTML.includes('Watch 0'));
  });

  it('cart add / qty / remove updates count and total', () => {
    seed350();
    g.state.cart = [];
    g.addToCart(null, 1000);
    g.addToCart(null, 1000);
    g.addToCart(null, 1001);
    assert.equal(g.cartCount(), 3);
    assert.equal(g.cartTotal(), 10000 * 2 + 10001);
    g.changeQty(1000, -1);
    assert.equal(g.cartCount(), 2);
    g.removeFromCart(1001);
    assert.equal(g.cartCount(), 1);
    assert.equal(g.cartTotal(), 10000);
    assert.equal(g.document.getElementById('cart-badge').textContent, 1);
  });

  it('submitOrder validates the form', async () => {
    seed350();
    g.state.cart = [];
    g.addToCart(null, 1000);
    g.document.getElementById('view-order-success').classList.add('hidden');
    g.document.getElementById('f-fio').value = '';
    g.document.getElementById('f-phone').value = '';
    await g.submitOrder();
    assert.equal(g.state.cart.length, 1);
    assert.ok(g.document.getElementById('view-order-success').classList.contains('hidden'));
  });

  it('hash routes drive navigation and filters', () => {
    seed350();
    g.state.products.forEach((p, i) => { if (i < 5) p.category = 'Эхолоты'; });
    global.location.hash = '#/c/' + encodeURIComponent('Эхолоты');
    g.route();
    assert.equal(g.state.activeCategory, 'Эхолоты');
    assert.equal(g.document.getElementById('found-count').textContent, 'Найдено: 5');
    assert.ok(!g.document.getElementById('view-catalog').classList.contains('hidden'));
    global.location.hash = '#/p/1001';
    g.route();
    assert.ok(!g.document.getElementById('view-product').classList.contains('hidden'));
    assert.ok(g.document.getElementById('order-code-badge') !== undefined);
    global.location.hash = '#/cart';
    g.route();
    assert.ok(!g.document.getElementById('view-cart').classList.contains('hidden'));
    global.location.hash = '';
  });

  it('cards and pills render real hyperlinks', () => {
    seed350();
    g.state.activeCategory = 'Все товары';
    g.state.activeSeries = 'Все модели';
    g.renderCatalog();
    const gridHtml = g.document.getElementById('products-grid').innerHTML;
    assert.ok(gridHtml.includes(`href="#/p/${g.state.filtered[0].id}"`), 'product link present');
    g.renderFilters();
    const pillsHtml = g.document.getElementById('category-pills').innerHTML;
    assert.ok(pillsHtml.includes('href="#/c/'), 'category links present');
    assert.ok(pillsHtml.includes('href="#/c/sport-watches"'), 'category slug in English');
    for (const m of pillsHtml.matchAll(/href="([^"]+)"/g)) {
      assert.ok(!/[\u0400-\u04FF]|%D0|%D1/i.test(m[1]), `no cyrillic in category link: ${m[1]}`);
    }
  });

  it('checkout shows review and completes the order', async () => {
    seed350();
    g.state.cart = [];
    g.addToCart(null, 1000);
    g.addToCart(null, 1001);
    g.switchTab('checkout');
    assert.ok(g.document.getElementById('checkout-list').innerHTML.includes('Watch 0'));
    assert.ok(g.document.getElementById('checkout-total').textContent.includes('20'));
    g.document.getElementById('view-order-success').classList.add('hidden');
    g.document.getElementById('f-fio').value = 'Иван Тестов';
    g.document.getElementById('f-phone').value = '+7 900 000-00-00';
    g.document.getElementById('f-delivery').value = 'СДЭК';
    await g.submitOrder();
    assert.equal(g.state.cart.length, 0);
    assert.match(g.document.getElementById('order-code-badge').textContent, /^TG-\d+$/);
    assert.ok(!g.document.getElementById('view-order-success').classList.contains('hidden'));
    assert.match(g.document.getElementById('order-tg-btn').href, /start=TG-\d+_1000x1x10000_1001x1x10001/);
  });
});
