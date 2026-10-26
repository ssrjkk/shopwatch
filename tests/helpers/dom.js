// Общий DOM-подобный harness для тестов витрины: вырезает inline-скрипт из
// public/index.html и исполняет его против фиктивных элементов, как virtual.test.js.
const fs = require('fs');
const path = require('path');
const { extractFrontendScript, ROOT } = require('./load');

function prelude(opts) {
  const loc = opts.location || {};
  const fetchImpl = opts.fetch || 'async () => ({ ok: false })';
  return `
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
global.location = { hash: '', reload() {}, ${Object.entries(loc).map(([k, v]) => `${k}: ${JSON.stringify(v)},`).join(' ')} };
global.IntersectionObserver = global.window.IntersectionObserver;
global.localStorage = { getItem: () => '[]', setItem: () => {} };
global.fetch = ${fetchImpl};
`;
}

const EXPOSE = [
  'state', 'renderCatalog', 'renderHits', 'toggleFav', 'openProduct', 'tgOrderLink', 'addToCart',
  'changeQty', 'removeFromCart', 'cartCount', 'cartTotal', 'renderCart', 'renderCheckout', 'goCheckout',
  'switchTab', 'showView', 'route', 'toggleDrawer', 'submitOrder', 'renderFilters', 'setCategory', 'setSeries',
  'getFiltered', 'parseSearch', 'hayOf', 'isHit', 'tokenHit', 'onSearchInput', 'resetSearch', 'searchQuery',
  'setSearchQuery', 'syncCatalogHash', 'goAllProducts', 'goCatalogHome', 'quickOrder', 'fallbackCopy',
  'updateGridStatus', 'parseHash', 'searchSuggestions', 'renderSuggestions', 'hideSuggestions', 'pickSuggest',
  'moveSuggest', 'onSearchFocus', 'onSearchKey', 'toggleFilterSheet', 'closeFilterSheet', 'resetFilters',
  'updateFilterChrome', 'activeFilterCount', 'filterSheetOpen', 'toggleSupportMenu', 'updateToTop', 'observeToTop',
  'scrollToGrid', 'buildSugMap', 'sugMap', 'CAT_ORDER', 'CAT_KEYS', 'TRANSLIT', 'IS_STATIC_DEMO', 'esc',
];

// Монтирует фронтенд. seed — источник данных каталога (по PRODUCTS_DATA можно подменить файл).
function mountFrontend(opts = {}) {
  const seedPath = opts.productsData || path.join(ROOT, 'public', 'products-data.js');
  const seedSrc = fs.readFileSync(seedPath, 'utf8');
  const body = `(function(){ ${prelude(opts)}\n${seedSrc}\n${extractFrontendScript()}\n;return { ${EXPOSE.filter(
    (n) => /^[A-Z_]+$/.test(n) ? `get ${n}(){ return ${n}; }` : n
  ).join(', ')}, get document() { return document; }, hearts }; })()`;
  return eval(body);
}

// Проставляет id позициям из seed-файла (в файле id нет — их назначает БД).
function withIds(rows) {
  return rows.map((p, i) => ({ ...p, id: Number(p.id) > 0 ? Number(p.id) : i + 1 }));
}

module.exports = { mountFrontend, withIds, prelude };
