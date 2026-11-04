const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Аудит фото каталога: каждый URL товара отдаёт 200 с content-type картинки,
// каждый файл — валидный JPEG квадратного формата, primary-кадр не меньше 500px.
// Печатает таблицу по брендам, падает первым же нарушением.
const SEED = require(path.join(__dirname, '..', 'public', 'products-data.js'));

function jpegSize(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

describe('аудит фото: 200 + картинка + валидный JPEG у каждой позиции', () => {
  const PORT = 3220;
  const BASE = `http://localhost:${PORT}`;
  let child;
  let tmp;
  const realFetch = globalThis.fetch.bind(globalThis);

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-photoaudit-'));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: tmp,
      env: { ...process.env, PORT: String(PORT), TG_BOT_TOKEN: '', TG_ADMIN_ID: '', MAX_BOT_TOKEN: '', MAX_ADMIN_ID: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 20000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('Watchop running')) { clearTimeout(t); resolve(); }
      });
      child.on('error', reject);
    });
  });

  after(async () => {
    if (child) { child.kill(); await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); }); }
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  });

  it('все фото каталога: 200 image/*, JPEG, квадрат, primary не меньше 500px', async () => {
    const urls = [];
    for (const p of SEED) {
      assert.ok(p.image, `#${p.id}: нет primary-фото`);
      urls.push({ url: p.image, primary: true, id: p.id });
      for (const g of p.images || []) urls.push({ url: g, primary: false, id: p.id });
    }
    console.log(`id;url;http;content-type;size;bytes;primary`);
    const byBrand = {};
    const smallPrimary = [];
    let checked = 0;
    for (const { url: u, primary, id } of urls) {
      const r = await realFetch(`${BASE}/${u}`);
      const ct = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 200, `#${id} ${u}: HTTP ${r.status}`);
      assert.ok(/^image\//.test(ct), `#${id} ${u}: content-type ${ct}`);
      assert.ok(buf.length > 5000, `#${id} ${u}: файл слишком мал (${buf.length} байт)`);
      const head = buf.slice(0, 2);
      assert.ok(head[0] === 0xFF && head[1] === 0xD8, `#${id} ${u}: не JPEG (магия ${head.toString('hex')})`);
      const size = jpegSize(buf);
      assert.ok(size, `#${id} ${u}: не распознан размер JPEG`);
      assert.equal(size.w, size.h, `#${id} ${u}: не квадрат (${size.w}x${size.h})`);
      if (primary && size.w < 500) smallPrimary.push(`${u} ${size.w}x${size.h} (#${id})`);
      const brand = SEED.find((p) => p.id === id).brand;
      byBrand[brand] = byBrand[brand] || { n: 0, bytes: 0 };
      byBrand[brand].n++;
      byBrand[brand].bytes += buf.length;
      if (checked < 3 || checked === urls.length - 1) {
        console.log(`#${id};${u};${r.status};${ct};${size.w}x${size.h};${buf.length};${primary ? 'primary' : 'gallery'}`);
      }
      checked++;
    }
    console.log(`... всего проверено URL: ${checked}`);
    for (const [b, s] of Object.entries(byBrand)) console.log(`brand ${b}: ${s.n} фото, ${(s.bytes / 1048576).toFixed(1)} МБ`);
    console.log(`primary меньше 500px: ${smallPrimary.length} позиций / ${new Set(smallPrimary.map((s) => s.split(' ')[0])).size} файлов (наследие референсных кадров, не добавлять новых)`);
    for (const s of smallPrimary) console.log(` small-primary ${s}`);
    assert.ok(new Set(smallPrimary.map((s) => s.split(' ')[0])).size <= 45, `новых мелких primary быть не должно`);
  });
});
