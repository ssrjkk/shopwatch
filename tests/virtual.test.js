const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractFrontendScript } = require('./helpers/load');
const PD_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'products-data.js'), 'utf8');

describe('catalog virtualization', () => {
  let g;

  before(async () => {
    const prelude = `
const hearts = new Map();
function makeClassList() {
  const s = new Set();
  return { toggle: (c, f) => { if (f) s.add(c); else s.delete(c); }, add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
}
function indexHearts(html) {
  for (const m of html.matchAll(/data-fav-heart="(\\d+)"/g)) {
    const id = Number(m[1]);
    if (!hearts.has(id)) hearts.set(id, []);
    hearts.get(id).push({ classList: makeClassList() });
  }
}
const elements = {};
function mkEl(id) {
  return {
    _html: '', textContent: '', href: '',
    value: id === 'sort-select' ? 'popular' : '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (id === 'products-grid') { hearts.clear(); indexHearts(v); } },
    insertAdjacentHTML(pos, html) { this._html += html; if (id === 'products-grid') indexHearts(html); },
    classList: makeClassList(),
    getBoundingClientRect: () => ({ top: 10000 }),
  };
}
global.document = {
  getElementById: (id) => (elements[id] || (elements[id] = mkEl(id))),
  querySelectorAll: (sel) => {
    const m = sel.match(/data-fav-heart="(\\d+)"/);
    return m ? (hearts.get(Number(m[1])) || []) : [];
  },
};
global.window = {
  innerHeight: 800, scrollTo: () => {}, requestAnimationFrame: (fn) => fn(),
  IntersectionObserver: class { constructor(cb) { this.cb = cb; global.__obs = this; } observe() {} disconnect() {} },
  onhashchange: null,
};
global.location = { hash: '', reload() {}, };
global.IntersectionObserver = global.window.IntersectionObserver;
global.localStorage = { getItem: () => '[]', setItem: () => {} };
global.fetch = async () => ({ ok: false });
`;
    g = eval(`(function(){ ${prelude}\n${PD_SRC}\n${extractFrontendScript()}\n;return { get state() { return state; }, renderCatalog, renderHits, toggleFav, openProduct, tgOrderLink, addToCart, changeQty, removeFromCart, cartCount, cartTotal, renderCart, renderCheckout, goCheckout, switchTab, showView, route, toggleDrawer, submitOrder, renderFilters, setCategory, setSeries, get document() { return document; }, hearts, esc }; })()`);
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

  it('renders the first chunk only and shows progress', () => {
    seed350();
    assert.equal(g.state.shownCount, 20);
    assert.equal(g.document.getElementById('found-count').textContent, 'Найдено: 350');
    assert.ok(g.document.getElementById('grid-status').textContent.includes('Показано 20 из 350'));
  });

  it('loads more chunks on scroll until everything is shown', () => {
    seed350();
    global.__obs.cb([{ isIntersecting: true }]);
    assert.equal(g.state.shownCount, 40);
    for (let k = 0; k < 20; k++) global.__obs.cb([{ isIntersecting: true }]);
    assert.equal(g.state.shownCount, 350);
    assert.equal(g.document.getElementById('grid-status').textContent, 'Показаны все 350');
  });

  it('search resets to the first chunk of the filtered list', () => {
    seed350();
    g.document.getElementById('search-input').value = 'garmin';
    g.renderCatalog();
    assert.equal(g.state.filtered.length, 175);
    assert.equal(g.state.shownCount, 20);
    g.document.getElementById('search-input').value = '';
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
    const beforeHtml = g.document.getElementById('products-grid').innerHTML;
    g.toggleFav({ stopPropagation() {} }, 1000);
    assert.ok(g.state.favorites.includes(1000));
    assert.equal(g.document.getElementById('products-grid').innerHTML, beforeHtml);
    assert.ok(g.hearts.get(1000).every((h) => h.classList.contains('text-red-500')));
    g.toggleFav({ stopPropagation() {} }, 1000);
    assert.ok(!g.state.favorites.includes(1000));
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
    assert.ok(gridHtml.includes('href="#/p/1000"'), 'product link present');
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
