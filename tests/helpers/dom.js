// Общий DOM-подобный harness для тестов витрины: вырезает inline-скрипт из
// public/index.html и исполняет его против фиктивных элементов, как virtual.test.js.
const fs = require('fs');
const path = require('path');
const { extractFrontendScript, ROOT } = require('./load');

function prelude(opts) {
  const loc = opts.location || {};
  const fetchImpl = opts.fetch || 'async () => ({ ok: false })';
  const storeImpl = opts.storage || '{ getItem: () => null, setItem: () => {} }';
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
// Карточка в сетке опознаётся по сердечку избранного: их ровно по одной на
// каждую отрисованную позицию. Так тест может считать реальный размер DOM,
// а не домысливать его.
function cardsIn(html) {
  const n = (String(html).match(/data-fav-heart="/g) || []).length;
  return Array.from({ length: n }, () => ({ offsetHeight: 230 }));
}
function mkEl(id) {
  const isGrid = id === 'products-grid' || id === 'favorites-grid';
  return {
    _html: '', textContent: '', href: '', style: {}, offsetHeight: 0, children: [],
    value: id === 'sort-select' ? 'popular' : '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (isGrid) { if (id === 'products-grid') hearts.clear(); indexHearts(v); this.children = cardsIn(v); } },
    insertAdjacentHTML(pos, html) { this._html += html; if (isGrid) { indexHearts(html); this.children = cardsIn(this._html); } },
    classList: makeClassList(),
    // rect.top во вьюпорте: документный верх сетки минус прокрутка страницы
    getBoundingClientRect: () => ({ top: (id === 'grid-window' ? 0 : 10000) - ((global.window && global.window.scrollY) || 0) }),
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
  innerHeight: 800, scrollY: 0, scrollTo: () => {}, requestAnimationFrame: (fn) => fn(),
  IntersectionObserver: class { constructor(cb) { this.cb = cb; global.__obs = this; } observe() {} disconnect() {} },
  onhashchange: null,
};
global.location = { hash: '', reload() {}, ${Object.entries(loc).map(([k, v]) => `${k}: ${JSON.stringify(v)},`).join(' ')} };
global.IntersectionObserver = global.window.IntersectionObserver;
global.requestAnimationFrame = (...a) => global.window.requestAnimationFrame(...a);
global.cancelAnimationFrame = () => {};
global.localStorage = ${storeImpl};
global.fetch = ${fetchImpl};
`;
}

const EXPOSE = [
  'state', 'renderCatalog', 'renderHits', 'toggleFav', 'openProduct', 'tgOrderLink', 'addToCart',
  'changeQty', 'removeFromCart', 'clearCart', 'sanitizeCart', 'cartCount', 'cartTotal', 'renderCart', 'renderCheckout', 'goCheckout',
  'switchTab', 'showView', 'route', 'toggleDrawer', 'submitOrder', 'renderFilters', 'setCategory', 'setSeries',
  'getFiltered', 'parseSearch', 'hayOf', 'isHit', 'tokenHit', 'onSearchInput', 'resetSearch', 'searchQuery',
  'setSearchQuery', 'syncCatalogHash', 'goAllProducts', 'goCatalogHome', 'quickOrder', 'fallbackCopy',
  'updateGridStatus', 'parseHash', 'searchSuggestions', 'renderSearchSuggestions', 'openSearchDropdown', 'selectSearchTag', 'onSearchKeyDown', 'clearSearchInput', 'scrollToCatalog', 'renderSuggestions', 'hideSuggestions', 'pickSuggest',
  'moveSuggest', 'onSearchFocus', 'onSearchKey', 'narrowSuggestions', 'paintSuggestions', 'toggleFilterSheet', 'closeFilterSheet', 'resetFilters',
  'updateFilterChrome', 'activeFilterCount', 'filterSheetOpen', 'toggleSupportMenu', 'updateToTop', 'resetAllFilters', 'setBrandFilter', 'toggleSpecFilter', 'copyPromoCode', 'openPromoModal', 'closePromoModal', 'openCallbackModal', 'closeCallbackModal', 'submitCallback',
  'readStore', 'rememberOrder', 'lastOrder', 'showOrderSuccess', 'applyOrderToDom', 'suggestionCount', 'invalidateSugCounts', 'applySettingsToUI',
  'scrollToGrid', 'buildSugMap', 'sugMap', 'renderSuggestionsNow', 'scheduleSuggestions', 'sortedSug', 'CAT_ORDER', 'CAT_KEYS', 'TRANSLIT', 'IS_STATIC_DEMO', 'esc',
  'catalogFp', 'syncCatalogFp',
  'oldPriceHTML', 'productCardHTML', 'safeCardHTML', 'gallerySrc', 'productGallery', 'productImages', 'setPdpPhoto', 'openLightboxAt', 'openLightboxPrev', 'openLightboxNext', 'localOrders', 'pushLocalOrder', 'renderOrders', 'imgSrc', 'imgUrl', 'renderWindow', 'scheduleWindow', 'WINDOW_CARDS', 'renderFavorites',
  'PRESETS', 'presetOf', 'presetBounds', 'presetCount', 'applyPreset', 'applyPriceRange', 'priceRangeFromInputs', 'priceRangeLabel',
  'effectivePriceRange', 'applyPickTo', 'renderPresets', 'openLightbox', 'closeLightbox', 'safeImageSrc', 'absoluteUrl',
  'SPEC_FACETS', 'facetOf', 'facetCount', 'specHit', 'allBrands', 'toggleBrand', 'toggleSpec', 'renderBrandPills', 'renderSpecPills',
  'COMPARE_MAX', 'toggleCompare', 'clearCompare', 'compareItems', 'inCompare', 'updateCompareBar', 'openCompareModal', 'closeCompareModal',
  'recordRecent', 'clearRecentViewed', 'recentItems', 'renderRecent', 'RECENT_MAX', 'productJsonLd', 'setProductJsonLd', 'updateSeoTitle', 'setDesignEdition', 'toggleDesignEdition', 'toggleTheme', 'computeBatteryLife', 'downloadCmsCatalog', 'applyHashFilters',
  'deepLinkPromo', 'promoInputValue', 'cartItemsForApi', 'applyPromoCode', 'clearPromo', 'renderPromoRow', 'renderDeliveryOptions', 'beaconCheckoutStarted', 'checkoutSid',
];

// Монтирует фронтенд. seed — источник данных каталога (по PRODUCTS_DATA можно подменить файл).
// Имена, которых нет в текущем дизайне, пропускаются: тесты, которым они нужны,
// падают явно в своём теле, а не роняют весь mount.
function mountFrontend(opts = {}) {
  const seedPath = opts.productsData || path.join(ROOT, 'public', 'products-data.js');
  const seedSrc = fs.readFileSync(seedPath, 'utf8');
  const want = EXPOSE.filter((n) => !/^(document|window|hearts)$/.test(n));
  const body = `(function(){ ${prelude(opts)}\n${seedSrc}\n${extractFrontendScript()}\n;const __out = { get document() { return document; }, get window() { return window; }, hearts };
  for (const __n of ${JSON.stringify(want)}) { try { const __v = eval(__n); if (__v !== undefined) __out[__n] = __v; } catch (e) {} }
  return __out; })()`;
  return eval(body);
}

// Подстраховка для старых срезов каталога: файл обязан нести id из базы (за этим
// следит тест в catalog-export.test.js), но если id нет — не даём harness'у undefined.
function withIds(rows) {
  return rows.map((p, i) => ({ ...p, id: Number(p.id) > 0 ? Number(p.id) : i + 1 }));
}

module.exports = { mountFrontend, withIds, prelude };
