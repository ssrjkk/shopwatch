const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { extractFrontendScript } = require('./helpers/load');

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
};
global.IntersectionObserver = global.window.IntersectionObserver;
global.localStorage = { getItem: () => '[]', setItem: () => {} };
global.fetch = async () => ({ ok: false });
`;
    g = eval(`(function(){ ${prelude}\n${extractFrontendScript()}\n;return { get state() { return state; }, renderCatalog, toggleFav, get document() { return document; }, hearts }; })()`);
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
});
