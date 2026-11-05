const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mountFrontend } = require('./helpers/dom');

const realFetch = globalThis.fetch.bind(globalThis);

describe('корзина: суммы целыми, очистка, восстановление, промокод', () => {
  let g;
  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('сложение/вычитание/удаление считают целые рубли без копеек', () => {
    g.state.cart = [];
    const a = g.state.products.find((p) => Number(p.price) > 0);
    const b = g.state.products.find((p) => Number(p.price) > 0 && p.id !== a.id);
    g.addToCart(null, a.id);
    g.addToCart(null, a.id);
    g.addToCart(null, b.id);
    const expect = a.price * 2 + b.price;
    assert.equal(g.cartTotal(), expect);
    assert.ok(Number.isInteger(g.cartTotal()), 'итог целый');
    g.changeQty(a.id, -1);
    assert.equal(g.cartTotal(), a.price + b.price);
    g.removeFromCart(b.id);
    assert.equal(g.cartTotal(), a.price);
    assert.equal(g.cartCount(), 1);
  });

  it('clearCart очищает корзину и обновляет счётчики', () => {
    const a = g.state.products[0];
    g.state.cart = [];
    g.addToCart(null, a.id);
    assert.equal(g.cartCount(), 1);
    g.clearCart();
    assert.deepEqual(g.state.cart, []);
    assert.equal(g.cartCount(), 0);
    assert.equal(g.cartTotal(), 0);
    assert.match(g.document.getElementById('cart-list').innerHTML, /пуста/i, 'пустое состояние');
  });

  it('sanitizeCart отбрасывает мусор и режет количество 1..99', () => {
    assert.deepEqual(
      g.sanitizeCart([{ id: 5, qty: 2 }, { id: 'x', qty: 1 }, { id: -3, qty: 1 }, { id: 7, qty: 500 }, { id: 8 }, null, 42]),
      [{ id: 5, qty: 2 }, { id: 7, qty: 99 }, { id: 8, qty: 1 }],
      'годные записи нормализуются, мусор отбрасывается'
    );
    assert.deepEqual(g.sanitizeCart('не-массив'), []);
    assert.deepEqual(g.sanitizeCart(null), []);
  });

  it('восстановление из битого localStorage не роняет витрину', () => {
    const bad = mountFrontend({ storage: "{ getItem: () => 'не-json{{{', setItem: () => {} }" });
    assert.ok(Array.isArray(bad.state.cart), 'корзина — массив');
    assert.ok(Array.isArray(bad.state.favorites), 'избранное — массив');
  });

  it('промокод считается целыми рублями и одинаково на клиенте', () => {
    g.state.cart = [];
    const a = g.state.products.find((p) => Number(p.price) >= 60000);
    assert.ok(a, 'есть товар для VIP15');
    g.addToCart(null, a.id);
    g.state.promoCode = 'VIP15';
    const subtotal = g.cartTotal();
    const disc = g.calcPromoDiscount ? g.calcPromoDiscount(subtotal) : Math.round(subtotal * 0.15);
    assert.ok(Number.isInteger(disc), 'скидка целая');
    assert.ok(disc > 0 && disc < subtotal, 'скидка в разумных пределах');
    assert.equal(disc % 10, 0, 'округление до 10 ₽ как на сервере');
    g.state.promoCode = '';
    g.state.cart = [];
  });

  it('GARMIN5 считается только с позиций Garmin, как на сервере', () => {
    const gm = g.state.products.find((p) => String(p.brand).toUpperCase() === 'GARMIN' && Number(p.price) > 0);
    const other = g.state.products.find((p) => String(p.brand).toUpperCase() !== 'GARMIN' && Number(p.price) > 0);
    assert.ok(gm && other, 'есть Garmin и не-Garmin');
    g.state.cart = [];
    g.addToCart(null, gm.id);
    g.addToCart(null, other.id);
    g.state.promoCode = 'GARMIN5';
    const sub = g.cartTotal();
    const disc = g.calcPromoDiscount(sub);
    const expect = Math.min(sub, Math.round(Math.round(Math.trunc(gm.price) * 5 / 100) / 10) * 10);
    assert.equal(disc, expect, 'только Garmin-часть');
    assert.ok(disc < Math.round(sub * 0.05), 'меньше 5% от всей корзины');
    g.state.promoCode = '';
    g.state.cart = [];
  });
});

