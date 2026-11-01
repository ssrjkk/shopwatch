const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractPromoBlock, extractEncodingBlock } = require('./helpers/load');

// Промокоды — чистые функции: правила приходят строкой, цены из lookup (в бою это
// запрос к базе), поэтому подделать сумму клиент не может, и в тесте это видно.
const api = new Function(`${extractEncodingBlock()}\n${extractPromoBlock()}\nreturn { DEFAULT_PROMO_RULES, parsePromoRules, serializePromoRules, evaluatePromo, upsertPromoRule, removePromoRule, promoRulesText };`)();

const RULES = 'WATCH10=10,GARMIN5=5:GARMIN,VIP15=15:min50000';
// toLocaleString('ru-RU') разделяет разряды неразрывным пробелом — сравниваем в обычном
const flat = (s) => String(s).replace(/[\u00A0\u202F]/g, ' ');

// lookup по базе: две позиции Garmin и одна Apple
const PRODUCTS = {
  1: { id: 1, brand: 'GARMIN', price: 100000 },
  2: { id: 2, brand: 'GARMIN', price: 50000 },
  3: { id: 3, brand: 'APPLE', price: 80000 },
  4: { id: 4, brand: 'COROS', price: 30000 },
};
const lookup = (id) => PRODUCTS[id] || null;

