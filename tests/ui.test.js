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
    g.renderSuggestionsNow();
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
    assert.ok(/addEventListener\(['"]scroll['"]/.test(HTML), 'слушатель scroll на месте');
    assert.equal(HTML.includes('maximum-scale'), false, 'страницу можно приблизить пальцем');
    assert.equal(HTML.includes('user-scalable'), false, 'то же про user-scalable');
  });

  it('цифра в запросе сужает выдачу и совпадает со счётчиком подсказки', () => {
    const run = (q) => { type(q); return g.state.filtered.slice(); };
    const fenix = run('Fenix');
    const fenix8 = run('Fenix 8');
    assert.ok(fenix8.length > 0 && fenix8.length < fenix.length, `Fenix 8: ${fenix8.length} из ${fenix.length}`);
    assert.equal(run('fenix   8').length, fenix8.length, 'лишние пробелы не ломают модель');
    assert.ok(run('Fenix 6').length > 0 && run('Fenix 6').length < fenix.length, 'Fenix 6 — своя линейка');
    type('Fenix');
    for (const s of g.state.suggest) {
      assert.equal(s.count, run(s.label).length, `счётчик подсказки «${s.label}» совпадает с выдачей`);
    }
    // подсказки считаются с учётом активного фильтра
    global.location.hash = '#/c/' + encodeURIComponent('Эхолоты');
    g.route();
    type('fenix');
    assert.equal(g.state.suggest.length, 0, 'в эхолотах Fenix не предлагем');
    global.location.hash = '#/catalog';
    g.route();
  });

  it('пустой экран «заказ принят» возвращает в каталог, а заказ этой сессии — остаётся', async () => {
    global.location.hash = '#/order-success';
    g.route();
    assert.equal(g.state.currentView, 'catalog', 'прямая ссылка на пустой экран не работает');
    g.state.cart = [];
    g.addToCart(null, g.state.products[0].id);
    g.document.getElementById('f-fio').value = 'Иван';
    g.document.getElementById('f-phone').value = '+7 900 000-00-00';
    g.state.lastOrderAt = 0;
    g.document.getElementById('order-submit-btn').disabled = false;
    await g.submitOrder();
    assert.equal(g.state.currentView, 'order-success');
    const code = g.document.getElementById('order-code-badge').textContent;
    assert.match(code, /^TG-\d+$/);
    global.location.hash = '#/catalog';
    g.route();
    global.location.hash = '#/order-success';
    g.route();
    assert.equal(g.state.currentView, 'order-success', 'заказ этой сессии переживает переход');
    assert.equal(g.document.getElementById('order-code-badge').textContent, code);
  });

  it('телефон из одних букв не проходит, заказ остаётся в корзине', async () => {
    g.state.cart = [];
    g.addToCart(null, g.state.products[1].id);
    g.document.getElementById('f-fio').value = 'Иван';
    g.document.getElementById('f-phone').value = 'абвгдежзклмн';
    g.state.lastOrderAt = 0;
    g.document.getElementById('cart-error').classList.add('hidden');
    await g.submitOrder();
    assert.equal(g.state.cart.length, 1, 'заявка не отправлена');
    assert.match(g.document.getElementById('cart-error').textContent, /телефон/i);
  });

  it('набор текста не тормозит, но устаревшие подсказки исчезают сразу', () => {
    g.document.getElementById('search-input').value = 'эхолот';
    g.renderSuggestionsNow();
    const before = g.state.filtered.length;
    const beforeSuggest = g.state.suggest.length;
    assert.ok(beforeSuggest > 0 && g.state.suggest.every((s) => /эхолот/i.test(s.label)), 'под списком только то, что просили');
    g.document.getElementById('search-input').value = 'garmin edge';
    g.onSearchInput();
    assert.equal(g.state.filtered.length, before, 'сетка перестилается после паузы, а не на каждом нажатии');
    assert.equal(g.state.suggest.length, 0, 'старые подсказки не предлагаются под новый запрос');
    g.renderSuggestionsNow();
    assert.ok(g.state.filtered.length > 0 && g.state.filtered.length !== before, 'после паузы выдача обновилась');
    assert.ok(g.state.suggest.length > 0 && g.state.suggest.every((s) => /edge/i.test(s.label)), 'и подсказки по обоим словам');
  });

  it('Enter без паузы показывает выдачу по текущему тексту', () => {
    g.document.getElementById('search-input').value = '';
    g.renderSuggestionsNow();
    const all = g.state.filtered.length;
    g.document.getElementById('search-input').value = 'велокомп';
    g.onSearchInput();
    assert.equal(g.state.filtered.length, all, 'без паузы сетка ещё не перестелена');
    g.onSearchKey({ key: 'Enter', preventDefault() {} });
    assert.ok(g.state.filtered.length > 0 && g.state.filtered.length < all, 'Enter дорисовывает сразу');
    assert.ok(g.state.filtered.every((p) => /велокомп/i.test(p.name + ' ' + p.category + ' ' + (p.specs || ''))));
    assert.equal(g.document.getElementById('search-input').value, 'велокомп', 'Enter не стирает запрос');
  });

  it('битая корзина в localStorage не убивает сайт, а ссылка на MAX без бота скрыта', () => {
    const broken = mountFrontend({ storage: "{ getItem: (k) => (k === 'watchop_cart' ? 'не-json' : null), setItem: () => {} }" });
    assert.ok(broken.state.products.length > 300, 'каталог загрузился');
    assert.deepEqual(broken.state.cart, [], 'битая корзина сброшена');
    broken.renderCatalog();
    assert.ok(broken.document.getElementById('products-grid').innerHTML.includes('#/p/'), 'сетка отрисована');

    const g2 = mountFrontend();
    assert.equal(g2.state.settings.max_link, '', 'по умолчанию MAX не подключен');
    g2.applySettingsToUI();
    assert.equal(g2.document.getElementById('ui-float-max').classList.contains('hidden'), true, 'без бота ссылка не светится');
    g2.state.settings = { ...g2.state.settings, max_link: 'https://max.ru/watchop' };
    g2.applySettingsToUI();
    assert.equal(g2.document.getElementById('ui-float-max').classList.contains('hidden'), false, 'с настроенным MAX ботом ссылка возвращается');
  });

  it('пересборка каталога сбрасывает корзину и избранное, совпадение — оставляет', () => {
    // harness монтирует скрипт своим eval'ом, поэтому хранилище передаём через global:
    // замыкание на локальную переменную теста внутри eval недосягаемо.
    const mk = (rows) => {
      const store = new Map(rows);
      global.__tstore = store;
      const g = mountFrontend({ storage: '{ getItem: (k) => (globalThis.__tstore.has(k) ? globalThis.__tstore.get(k) : null), setItem: (k, v) => globalThis.__tstore.set(k, String(v)) }' });
      return { g, store };
    };
    const first = mk([['watchop_cart', JSON.stringify([{ id: 7, qty: 1 }])], ['watchop_favs', '[7]']]);
    assert.equal(first.g.state.cart.length, 1, 'корзина читается из хранилища');
    assert.deepEqual(first.g.state.favorites, [7]);
    assert.equal(first.g.syncCatalogFp(), false, 'первый запуск: отпечатка ещё нет, списки не трогаем');
    assert.equal(first.g.state.cart.length, 1);
    assert.equal(first.g.syncCatalogFp(), false, 'второй запуск: отпечаток совпал');
    assert.equal(first.g.state.cart.length, 1, 'без смены каталога корзина живёт');

    // id в корзине — номер позиции; если файл пересобран из базы, номер указывает на другой товар
    const stale = mk([['watchop_catfp', '111'], ['watchop_cart', JSON.stringify([{ id: 7, qty: 3 }])], ['watchop_favs', '[7,9]']]);
    assert.equal(stale.g.state.cart.length, 1, 'до проверки корзина читается из хранилища');
    assert.equal(stale.g.syncCatalogFp(), true, 'отпечаток разошёлся — нужен сброс');
    assert.deepEqual(stale.g.state.cart, [], 'корзина очищена');
    assert.deepEqual(stale.g.state.favorites, [], 'избранное очищено');
    assert.equal(stale.store.get('watchop_cart'), '[]', 'сброс записан в хранилище');
    assert.equal(stale.store.get('watchop_favs'), '[]');
    assert.notEqual(stale.store.get('watchop_catfp'), '111', 'отпечаток обновлён');
    assert.equal(stale.g.syncCatalogFp(), false, 'следующий запуск уже чистый');

    const g = stale.g;
    const full = g.state.products.slice();
    g.state.cart = [{ id: 3, qty: 1 }];
    g.state.products = full.slice().reverse();
    assert.equal(g.syncCatalogFp(), false, 'тот же состав в другом порядке — это тот же каталог');
    assert.equal(g.state.cart.length, 1, 'порядок сам по себя корзину не сбрасывает');
    g.state.products = full.slice(0, full.length - 1);
    assert.equal(g.syncCatalogFp(), true, 'убрали позицию — нумерация другая, корзину выбрасываем');
    assert.deepEqual(g.state.cart, []);
  });

  it('разметка: вкладки, иконка корзины, шторка вместо стены чипов, значок поддержки', () => {
    const tabs = HTML.slice(HTML.indexOf('id="tab-btn-catalog"'), HTML.indexOf('</div>\n</header>'));
    assert.ok(tabs.indexOf('tab-btn-cart') > tabs.indexOf('tab-btn-contacts'), '«Корзина» в конце списка вкладок');
    assert.ok(tabs.indexOf('tab-btn-cart') > tabs.indexOf('tab-btn-about'));

    const cartIcon = HTML.slice(HTML.indexOf('aria-label="Корзина"'), HTML.indexOf('cart-badge'));
    assert.match(cartIcon, /<circle/, 'иконка корзины — с колёсами, без рваного пути');
    assert.equal(cartIcon.includes('M3 3h2l.4 2M7 13h10l4-8H5.4'), false, 'старая битая дорожка удалена');

    const sheet = HTML.slice(HTML.indexOf('id="filter-sheet"'), HTML.indexOf('id="view-product"'));
    assert.match(HTML.slice(HTML.indexOf('id="filter-sheet"'), HTML.indexOf('id="filter-sheet"') + 200), /class="hidden/, 'шторка стартует закрытой');
    assert.match(sheet, /role="dialog"/, 'шторка — диалог для скринридера');
    assert.match(sheet, /aria-modal="true"/);
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

  it('счётчик подсказок не протухает: кэш сбрасывается вместе с фильтром и каталогом', () => {
    type('Fenix');
    const all = g.state.suggest.map((s) => `${s.label}:${s.count}`).join('|');
    global.location.hash = '#/c/' + encodeURIComponent('Велокомпьютеры');
    g.route();
    type('Fenix');
    assert.equal(g.state.suggest.length, 0, 'в другой категории счётчики пересчитаны');
    global.location.hash = '#/catalog';
    g.route();
    type('Fenix');
    assert.equal(g.state.suggest.map((s) => `${s.label}:${s.count}`).join('|'), all, 'после возврата счётчики те же');
    g.state.products = g.state.products.map((p) => ({ ...p }));
    g.invalidateSugCounts();
    g.renderFilters();
    type('Fenix');
    assert.equal(g.state.suggest.map((s) => `${s.label}:${s.count}`).join('|'), all, 'копия каталога даёт те же числа');
    const target = g.state.products.find((p) => /Fenix 8 47 мм AMOLED Black/.test(p.name));
    target.price = 1;
    g.invalidateSugCounts();
    type('до 1000');
    assert.ok(g.state.filtered.some((p) => /Fenix 8 47 мм AMOLED Black/.test(p.name)), 'изменённая цена учитывается');
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