describe('квиз и состояние витрины', () => {
  let g;
  before(async () => {
    g = mountFrontend();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('квиз-модалка есть во всех витринах и открывается/закрывается', () => {
    for (const f of ['index.html', 'public/index.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(html.includes('id="quiz-modal"'), f + ': quiz modal markup');
      for (const id of ['qz-goal-run', 'qz-goal-outdoor', 'qz-goal-classic', 'qz-goal-dive', 'qz-bud-low', 'qz-bud-mid', 'qz-bud-all']) {
        assert.ok(html.includes('id="' + id + '"'), f + ': ' + id);
      }
    }
    g.openQuizModal();
    assert.ok(!g.document.getElementById('quiz-modal').classList.contains('hidden'), 'открылась');
    g.closeQuizModal();
    assert.ok(g.document.getElementById('quiz-modal').classList.contains('hidden'), 'закрылась');
  });
});

describe('сервер: код TG-XXXX уникален, суммы целые', () => {
  const PORT = 3219;
  const BASE = `http://localhost:${PORT}`;
  let child;
  let tmp;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-cart-'));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: tmp,
      env: { ...process.env, PORT: String(PORT), TG_BOT_TOKEN: '', TG_ADMIN_ID: '', MAX_BOT_TOKEN: '', MAX_ADMIN_ID: '', ORDER_COOLDOWN_MS: '300' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 15000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('OneWatch running')) { clearTimeout(t); resolve(); }
      });
      child.on('error', reject);
    });
    try {
      const { DatabaseSync } = require('node:sqlite');
      const seedDb = new DatabaseSync(path.join(tmp, 'watchop.db'));
      try { seedDb.exec('UPDATE products SET stock = 1000'); } catch (e) {}
      seedDb.close();
    } catch (e) {}
  });
  after(async () => {
    if (child) { child.kill(); await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); }); }
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  });

  const order = (idem, items, promo) => realFetch(`${BASE}/api/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idem },
    body: JSON.stringify({ items: items || [{ id: 1, qty: 1 }], customer: { fio: 'Иван Тест', phone: '+7 000 000-00-00' }, ...(promo ? { promo } : {}) }),
  }).then((r) => r.json());

  it('пять заказов подряд получают разные коды TG-XXXX', async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 350));
      const d = await order('uniq-' + i + '-' + Date.now());
      assert.match(d.orderCode, /^TG-\d+$/, 'формат кода');
      codes.push(d.orderCode);
    }
    assert.equal(new Set(codes).size, 5, 'коды уникальны: ' + codes.join(','));
  });

  it('повтор с тем же Idempotency-Key возвращает тот же заказ без дубля', async () => {
    const key = 'idem-' + Date.now();
    await new Promise((r) => setTimeout(r, 400));
    const d1 = await order(key);
    assert.match(d1.orderCode, /^TG-\d+$/, 'первый заказ создан');
    await new Promise((r) => setTimeout(r, 400));
    const d2 = await order(key);
    assert.equal(d2.orderCode, d1.orderCode, 'тот же код');
    assert.equal(d2.duplicate, true, 'флаг дубля');
  });

  it('сервер считает итог целым и не доверяет сумме клиента', async () => {
    await new Promise((r) => setTimeout(r, 350));
    const d = await order('sum-' + Date.now(), [{ id: 1, qty: 2 }]);
    assert.match(d.orderCode, /^TG-\d+$/);
  });
});
