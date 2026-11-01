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

  it('держит в DOM окно не больше WINDOW_CARDS карточек', () => {
    seed350();
    assert.ok(g.WINDOW_CARDS <= 60, `окно слишком большое: ${g.WINDOW_CARDS}`);
    // первый чанк — PAGE_SIZE, окно предзаявлено на WINDOW_CARDS
    assert.ok(domCards() <= g.WINDOW_CARDS, `карточек в DOM: ${domCards()}`);
    assert.equal(g.state.windowFrom, 0);
    assert.equal(g.state.windowTo, g.WINDOW_CARDS);
    assert.equal(g.document.getElementById('found-count').textContent, 'Найдено: 350');
    // прокрутка включает окно: в DOM только окно, хвост дописывается чанками
    scrollTop(20000);
    assert.ok(domCards() <= g.WINDOW_CARDS, `после прокрутки в DOM ${domCards()} карточек`);
    assert.equal(g.document.getElementById('found-count').textContent, 'Найдено: 350');
    assert.equal(g.document.getElementById('grid-top').style.height === '0px', g.state.windowFrom === 0);
    g.window.scrollY = 0;
    g.renderCatalog();
  });

  it('на любом глубине прокрутки карточек столько же, а не всё до этого места', () => {
    seed350();
    const heights = [];
    for (const px of [0, 1000, 5000, 12000, 20000, 40000]) {
      scrollTop(px);
      heights.push(domCards());
      assert.ok(domCards() <= g.WINDOW_CARDS, `на ${px}px в DOM ${domCards()} карточек`);
    }
    assert.deepEqual([...new Set(heights)], [g.WINDOW_CARDS]);
    // середина списка: окно пришло за серединой, а не упёрлось в край
    scrollTop(20000);
    assert.ok(g.state.windowFrom > 100 && g.state.windowFrom < 250, `окно началось с ${g.state.windowFrom}`);
    // конец списка: последние позиции на экране, нижняя заглушка нулевая
    scrollTop(99999);
    assert.equal(g.state.windowTo, 350);
    assert.equal(g.document.getElementById('grid-bottom').style.height, '0px');
    assert.equal(g.document.getElementById('grid-status').textContent, 'Показаны все 350');
    g.window.scrollY = 0;
  });

  it('избранное сидит в том же окне, что и каталог', () => {
    seed350();
    g.state.favorites = g.state.filtered.map((p) => p.id);
    g.window.scrollY = 0;
    g.renderFavorites();
    const fav = g.document.getElementById('favorites-grid');
    assert.equal(fav.children.length, g.WINDOW_CARDS, `в избранном отрисовано ${fav.children.length}`);
    assert.equal(g.document.getElementById('favorites-bottom').style.height !== '0px', true, 'нижняя заглушка держит высоту');
    g.window.scrollY = 30000;
    g.renderFavorites();
    assert.equal(fav.children.length, g.WINDOW_CARDS, 'после прокрутки карточек не больше');
    g.window.scrollY = 0;
    g.state.favorites = [];
    g.renderFavorites();
    assert.match(g.document.getElementById('favorites-grid').innerHTML, /В избранном пока пусто/);
    assert.equal(g.document.getElementById('favorites-bottom').style.height, '0px');
  });

  it('короткий список рендерится целиком, без заглушек', () => {
    g.state.products = Array.from({ length: 12 }, (_, i) => ({ id: 2000 + i, brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Tiny ' + i, price: 5000 + i, image: 'x.jpg', specs: 's' }));
    g.document.getElementById('search-input').value = '';
    g.renderCatalog();
    assert.equal(domCards(), 12);
    assert.equal(g.document.getElementById('grid-top').style.height || '0px', '0px');
    assert.equal(g.document.getElementById('grid-bottom').style.height || '0px', '0px');
    assert.equal(g.document.getElementById('grid-status').textContent, '');
  });

  it('после смены фильтра окно остаётся внутри нового списка и не пустует', () => {
    seed350();
    g.window.scrollY = 0;
    g.renderCatalog();
    assert.equal(g.state.windowFrom, 0, 'со верха страницы — с первой карточки');
    scrollTop(20000);
    const mid = g.state.windowFrom;
    assert.ok(mid > 0, 'после прокрутки окно ушло от начала');
    g.document.getElementById('search-input').value = 'garmin';
    g.window.scrollY = 0;
    g.renderCatalog();
    assert.equal(g.state.filtered.length, 175);
    const shown = domCards();
    assert.ok(shown > 0 && shown <= g.WINDOW_CARDS, `карточек в DOM: ${shown}`);
    assert.ok(g.state.windowTo <= 175 && g.state.windowFrom >= 0, `окно ${g.state.windowFrom}–${g.state.windowTo} вышло за 175`);
    assert.equal(g.state.windowFrom, 0, 'фильтр сбрасывает окно к началу');
    g.window.scrollY = 0;
    g.document.getElementById('search-input').value = '';
    g.renderCatalog();
    assert.equal(g.state.windowFrom, 0);
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
    assert.ok(pillsHtml.includes(encodeURIComponent('Спортивные часы')), 'cyrillic category encoded');
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
