const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mountFrontend } = require('./helpers/dom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SEED = require(path.join(__dirname, '..', 'public', 'products-data.js'));

describe('витрина: подсказки, шторка фильтров и плавающие кнопки', () => {
  let g;

  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 50));
  });

  function type(q) {
    g.document.getElementById('search-input').value = q;
    g.onSearchInput();
  }

  it('подсказки строятся из реального каталога и всегда что-то находят', () => {
    type('fenix');
    const list = g.state.suggest;
    assert.ok(list.length > 0 && list.length <= 6, `подсказок: ${list.length}`);
    for (const s of list) {
      assert.ok(s.count > 0);
      type(s.label);
      assert.ok(g.state.filtered.length > 0, `подсказка «${s.label}» ведёт к непустой выдаче`);
    }
    type('марк');
    assert.ok(g.state.suggest.length > 0, 'транслит работает и в подсказках');
    type('fenix');
    assert.ok(g.state.suggest[0].count >= g.state.suggest[g.state.suggest.length - 1].count, 'отсортировано по числу позиций');
  });

  it('дропдаун открывается, выбирается по тапу и закрывается по Escape', () => {
    const box = g.document.getElementById('search-suggest');
    assert.equal(box.classList.contains('hidden'), false, 'дропдаун виден при наборе');
    assert.match(box.innerHTML, /Показать все/);
    g.pickSuggest(0);
    assert.ok(g.searchQuery().length > 0, 'подсказка подставилась в поле');
    assert.equal(box.classList.contains('hidden'), true, 'после выбора дропдаун закрыт');
    assert.ok(g.state.filtered.length > 0);
    type('марк');
    assert.ok(g.state.suggest.length > 0, 'транслит даёт подсказки и по-русски');
    g.onSearchKey({ key: 'Escape' });
    assert.equal(g.document.getElementById('search-suggest').classList.contains('hidden'), true, 'первый Escape закрывает подсказки');
    assert.equal(g.searchQuery(), 'марк', 'первый Escape запрос не трогает');
    g.onSearchKey({ key: 'Escape' });
    assert.equal(g.searchQuery(), '', 'второй Escape чистит запрос');
  });

  it('на пустом поле показываются категории с настоящими счётчиками', () => {
    type('');
    const box = g.document.getElementById('search-suggest');
    const list = g.state.suggest;
    assert.ok(list.length >= 3);
    for (const s of list) {
      const real = SEED.filter((p) => p.category === s.label).length;
      assert.equal(s.count, real, `счётчик категории ${s.label}`);
    }
    assert.match(box.innerHTML, /Спортивные часы/);
  });

  it('шторка фильтров открывается, применяет и сбрасывает фильтры', () => {
    const sheet = g.document.getElementById('filter-sheet');
    const backdrop = g.document.getElementById('filter-backdrop');
    g.toggleFilterSheet();
    assert.equal(sheet.classList.contains('hidden'), false);
    assert.equal(backdrop.classList.contains('hidden'), false);
    assert.ok(g.document.getElementById('category-pills').innerHTML.includes('#/c/'), 'категории рендерятся внутри шторки');
    assert.ok(g.document.getElementById('series-pills').innerHTML.includes('#/s/'), 'серии рендерятся внутри шторки');
    g.closeFilterSheet();
    assert.equal(sheet.classList.contains('hidden'), true);
    assert.equal(backdrop.classList.contains('hidden'), true);

    global.location.hash = '#/c/' + encodeURIComponent('Эхолоты');
    g.route();
    assert.equal(g.document.getElementById('catalog-title').textContent, 'Эхолоты', 'заголовок = активный фильтр');
    assert.equal(g.document.getElementById('filter-btn-label').textContent, 'Фильтры · 1');
    assert.equal(g.document.getElementById('filter-apply').textContent, 'Показать ' + g.state.filtered.length);
    g.resetFilters();
    assert.equal(g.state.activeCategory, 'Все товары');
    assert.equal(g.document.getElementById('catalog-title').textContent, 'Все товары');
    assert.equal(g.document.getElementById('filter-btn-label').textContent, 'Фильтры');
    assert.equal(g.state.filtered.length, SEED.length);
  });

  it('стрелка наверх появляется только после прокрутки', () => {
    const btn = g.document.getElementById('to-top');
    global.window.scrollY = 0;
    g.updateToTop();
    assert.equal(btn.classList.contains('hidden'), true, 'на верху страницы кнопки нет');
    global.window.scrollY = 900;
    g.updateToTop();
    assert.equal(btn.classList.contains('hidden'), false, 'после прокрутки появилась');
    global.window.scrollY = 0;
    g.updateToTop();
    assert.equal(btn.classList.contains('hidden'), true, 'снова пропала наверху');
    assert.doesNotThrow(() => g.observeToTop(), 'страховка через IntersectionObserver не падает');
    assert.ok(HTML.includes('id="hero-block"'), 'наблодан за баннером есть');
    assert.ok(/addEventListener\(['"]scroll['"]/.test(HTML), 'слушатель scroll на месте');
  });

  it('разметка: вкладки, иконка корзины, шторка вместо стены чипов, значок поддержки', () => {
    const tabs = HTML.slice(HTML.indexOf('id="tab-btn-catalog"'), HTML.indexOf('</div>\n</header>'));
    assert.ok(tabs.indexOf('tab-btn-cart') > tabs.indexOf('tab-btn-contacts'), '«Корзина» в конце списка вкладок');
    assert.ok(tabs.indexOf('tab-btn-cart') > tabs.indexOf('tab-btn-about'));

    const cartIcon = HTML.slice(HTML.indexOf('aria-label="Корзина"'), HTML.indexOf('cart-badge'));
    assert.match(cartIcon, /<circle/, 'иконка корзины — с колёсами, без рваного пути');
    assert.equal(cartIcon.includes('M3 3h2l.4 2M7 13h10l4-8H5.4'), false, 'старая битая дорожка удалена');

    const sheet = HTML.slice(HTML.indexOf('id="filter-sheet"'), HTML.indexOf('id="view-product"'));
    assert.match(HTML.slice(HTML.indexOf('id="filter-sheet"'), HTML.indexOf('id="filter-sheet"') + 60), /class="hidden/, 'шторка стартует закрытой');
    assert.ok(sheet.includes('id="category-pills"') && sheet.includes('id="series-pills"') && sheet.includes('id="sort-select"'), 'категории, серии и сортировка — внутри шторки');
    assert.equal(HTML.includes('Бренды и серии смарт-часов'), false, 'стена чипов убрана из тела страницы');
    assert.equal(HTML.includes('id="category-pills" class="flex gap-2 overflow-x-auto'), false, 'чипы категорий больше не лежат отдельным рядом');

    const fab = HTML.slice(HTML.indexOf('id="support-fab"'), HTML.indexOf('id="toast"'));
    assert.ok(fab.includes('id="ui-float-tg"') && fab.includes('id="ui-float-max"'), 'ссылки на сети живут в меню поддержки');
    assert.match(fab, />Telegram</, 'логотип Telegram с названием');
    assert.match(fab, />MAX</, 'логотип MAX с названием');
    assert.equal(fab.includes('✈'), false, 'иконка-самолётик вместо логотипа больше нет');

    const toTop = HTML.slice(HTML.indexOf('id="to-top"'), HTML.indexOf('id="support-fab"'));
    assert.match(toTop, /class="hidden/, 'стрелка наверх стартует скрытой');

    const hits = HTML.slice(HTML.indexOf('Хиты продаж'), HTML.indexOf('Хиты продаж') + 400);
    assert.match(hits, /href="#\/catalog"/, '«Все товары →» — настоящая ссылка');
  });

  it('после смены каталога подсказки пересобираются, а не берутся из старого списка', () => {
    type('descent');
    const before = g.state.suggest.map((s) => s.label);
    assert.ok(before.length > 0);
    g.state.products = g.state.products.filter((p) => p.series !== 'Descent');
    g.state.products = [{ id: 9001, brand: 'TESTBRAND', series: 'TestSeries', category: 'Аксессуары', name: 'TestBrand Thing 1', price: 100, specs: '' }, ...g.state.products];
    type('testbrand');
    const after = g.state.suggest.map((s) => s.label);
    assert.ok(after.some((l) => /testbrand/i.test(l)), 'новый товар появился в подсказках');
    assert.equal(after.some((l) => /descent/i.test(l)), false, 'старые позиции больше не предлагаются');
  });
});
