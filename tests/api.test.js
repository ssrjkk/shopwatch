const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('HTTP API (real server, temp DB)', () => {
  const PORT = 3217;
  const BASE = `http://localhost:${PORT}`;
  let child;
  let tmp;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-test-'));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: tmp, // watchop.db тестового запуска создастся здесь, боевая БД не затрагивается
      env: { ...process.env, PORT: String(PORT), TG_BOT_TOKEN: '', TG_ADMIN_ID: '', MAX_BOT_TOKEN: '', MAX_ADMIN_ID: '', ORDER_COOLDOWN_MS: '300' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 15000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('Watchop running')) { clearTimeout(t); resolve(); }
      });
      child.on('error', reject);
    });
    // Атомарное списание остатков включено: тестовые заявки многократно берут id 1,
    // поднимаем сток временной базы, чтобы проверять логику заказов, а не остатки.
    try {
      const { DatabaseSync } = require('node:sqlite');
      const seedDb = new DatabaseSync(path.join(tmp, 'watchop.db'));
      try { seedDb.exec('UPDATE products SET stock = 1000'); } catch (e) {}
      seedDb.close();
    } catch (e) {}
  });

  after(async () => {
    if (child) {
      child.kill();
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
    }
    if (tmp) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* locked files on Win, tmp is harmless */ }
    }
  });

  it('GET /api/state returns settings and products', async () => {
    const r = await fetch(`${BASE}/api/state`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(d.settings.hero_title);
    assert.equal(d.settings.payment_details, undefined);
    assert.ok(Array.isArray(d.products) && d.products.length >= 300);
  });

  it('доставка нормализуется по настройке delivery_methods', async () => {
    const st = await (await fetch(BASE + '/api/state')).json();
    assert.ok(typeof st.settings.delivery_methods === 'string' && st.settings.delivery_methods.includes('СДЭК'), 'настройка видна витрине');
    await new Promise((r) => setTimeout(r, 600));
    const bad = await fetch(BASE + '/api/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 1, qty: 1 }], customer: { fio: 'Тест', phone: '+7 900 000-00-00', delivery: 'Дроном' } }),
    });
    assert.equal(bad.status, 200);
  });

  it('POST /api/order creates TG-XXXX without payment details', async () => {
    await new Promise((r) => setTimeout(r, 600)); // после заказа из теста доставок
    const r = await fetch(`${BASE}/api/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 1, name: 'Test', price: 1000, qty: 1 }], total: 1000, customer: { fio: 'Test', phone: '+7 900 000-00-00' } }),
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.match(d.orderCode, /^TG-\d+$/);
    assert.equal(d.paymentDetails, undefined);
    assert.ok(typeof d.total === 'number');
  });

  it('immediate second order is rate-limited (429)', async () => {
    const body = JSON.stringify({ items: [{ id: 1, name: 'Test', price: 1000, qty: 1 }], total: 1000, customer: { fio: 'Test', phone: '+7 900 000-00-05' } });
    const post = () => fetch(`${BASE}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    await new Promise((r) => setTimeout(r, 600)); // ждём конца кулдауна от предыдущей заявки
    const first = await post();
    assert.equal(first.status, 200, 'первая заявка проходит');
    const second = await post();
    assert.equal(second.status, 429);
    assert.ok((await second.json()).error.includes('Слишком быстро'));
  });

  it('empty cart is rejected (400), bad initData is rejected (403)', async () => {
    await new Promise((r) => setTimeout(r, 600)); // ждем конца антиспам-кулдауна от прошлых заявок
    const r1 = await fetch(`${BASE}/api/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [], total: 0 }),
    });
    assert.equal(r1.status, 400);
    await new Promise((r) => setTimeout(r, 600)); // пустая заявка тоже ставит кулдаун
    const r2 = await fetch(`${BASE}/api/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 1, name: 'T', price: 1, qty: 1 }], total: 1, customer: { fio: 'T', phone: '+7 900 000-00-03' }, initData: 'x=1&hash=y' }),
    });
    assert.equal(r2.status, 403);
  });

  it('server reprices from DB and rejects bad items', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const post = (body) => fetch(`${BASE}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // подмененная клиентом цена игнорируется: сервер считает по своей БД
    const st = await (await fetch(`${BASE}/api/state`)).json();
    const p1 = st.products.find((p) => p.id === 1);
    const cust = { fio: 'Test', phone: '+7 900 000-00-01' };
    const r1 = await post({ items: [{ id: 1, name: 'HACK', price: 1, qty: 2 }], total: 5, customer: cust });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).total, p1.price * 2);
    await new Promise((r) => setTimeout(r, 600));
    // несуществующий товар
    const r2 = await post({ items: [{ id: 999999, price: 1, qty: 1 }], total: 1 });
    assert.equal(r2.status, 400);
    await new Promise((r) => setTimeout(r, 600));
    // больше 50 позиций
    const r3 = await post({ items: Array.from({ length: 51 }, () => ({ id: 1, price: 1, qty: 1 })), total: 51 });
    assert.equal(r3.status, 400);
    // тело больше лимита 100kb
    const r4 = await post({ items: [{ id: 1, price: 1, qty: 1 }], total: 1, pad: 'x'.repeat(150000) });
    assert.equal(r4.status, 413);
  });

  it('order requires customer name and phone', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const post = (body) => fetch(`${BASE}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r1 = await post({ items: [{ id: 1, qty: 1 }], total: 1 });
    assert.equal(r1.status, 400);
    await new Promise((r) => setTimeout(r, 600));
    const r2 = await post({ items: [{ id: 1, qty: 1 }], total: 1, customer: { fio: 'Иван' } });
    assert.equal(r2.status, 400);
    await new Promise((r) => setTimeout(r, 600));
    const r3 = await post({ items: [{ id: 1, qty: 1 }], total: 1, customer: { fio: 'Иван', phone: '+7 900 000-00-02', delivery: 'Почта России', address: 'г. Тест' } });
    assert.equal(r3.status, 200);
    assert.match((await r3.json()).orderCode, /^TG-\d+$/);
    await new Promise((r) => setTimeout(r, 600));
    // телефон из одних букв — менеджер не дозвонится, заявку не принимаем
    const r4 = await post({ items: [{ id: 1, qty: 1 }], total: 1, customer: { fio: 'Иван', phone: 'абвгдежзкл' } });
    assert.equal(r4.status, 400);
    assert.match((await r4.json()).error, /телефон/i);
  });

  it('customer поля только строки: объект или число вместо текста — 400', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const post = (body) => fetch(`${BASE}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // Без проверки типов String({...}) дал бы «[object Object]» в заявке, а число
    // превратилось бы в строку и прошло дальше в уведомление админу.
    for (const [i, customer] of [
      { fio: { name: 'Иван' }, phone: '+7 900 000-00-10' },
      { fio: 'Иван', phone: 7900000011 },
      { fio: 'Иван', phone: '+7 900 000-00-12', address: ['г. Тест'] },
      { fio: 'Иван', phone: '+7 900 000-00-13' },
    ].entries()) {
      await new Promise((r) => setTimeout(r, 600));
      const r = await post({ items: [{ id: 1, qty: 1 }], total: 1, customer });
      if (i === 3) {
        assert.equal(r.status, 200, `обычная заявка проходит, ответ: ${await r.text()}`);
      } else {
        assert.equal(r.status, 400, `кейс ${i}`);
        assert.match((await r.json()).error, /Некорректные данные покупателя/);
      }
    }
  });

  it('GET /healthz reports ok with counters', async () => {
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true);
    assert.ok(d.products > 0);
    assert.ok(typeof d.uptime === 'number');
  });

  it('serves the storefront and 404s missing uploads', async () => {
    const r1 = await fetch(`${BASE}/`);
    assert.equal(r1.status, 200);
    assert.ok((await r1.text()).includes('products-grid'));
    const r2 = await fetch(`${BASE}/uploads/nope.jpg`);
    assert.equal(r2.status, 404);
    // имя файла уникально на каждую загрузку, поэтому кэш можно давать навсегда
    const photo = await fetch(`${BASE}/uploads/watch_1793534071570.jpg`);
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get('cache-control') || '', /max-age=31536000/);
    assert.match(photo.headers.get('cache-control') || '', /immutable/);
    const html = await fetch(`${BASE}/`);
    assert.doesNotMatch(html.headers.get('cache-control') || '', /immutable/, 'витрина должна обновляться сразу');
  });

  it('тело в cp1251 доходит до базы нормальными буквами, а не «?????»', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const http = require('node:http');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    // 'Иванов Пётр' и 'Москва' в cp1251 — как их прислал бы старый терминал или Excel
    const fio = Buffer.from([0xC8, 0xE2, 0xE0, 0xED, 0xEE, 0xE2, 0x20, 0xCF, 0xB8, 0xF2, 0xF0]);
    const city = Buffer.from([0xCC, 0xEE, 0xF1, 0xEA, 0xE2, 0xE0]);
    const body = Buffer.concat([
      Buffer.from('{"items":[{"id":1,"qty":1}],"customer":{"fio":"', 'utf8'),
      fio,
      Buffer.from('","phone":"+7 900 000-04-32","address":"', 'utf8'),
      city,
      Buffer.from('","delivery":"СДЭК"}}', 'utf8'),
    ]);
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${BASE}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(res.status, 200, res.text);
    const { orderCode } = JSON.parse(res.text);
    const readDb = new DatabaseSync(path.join(tmp, 'watchop.db'));
    readDb.exec('PRAGMA busy_timeout = 5000');
    const row = readDb.prepare('SELECT customer_json FROM orders WHERE order_code = ?').get(orderCode);
    readDb.close();
    const cust = JSON.parse(row.customer_json || '{}');
    assert.equal(cust.fio, 'Иванов Пётр', JSON.stringify(cust));
    assert.equal(cust.address, 'Москва', JSON.stringify(cust));
    assert.equal(cust.delivery, 'СДЭК');
  });

  it('сжимает текст (brotli/gzip) и не трогает картинки', async () => {
    const http = require('node:http');
    const zlib = require('node:zlib');
    const getRaw = (url, headers) => new Promise((resolve, reject) => {
      const req = http.request(url, { headers, method: 'GET' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });

    const plain = await getRaw(`${BASE}/api/state`, {});
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined, 'без Accept-Encoding — обычные байты');
    assert.ok(JSON.parse(plain.body.toString('utf8')).products.length > 0);

    const gz = await getRaw(`${BASE}/api/state`, { 'Accept-Encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.ok(gz.body.length < plain.body.length * 0.4, `gzip ${gz.body.length} vs raw ${plain.body.length}`);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body).toString('utf8')).products.length, JSON.parse(plain.body.toString('utf8')).products.length);

    const plainHtml = await getRaw(`${BASE}/`, {});
    assert.equal(plainHtml.status, 200);
    const br = await getRaw(`${BASE}/`, { 'Accept-Encoding': 'br, gzip' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.ok(br.body.length < plainHtml.body.length * 0.3, `брокер HTML после brotli: ${br.body.length} из ${plainHtml.body.length}`);

    const catalog = await getRaw(`${BASE}/products-data.js`, { 'Accept-Encoding': 'gzip' });
    assert.equal(catalog.headers['content-encoding'], 'gzip', 'JS каталога тоже жмётся');
    const missing = await getRaw(`${BASE}/uploads/nope.jpg`, { 'Accept-Encoding': 'gzip' });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['content-encoding'], undefined, '404 не оборачиваем');

    const etag = plain.headers.etag;
    assert.ok(etag, 'ETag должен остаться');
    const conditional = await getRaw(`${BASE}/api/state`, { 'If-None-Match': etag });
    assert.equal(conditional.status, 304, 'условный запрос экономит трафик');
  });

  it('Trade-In: заявка без товаров, статус только по коду и телефону', async () => {
    const post = (body) => fetch(`${BASE}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await new Promise((r) => setTimeout(r, 600));
    const bad = await post({ items: [], tradein: { model: '  ', cond: '2' }, customer: { fio: 'Иван', phone: '+7 900 000-00-14' } });
    assert.equal(bad.status, 400);
    await new Promise((r) => setTimeout(r, 600));
    const r = await post({ items: [], tradein: { model: 'Garmin Fenix 5', year: '2018', cond: '3', productId: 1 }, customer: { fio: 'Иван', phone: '+7 900 000-00-14' } });
    const created = await r.json();
    assert.equal(r.status, 200, JSON.stringify(created));
    const { orderCode } = created;
    assert.match(orderCode, /^TG-\d+$/);
    const st = await fetch(`${BASE}/api/order-status?code=${orderCode}&pt=0014`);
    assert.equal(st.status, 200);
    assert.equal((await st.json()).status, 'Trade-In');
    const stranger = await fetch(`${BASE}/api/order-status?code=${orderCode}&pt=9999`);
    assert.equal(stranger.status, 404);
    const noPhone = await fetch(`${BASE}/api/order-status?code=${orderCode}`);
    assert.equal(noPhone.status, 400);
    const missing = await fetch(`${BASE}/api/order-status?code=TG-999999&pt=0014`);
    assert.equal(missing.status, 404);
  });

  it('промокод считает сервер: /api/promo-check и итог заказа со скидкой', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const st = await (await fetch(`${BASE}/api/state`)).json();
    const p = st.products[0];
    const expectDisc = Math.round(Math.round(p.price * 0.1) / 10) * 10;

    const ok = await post('/api/promo-check', { code: 'watch10', items: [{ id: p.id, qty: 1 }] });
    assert.equal(ok.status, 200);
    const d = await ok.json();
    assert.equal(d.code, 'WATCH10', 'код нормализуется к верхнему регистру');
    assert.equal(d.percent, 10);
    assert.equal(d.discount, expectDisc);
    assert.equal(d.total, p.price - expectDisc);

    const bad = await post('/api/promo-check', { code: 'NETAKOGO', items: [{ id: p.id, qty: 1 }] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /не найден или истёк/);

    const empty = await post('/api/promo-check', { code: 'WATCH10', items: [] });
    assert.equal(empty.status, 400);

    // цены для расчёта берутся из базы: подставленный в items price игнорируется
    const hacked = await post('/api/promo-check', { code: 'WATCH10', items: [{ id: p.id, qty: 1, price: 10 }] });
    assert.equal((await hacked.json()).discount, expectDisc, 'скидка считается от цены базы, а не из запроса');

    await new Promise((r) => setTimeout(r, 600));
    const ord = await post('/api/order', { items: [{ id: p.id, qty: 1 }], total: p.price, promo: 'WATCH10', customer: { fio: 'Промо Тест', phone: '+7 900 000-00-02' } });
    assert.equal(ord.status, 200);
    const od = await ord.json();
    assert.match(od.orderCode, /^TG-\d+$/);
    assert.equal(od.promo, 'WATCH10');
    assert.equal(od.discount, expectDisc);
    assert.equal(od.total, p.price - expectDisc, 'покупателю и в заявке уходит сумма после скидки');

    await new Promise((r) => setTimeout(r, 600));
    const badOrder = await post('/api/order', { items: [{ id: p.id, qty: 1 }], total: p.price, promo: 'NETAKOGO', customer: { fio: 'Промо Тест', phone: '+7 900 000-00-03' } });
    assert.equal(badOrder.status, 400, 'несуществующий код не оформляет заказ молча');
    assert.match((await badOrder.json()).error, /не найден/);
  });
});
