const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mountFrontend } = require('./helpers/dom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SEED = require(path.join(__dirname, '..', 'public', 'products-data.js'));

describe('витрина-stealth: поиск, фильтры, оформление', () => {
  let g;

  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 50));
  });

  function type(q) {
    g.document.getElementById('search-input').value = q;
    g.onSearchInput();
  }
  function sugLinks() {
    return [...g.document.getElementById('search-suggestions-list').innerHTML.matchAll(/href="#\/p\/(\d+)"/g)].map((m) => Number(m[1]));
  }

  it('подсказки строятся из реального каталога и всегда что-то находят', () => {
    type('fenix');
    let ids = sugLinks();
    assert.ok(ids.length > 0 && ids.length <= 5, `подсказок: ${ids.length}`);
    assert.ok(g.state.filtered.length > 0, 'выдача непустая');
    for (const id of ids) {
      const p = g.state.products.find((x) => x.id === id);
      assert.ok(p && /fenix/i.test(p.series + ' ' + p.brand + ' ' + p.name), `подсказка #${id} про fenix`);
    }
    type('марк');
    assert.ok(sugLinks().length > 0, 'транслит «марк» находит MARQ');
    assert.ok(g.state.filtered.length > 0);
  });

  it('дропдаун открывается, выбирается по тапу и закрывается по Escape', () => {
    const dd = g.document.getElementById('search-dropdown');
    type('fenix');
    g.openSearchDropdown(true);
    assert.equal(dd.classList.contains('hidden'), false, 'дропдаун виден при наборе');
    const ids = sugLinks();
    assert.ok(ids.length > 0);
    g.selectSearchTag('Fenix 8');
    assert.ok(String(g.document.getElementById('search-input').value).length > 0, 'подсказка подставилась в поле');
    assert.equal(dd.classList.contains('hidden'), true, 'после выбора дропдаун закрыт');
    assert.ok(g.state.filtered.length > 0);
    type('марк');
    assert.ok(sugLinks().length > 0, 'транслит даёт подсказки и по-русски');
    g.openSearchDropdown(true);
    g.onSearchKeyDown({ key: 'Escape' });
    assert.equal(dd.classList.contains('hidden'), true, 'первый Escape закрывает дропдаун');
    assert.equal(g.searchQuery(), 'марк', 'первый Escape запрос не трогает');
    g.onSearchKeyDown({ key: 'Escape' });
    assert.equal(g.searchQuery(), '', 'второй Escape чистит запрос');
  });

  it('на пустом поле показываются товары, а не пустота', () => {
    type('');
    const ids = sugLinks();
    assert.ok(ids.length > 0 && ids.length <= 5, `топ позиций: ${ids.length}`);
    for (const id of ids) assert.ok(g.state.products.some((p) => p.id === id), `#${id} из каталога`);
  });

  it('пилюли категорий и серий рендерят настоящие ссылки', () => {
    g.resetAllFilters();
    g.renderFilters();
    assert.ok(g.document.getElementById('category-pills').innerHTML.includes('#/c/'), 'категории — ссылки #/c/');
    assert.ok(g.document.getElementById('series-pills').innerHTML.includes('#/s/'), 'серии — ссылки #/s/');
    for (const html of [g.document.getElementById('category-pills').innerHTML, g.document.getElementById('series-pills').innerHTML]) {
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        assert.ok(!/[\u0400-\u04FF]|%D0|%D1/i.test(m[1]), `slug без кириллицы: ${m[1]}`);
      }
    }
    assert.ok(g.document.getElementById('category-pills').innerHTML.includes('#/c/fishfinders'), 'эхолоты — /fishfinders');
    global.location.hash = '#/c/fishfinders';
    g.route();
    assert.equal(g.state.activeCategory, 'Эхолоты', 'английский слаг применился');
    assert.equal(g.state.filtered.length, SEED.filter((p) => p.category === 'Эхолоты').length, 'слаг отфильтровал эхолоты');
    global.location.hash = '#/c/' + encodeURIComponent('Эхолоты');
    g.route();
    assert.equal(g.state.activeCategory, 'Эхолоты', 'категория применилась');
    assert.equal(g.state.filtered.length, SEED.filter((p) => p.category === 'Эхолоты').length);
    assert.match(String(g.document.getElementById('filter-btn-label').textContent), /Фильтры · 1/);
    g.resetAllFilters();
    assert.equal(g.state.activeCategory, 'Все товары');
    assert.equal(g.state.filtered.length, SEED.length);
    assert.equal(g.document.getElementById('filter-btn-label').textContent, 'Фильтры');
  });

  it('стрелка наверх появляется только после прокрутки', () => {
    const btn = g.document.getElementById('to-top-btn');
    global.window.scrollY = 0;
    g.updateToTop();
    assert.equal(btn.classList.contains('hidden'), true, 'на верху страницы кнопки нет');
    global.window.scrollY = 900;
    g.updateToTop();
    assert.equal(btn.classList.contains('hidden'), false, 'после прокрутки появилась');
    global.window.scrollY = 0;
    g.updateToTop();
    assert.equal(btn.classList.contains('hidden'), true, 'снова пропала наверху');
    assert.equal(HTML.includes('maximum-scale'), false, 'страницу можно приблизить пальцем');
    assert.equal(HTML.includes('user-scalable'), false, 'то же про user-scalable');
  });

  it('цифра в запросе сужает выдачу', () => {
    const run = (q) => { type(q); return g.state.filtered.slice(); };
    const fenix = run('Fenix');
    const fenix8 = run('Fenix 8');
    assert.ok(fenix8.length > 0 && fenix8.length < fenix.length, `Fenix 8: ${fenix8.length} из ${fenix.length}`);
    assert.equal(run('fenix   8').length, fenix8.length, 'лишние пробелы не ломают модель');
    type('Fenix');
    assert.ok(sugLinks().length > 0, 'по «Fenix» подсказки — позиции из каталога');
  });

  it('пустой экран «заказ принят» возвращает в каталог, а заказ этой сессии — остаётся', async () => {
    global.location.hash = '#/order-success';
    g.route();
    assert.equal(g.document.getElementById('view-order-success').classList.contains('hidden'), true, 'прямая ссылка на пустой экран не работает');
    assert.equal(g.document.getElementById('view-catalog').classList.contains('hidden'), false, 'а каталог показан');
    g.state.cart = [];
    g.addToCart(null, g.state.products[0].id);
    g.document.getElementById('f-fio').value = 'Иван';
    g.document.getElementById('f-phone').value = '+7 900 000-00-00';
    g.state.lastOrderAt = 0;
    await g.submitOrder();
    assert.equal(g.document.getElementById('view-order-success').classList.contains('hidden'), false, 'успех показан');
    const code = g.document.getElementById('order-code-badge').textContent;
    assert.match(code, /^TG-\d+$/);
    global.location.hash = '#/catalog';
    g.route();
    global.location.hash = '#/order-success';
    g.route();
    assert.equal(g.document.getElementById('view-order-success').classList.contains('hidden'), false, 'заказ этой сессии переживает переход');
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

  it('поиск рендерится сразу, без пауз', () => {
    g.document.getElementById('search-input').value = 'эхолот';
    g.onSearchInput();
    const before = g.state.filtered.length;
    assert.ok(before > 0 && sugLinks().length > 0, 'под списком то, что просили');
    g.document.getElementById('search-input').value = 'garmin edge';
    g.onSearchInput();
    assert.notEqual(g.state.filtered.length, before, 'сетка перестелена сразу');
    assert.ok(sugLinks().length > 0, 'подсказки под новый запрос');
  });

  it('Enter показывает выдачу по текущему тексту', () => {
    g.document.getElementById('search-input').value = '';
    g.onSearchInput();
    const all = g.state.filtered.length;
    g.document.getElementById('search-input').value = 'велокомп';
    g.onSearchKeyDown({ key: 'Enter', preventDefault() {} });
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
    g2.state.settings = { ...g2.state.settings, max_link: '' };
    g2.applySettingsToUI();
    assert.equal(g2.document.getElementById('ui-float-max').classList.contains('hidden'), true, 'без бота ссылка не светится');
    g2.state.settings = { ...g2.state.settings, max_link: 'https://max.ru/bridge-bot' };
    g2.applySettingsToUI();
    assert.equal(g2.document.getElementById('ui-float-max').classList.contains('hidden'), false, 'с настроенным MAX ботом ссылка возвращается');
  });

  it('витрина не вшивает мёртвую MAX-заглушку: на Pages дефолт пустой и кнопки скрыты сами', () => {
    assert.ok(!HTML.includes('max.ru/watchop'), 'заглушка max.ru/watchop не имеет права возвращаться в витрину (Pages прятать её некому)');
    assert.ok(/max_link:''/.test(HTML), 'дефолт max_link пуст — кнопки MAX скрываются собственной логикой');
  });

  it('пересборка каталога сбрасывает корзину и избранное, совпадение — оставляет', () => {
    const mk = (rows) => {
      const store = new Map(rows);
      globalThis.__tstore = store;
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
    assert.equal(g.state.cart.length, 1, 'порядок сам по себе корзину не сбрасывает');
    g.state.products = full.slice(0, full.length - 1);
    assert.equal(g.syncCatalogFp(), true, 'убрали позицию — нумерация другая, корзину выбрасываем');
    assert.deepEqual(g.state.cart, []);
  });

  it('разметка: вкладки, корзина, тосты и поддержка', () => {
    const rawH = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const hdrIdx = rawH.indexOf('<header');
    const hdrChunk = rawH.slice(hdrIdx, hdrIdx + 1800);
    const menuBtnPos = hdrChunk.indexOf('toggleDrawer(true)');
    const brandNamePos = hdrChunk.indexOf('ONEWATCH');
    assert.ok(menuBtnPos > 0 && brandNamePos > menuBtnPos, 'кнопка меню в левом углу, надпись ONEWATCH правее кнопки меню');
    const tabs = HTML.slice(HTML.indexOf('id="tab-btn-catalog"'), HTML.indexOf('</header>'));
    for (const t of ['tab-btn-catalog', 'tab-btn-cart', 'tab-btn-orders', 'tab-btn-about', 'tab-btn-delivery']) {
      assert.ok(tabs.includes(t), `вкладка ${t} на месте`);
    }
    assert.ok(tabs.indexOf('tab-btn-catalog') < tabs.indexOf('tab-btn-cart'), 'каталог раньше корзины');
    assert.ok(HTML.includes('id="cart-badge"') && HTML.includes('id="fav-badge"'), 'бейджи корзины и избранного на месте');
    assert.ok(HTML.includes('id="toast"'), 'тосты есть');
    assert.ok(HTML.includes('id="ui-float-tg"') && HTML.includes('id="ui-float-max"'), 'ссылки на мессенджеры на месте');
    assert.ok(HTML.includes('id="to-top-btn"'), 'кнопка наверх есть');
    assert.ok(HTML.includes('property="og:title"'), 'Open Graph заголовок для шаринга');
    assert.ok(HTML.includes('property="og:image"'), 'Open Graph картинка для шаринга');
    assert.ok(HTML.includes('rel="canonical"'), 'канонический URL');
    assert.ok(HTML.includes('name="description"'), 'meta description');
    const hits = HTML.slice(HTML.indexOf('id="hits-section"'), HTML.indexOf('id="hits-section"') + 700);
    assert.match(hits, /Вся коллекция →/, 'у хитов есть переход ко всей коллекции');
    g.setCategory('Эхолоты');
    assert.ok(g.state.filtered.length < SEED.length);
    g.resetAllFilters();
    assert.equal(g.state.filtered.length, SEED.length, 'кнопка возвращает полную коллекцию');
  });

  it('подсказки всегда считаются по живому каталогу, а не из кэша', () => {
    type('fenix');
    const before = sugLinks();
    assert.ok(before.length > 0, 'подсказки есть');
    const target = g.state.products.find((p) => /Suunto/i.test(p.brand));
    target.brand = 'TESTBRANDX';
    type('testbrandx');
    assert.ok(g.state.filtered.some((p) => p.brand === 'TESTBRANDX'), 'новый бренд ищется сразу');
    assert.ok(sugLinks().includes(target.id), 'и сразу предлагается в подсказках');
    target.brand = 'SUUNTO';
    type('fenix');
    assert.deepEqual(sugLinks(), before, 'возврат даёт те же позиции');
  });

  it('фото из админки отдаётся относительным путём — иначе Pages в подпапке его не найдёт', () => {
    assert.equal(g.imgSrc('/uploads/watch_1.jpg'), 'uploads/watch_1.jpg');
    assert.equal(g.imgSrc('https://img.example/a.jpg'), 'https://img.example/a.jpg');
    assert.equal(g.imgSrc('uploads/keep.jpg'), 'uploads/keep.jpg');
    assert.equal(g.imgSrc(''), '');
    assert.equal(g.imgSrc(null), '');
    const card = g.productCardHTML({ id: 90002, brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Fenix 9 Pro тест', price: 147200, image: '/uploads/watch_1.jpg', specs: '' });
    assert.match(card, /src="uploads\/watch_1\.jpg/);
    assert.doesNotMatch(card, /src="\/uploads/);
  });

  it('картинки Unsplash просят webp нужной ширины, чужие хосты не трогаются', () => {
    assert.equal(
      g.imgUrl('https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80', 400),
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400&q=80&fm=webp'
    );
    assert.equal(g.imgUrl('https://images.unsplash.com/photo-x?w=600&q=80&fm=webp', 160), 'https://images.unsplash.com/photo-x?w=160&q=80&fm=webp', 'fm не дублируется');
    assert.equal(g.imgUrl('https://upload.wikimedia.org/a/b.png', 400), 'https://upload.wikimedia.org/a/b.png', 'чужой хост без параметров ширины');
    assert.equal(g.imgUrl('/uploads/watch_1.jpg', 400), 'uploads/watch_1.jpg', 'своё фото остаётся как есть');
    assert.equal(g.imgUrl('', 400), '');
  });

  it('пока человек ищет, «Хиты продаж» не встают над выдачей', () => {
    const sec = g.document.getElementById('hits-section');
    type('fenix');
    assert.equal(g.searchQuery(), 'fenix');
    assert.ok(sec.classList.contains('hidden'), 'при запросе хиты скрыты');
    type('');
    assert.ok(!sec.classList.contains('hidden'), 'без запроса хиты на месте');
    g.setCategory('Эхолоты');
    assert.ok(!sec.classList.contains('hidden'), 'фильтр по категории хиты не прячет');
    g.resetAllFilters();
  });

  it('после смены каталога подсказки пересобираются, а не берутся из старого списка', () => {
    type('descent');
    type('descent');
    assert.ok(sugLinks().length > 0, 'до замены каталога подсказки есть');
    g.state.products = g.state.products.filter((p) => p.series !== 'Descent');
    g.state.products = [{ id: 9001, brand: 'TESTBRAND', series: 'TestSeries', category: 'Аксессуары', name: 'TestBrand Thing 1', price: 100, specs: '' }, ...g.state.products];
    type('testbrand');
    const after = sugLinks();
    assert.deepEqual(after, [9001], 'предлагается только то, что осталось в каталоге');
  });

  it('автономный слой покрывает скрывающие состояния (CDN может лежать)', () => {
    for (const cls of ['.-translate-x-full', '.translate-x-full', '.translate-x-0', '.hidden']) {
      assert.ok(HTML.includes(cls + ' {') || HTML.includes(cls + '{'), 'fallback: ' + cls);
    }
    assert.ok(HTML.includes('id="drawer"'), 'drawer markup');
  });

  it('счётчик моделей в og:description не расходится с каталогом', () => {
    const m = HTML.match(/<meta property="og:description" content="(\d+) модел/);
    assert.ok(m, 'в og:description заявлено число моделей');
    assert.equal(Number(m[1]), SEED.length, `витрина обещает ${m && m[1]} моделей, в каталоге ${SEED.length}`);
  });

  it('переключателя темы на витрине больше нет', () => {
    for (const f of ['index.html', 'public/index.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const needle of ['id="theme-btn"', 'toggleTheme(', 'applyTheme(', "localStorage.getItem('app_theme')", 'body.stealth-edition', 'body.dark-theme',
                            'openCallbackModal', 'openTradeInModal', 'openDeliveryCalc', 'openLightbox(', 'id="hits-promo-btn"', 'Промоцены',
                            'togglePriceWatch', 'watchPriceTgLink', 'start=WATCH_', 'price-watch-link']) {
        assert.ok(!html.includes(needle), f + ': остался хвост темы — ' + needle);
      }
    }
  });

  it('документы не обещают то, чего в проекте уже нет', () => {
    const docs = ['README.md', 'README.ru.md', 'cms/README-CMS.md', 'docs/launch-checklist.md'];
    // Удалённые фичи и старые имена: ни в одном документе упоминать их нельзя.
    const gone = ['Лайтбокс', 'лайтбокс', 'lightbox', 'Lightbox', 'index-stealth', 'index-classic',
                 'store_design', 'push-update', 'Watchop', 'ВЕКТОР', 'dark theme', 'Dark theme',
                 'тёмная тема', 'Тёмная тема'];
    for (const f of docs) {
      const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const w of gone) assert.ok(!text.includes(w), f + ': упоминает то, чего больше нет — ' + w);
    }
    // Кнопка «Дизайн» в админке: её нет ни в одном описании меню.
    for (const f of ['README.md', 'README.ru.md']) {
      const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(!/`Дизайн`/.test(text), f + ': в описании меню осталась кнопка «Дизайн»');
    }
    // Число позиций в cms-доке обязано совпадать с каталогом, который там лежат выгрузки.
    const catalog = require(path.join(__dirname, '..', 'products-data.js'));
    const rows = (Array.isArray(catalog) ? catalog : catalog.products).length;
    const cms = fs.readFileSync(path.join(__dirname, '..', 'cms', 'README-CMS.md'), 'utf8');
    assert.ok(cms.includes(rows + ' позиц'), 'cms/README-CMS.md: нет актуального числа ' + rows);
    assert.equal(cms.includes(String(rows - 36)), false, 'cms/README-CMS.md: остался старый счётник ' + (rows - 36));
    assert.equal(/\b35\d\b/.test(cms), false, 'cms/README-CMS.md: остался счётчик старого каталога');
  });

  it('размеры файлов витрины в README совпадают с фактическими (обе языки)', () => {
    const zlib = require('zlib');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
    const pd = fs.readFileSync(path.join(__dirname, '..', 'public', 'products-data.js'));
    const expected = {
      'index.html': [html.length, zlib.brotliCompressSync(html).length],
      'products-data.js': [pd.length, zlib.brotliCompressSync(pd).length],
    };
    for (const file of ['README.md', 'README.ru.md']) {
      const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const line = text.split('\n').find((l) => l.includes('**Сжатие') || l.includes('**Compression'));
      assert.ok(line, `в ${file} есть строка про сжатие`);
      for (const token of Object.keys(expected)) {
        const at = line.indexOf('`' + token + '`');
        assert.ok(at >= 0, `${file}: ${token} упомянут в строке про сжатие`);
        const nums = (line.slice(at, at + 120).match(/\d[\d\s  ]*\d/g) || []).map((s) => parseInt(s.replace(/\D/g, ''), 10));
        assert.deepEqual(nums.slice(0, 2), expected[token], `${file}: ${token} — сырой размер и brotli (${expected[token]}) должны совпадать с тем, что обещает док (${nums.slice(0, 2)})`);
      }
    }
  });

  it('доставки в оформлении — из настроек, мусор — в дефолт', () => {
    const gg = mountFrontend();
    gg.state.settings = { ...gg.state.settings, delivery_methods: 'СДЭК, Boxberry' };
    gg.renderDeliveryOptions();
    const sel = gg.document.getElementById('f-delivery');
    assert.ok(sel.innerHTML.includes('value="Boxberry"'), sel.innerHTML.slice(0, 200));
    assert.ok(!sel.innerHTML.includes('Почта России'));
    gg.state.settings = { ...gg.state.settings, delivery_methods: '' };
    gg.renderDeliveryOptions();
    assert.ok(gg.document.getElementById('f-delivery').innerHTML.includes('Почта России'), 'пустая настройка — дефолтные три');
    gg.state.settings = { ...gg.state.settings };
    delete gg.state.settings.delivery_methods;
    gg.renderDeliveryOptions();
    assert.ok(gg.document.getElementById('f-delivery').innerHTML.includes('value="СДЭК"'), 'без ключа — дефолт');
  });


});
