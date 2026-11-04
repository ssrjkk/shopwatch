const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { extractDiscountFns } = require('./helpers/load');
const { mountFrontend } = require('./helpers/dom');

// Математика скидки исполняется прямо из исходника server.js — тест проверяет
// тот же код, по которому админка пишет цены в базу.
function loadDiscount() {
  const factory = new Function(`${extractDiscountFns()}\nreturn { discountFor, discountOff };`);
  return factory();
}

// toLocaleString('ru-RU') вставляет неразрывные пробелы
const flat = (s) => String(s).replace(/[  ]/g, ' ');

describe('Скидка из админки: математика', () => {
  it('процент от цены, округление до 10 ₽, старая цена уходит в old_price', () => {
    const { discountFor } = loadDiscount();
    const r = discountFor({ price: 40000, old_price: 0 }, 20);
    assert.equal(r.ok, true);
    assert.equal(r.oldPrice, 40000);
    assert.equal(r.price, 32000);
    const odd = discountFor({ price: 62320, old_price: 0 }, 15);
    assert.equal(odd.price, 52970);
    assert.equal(odd.oldPrice, 62320);
  });

  it('повторная скидка считается от цены до уценки, а не от уже уценённой', () => {
    const { discountFor } = loadDiscount();
    const first = discountFor({ price: 40000, old_price: 0 }, 20);
    const second = discountFor({ price: first.price, old_price: first.oldPrice }, 25);
    assert.equal(second.ok, true);
    assert.equal(second.oldPrice, 40000);
    assert.equal(second.price, 30000);
  });

  it('ручная правка цены выше зачёркнутой не ломает отсчёт', () => {
    const { discountFor } = loadDiscount();
    // админ поднял цену выше старой зачёркнутой — базой становится новая цена
    const r = discountFor({ price: 45000, old_price: 40000 }, 10);
    assert.equal(r.oldPrice, 45000);
    assert.equal(r.price, 40500);
  });

  it('некорректный процент и пустая цена отбиваются', () => {
    const { discountFor } = loadDiscount();
    for (const bad of [0, -5, 91, 100, 'abc', '', null, undefined]) {
      assert.equal(discountFor({ price: 40000, old_price: 0 }, bad).ok, false, `процент ${String(bad)}`);
    }
    assert.equal(discountFor({ price: 0, old_price: 0 }, 20).ok, false);
    assert.equal(discountFor({ price: 10, old_price: 0 }, 1).ok, false);
  });

  it('снятие скидки возвращает цену до уценки', () => {
    const { discountOff } = loadDiscount();
    const r = discountOff({ price: 32000, old_price: 40000 });
    assert.equal(r.ok, true);
    assert.equal(r.price, 40000);
    assert.equal(discountOff({ price: 40000, old_price: 0 }).ok, false);
  });
});

describe('Скидка на витрине: зачёркнутая цена', () => {
  let g;

  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('зачёркивание только серое и тонкое — без красного и без капса', () => {
    const html = g.oldPriceHTML({ price: 32000, old_price: 40000 });
    assert.match(html, /line-through/);
    assert.match(html, /text-demo-muted/);
    assert.doesNotMatch(html, /red|uppercase|font-bold/);
    assert.match(flat(html), /40 000 ₽/);
  });

  it('без скидки зачёркнутой цены нет', () => {
    assert.equal(g.oldPriceHTML({ price: 40000, old_price: 0 }), '');
    assert.equal(g.oldPriceHTML({ price: 40000, old_price: 40000 }), '');
    assert.equal(g.oldPriceHTML({ price: 40000 }), '');
    assert.equal(g.oldPriceHTML({ price: 40000, old_price: 39000 }), '');
  });

  it('карточка товара показывает и новую, и старую цену', () => {
    const card = flat(g.productCardHTML({ id: 90001, brand: 'GARMIN', series: 'fēnix', category: 'Спортивные часы', name: 'Fenix 8 тест', price: 32000, old_price: 40000, image: 'x', specs: '' }));
    assert.match(card, /32 000 ₽/);
    assert.match(card, /40 000 ₽/);
    assert.match(card, /line-through/);
  });
});