describe('Промокоды: правила считаются сервером', () => {
  it('правила разбираются и собираются обратно без потерь', () => {
    const map = api.parsePromoRules(RULES);
    assert.equal(map.size, 3);
    assert.deepEqual(map.get('WATCH10'), { code: 'WATCH10', percent: 10, brand: '', minTotal: 0 });
    assert.deepEqual(map.get('GARMIN5'), { code: 'GARMIN5', percent: 5, brand: 'GARMIN', minTotal: 0 });
    assert.deepEqual(map.get('VIP15'), { code: 'VIP15', percent: 15, brand: '', minTotal: 50000 });
    assert.equal(api.serializePromoRules(map), RULES, 'round trip не меняет строку');
  });

  it('мусор в правилах не становится скидкой', () => {
    const map = api.parsePromoRules('ХАОС,=50,WATCH10=95,OK=7,,  ;  TEST=3:GARMIN:min1000');
    assert.equal(map.has('ХАОС'), false);
    assert.equal(map.has('WATCH10'), false, '95% выходит за допустимый диапазон 1–90');
    assert.equal(map.get('OK').percent, 7);
    assert.equal(map.get('TEST').brand, 'GARMIN');
    assert.equal(map.get('TEST').minTotal, 1000);
  });

  it('обычный процент: скидка 10% с округлением до 10 ₽', () => {
    const r = api.evaluatePromo(RULES, 'watch10', [{ id: 1, qty: 1 }, { id: 3, qty: 2 }], lookup);
    assert.equal(r.ok, true);
    assert.equal(r.code, 'WATCH10', 'код приводится к верхнему регистру');
    assert.equal(r.subtotal, 100000 + 80000 * 2);
    assert.equal(r.discountRub, 26000);
    assert.equal(r.total, r.subtotal - r.discountRub);
  });

  it('брендовый код считает скидку только с позиций нужного бренда', () => {
    const items = [{ id: 1, qty: 1 }, { id: 3, qty: 1 }];
    const r = api.evaluatePromo(RULES, 'GARMIN5', items, lookup);
    assert.equal(r.ok, true);
    assert.equal(r.subtotal, 180000, 'подытог — вся корзина');
    assert.equal(r.discountRub, 5000, '5% считаются с 100 000 ₽ Garmin, а не со 180 000 ₽');
    assert.equal(r.total, 175000);

    const noBrand = api.evaluatePromo(RULES, 'GARMIN5', [{ id: 3, qty: 1 }], lookup);
    assert.equal(noBrand.ok, false);
    assert.match(noBrand.error, /только на бренд GARMIN/);
    assert.equal(noBrand.total, 80000, 'без скидки остаётся полная сумма');
  });

  it('минимальный чек: порог включительно, ниже — отказ с понятным текстом', () => {
    const small = api.evaluatePromo(RULES, 'VIP15', [{ id: 4, qty: 1 }], lookup);
    assert.equal(small.ok, false);
    assert.match(flat(small.error), /от 50 000 ₽/);
    assert.equal(small.discountRub, 0);
    const exactly = api.evaluatePromo(RULES, 'VIP15', [{ id: 2, qty: 1 }], lookup);
    assert.equal(exactly.ok, true, '50 000 ₽ — ровно порог, скидка положена');
    assert.equal(exactly.discountRub, 7500);
    const big = api.evaluatePromo(RULES, 'VIP15', [{ id: 1, qty: 1 }], lookup);
    assert.equal(big.discountRub, 15000);
  });

  it('неизвестный и пустой код отклоняются, а не молча проходят', () => {
    const unknown = api.evaluatePromo(RULES, 'NOPE', [{ id: 1, qty: 1 }], lookup);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /не найден или истёк/);
    assert.equal(unknown.total, 100000);
    const empty = api.evaluatePromo(RULES, '   ', [{ id: 1, qty: 1 }], lookup);
    assert.equal(empty.ok, false);
    assert.match(empty.error, /не указан/);
  });

  it('цена берётся из lookup, а не из того, что прислал клиент', () => {
    const r = api.evaluatePromo(RULES, 'WATCH10', [{ id: 1, qty: 1, price: 100, name: 'копейки' }], lookup);
    assert.equal(r.subtotal, 100000, 'подставная цена в items игнорируется');
    assert.equal(r.discountRub, 10000);
  });

  it('скидка не может превысить сумму заказа', () => {
    const rules = api.upsertPromoRule('', 'BIG 90').serialized;
    const r = api.evaluatePromo(rules, 'BIG', [{ id: 2, qty: 1 }], lookup);
    assert.equal(r.ok, true);
    assert.equal(r.discountRub, 45000);
    assert.equal(r.total, 5000);
    assert.equal(r.total, Math.max(0, r.subtotal - r.discountRub));
  });

  it('админ добавляет и убирает код, правило переживает перезапуск', () => {
    const added = api.upsertPromoRule(RULES, 'vip20 20 garmin min100000');
    assert.equal(added.ok, true);
    assert.equal(added.code, 'VIP20');
    assert.equal(added.percent, 20);
    assert.equal(added.brand, 'GARMIN');
    assert.equal(added.minTotal, 100000);
    assert.ok(added.serialized.includes('VIP20=20:GARMIN:min100000'), added.serialized);

    const r = api.evaluatePromo(added.serialized, 'vip20', [{ id: 1, qty: 1 }], lookup);
    assert.equal(r.discountRub, 20000);

    const removed = api.removePromoRule(added.serialized, 'VIP20');
    assert.equal(removed.ok, true);
    assert.equal(api.parsePromoRules(removed.serialized).has('VIP20'), false);
    assert.match(api.removePromoRule(RULES, 'неттакого').error, /нет/i);

    assert.equal(api.upsertPromoRule(RULES, 'X 10').ok, false, 'код короче двух символов');
    assert.equal(api.upsertPromoRule(RULES, 'LONGCODE 95').error.includes('90'), true, 'процент больше 90 не проходит');
  });

  it('список для админа называет код, процент и условия', () => {
    const text = flat(api.promoRulesText(RULES));
    assert.match(text, /Промокоды витрины \(3\)/);
    assert.match(text, /• WATCH10 — −10%/);
    assert.match(text, /• GARMIN5 — −5% \(только GARMIN\)/);
    assert.match(text, /• VIP15 — −15% \(от 50 000 ₽\)/);
    assert.equal(api.promoRulesText('РАЗБЕРИ-МЕНЯ=abc'), 'Активных промокодов нет.', 'неразобранное правило не показывается');
  });

  it('по умолчанию в магазине работают три кода из сборки', () => {
    const map = api.parsePromoRules('');
    assert.deepEqual([...map.keys()], ['WATCH10', 'GARMIN5', 'VIP15']);
    assert.equal(api.DEFAULT_PROMO_RULES, RULES);
  });
});
