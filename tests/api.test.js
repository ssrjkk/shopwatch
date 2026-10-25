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
      env: { ...process.env, PORT: String(PORT), TG_BOT_TOKEN: '', TG_ADMIN_ID: '', MAX_BOT_TOKEN: '', MAX_ADMIN_ID: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 15000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('Watchop running')) { clearTimeout(t); resolve(); }
      });
      child.on('error', reject);
    });
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
    assert.ok(Array.isArray(d.products) && d.products.length > 0);
  });

  it('POST /api/order creates TG-XXXX with payment details', async () => {
    const r = await fetch(`${BASE}/api/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 1, name: 'Test', price: 1000, qty: 1 }], total: 1000 }),
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.match(d.orderCode, /^TG-\d+$/);
    assert.ok(typeof d.paymentDetails === 'string');
  });

  it('immediate second order is rate-limited (429)', async () => {
    const body = JSON.stringify({ items: [{ id: 1, name: 'Test', price: 1000, qty: 1 }], total: 1000 });
    const r = await fetch(`${BASE}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 429);
    assert.ok((await r.json()).error.includes('Слишком быстро'));
  });

  it('empty cart is rejected (400), bad initData is rejected (403)', async () => {
    await new Promise((r) => setTimeout(r, 5200)); // ждем конца антиспам-кулдауна от прошлых заявок
    const r1 = await fetch(`${BASE}/api/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [], total: 0 }),
    });
    assert.equal(r1.status, 400);
    await new Promise((r) => setTimeout(r, 5200)); // пустая заявка тоже ставит кулдаун
    const r2 = await fetch(`${BASE}/api/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 1, name: 'T', price: 1, qty: 1 }], total: 1, initData: 'x=1&hash=y' }),
    });
    assert.equal(r2.status, 403);
  });

  it('serves the storefront and 404s missing uploads', async () => {
    const r1 = await fetch(`${BASE}/`);
    assert.equal(r1.status, 200);
    assert.ok((await r1.text()).includes('products-grid'));
    const r2 = await fetch(`${BASE}/uploads/nope.jpg`);
    assert.equal(r2.status, 404);
  });
});
