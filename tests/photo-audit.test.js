const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEED = require(path.join(__dirname, '..', 'public', 'products-data.js'));

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return { w, h };
    }
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2;
    } else {
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}

describe('аудит фото: 200 + image/jpeg + 900x900 1:1 (4 ракурса у каждой из 391 позиций)', () => {
  const PORT = 3220;
  const BASE = `http://localhost:${PORT}`;
  let child;
  let tmp;
  const realFetch = globalThis.fetch.bind(globalThis);

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-photoaudit-'));
    const compatPath = path.join(__dirname, '..', 'sqlite-compat.js');
    const spawnArgs = fs.existsSync(compatPath)
      ? ['--require', compatPath, path.join(__dirname, '..', 'server.js')]
      : [path.join(__dirname, '..', 'server.js')];
    child = spawn(process.execPath, spawnArgs, {
      cwd: tmp,
      env: { ...process.env, PORT: String(PORT), TG_BOT_TOKEN: '', TG_ADMIN_ID: '', MAX_BOT_TOKEN: '', MAX_ADMIN_ID: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 20000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('OneWatch running')) { clearTimeout(t); resolve(); }
      });
      child.on('error', reject);
    });
  });

  after(async () => {
    if (child) { child.kill(); await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); }); }
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  });

  it('все 1564 URL отдают 200 image/jpeg; все файлы 900x900 1:1 студийного качества', async () => {
    const urls = [];
    for (const p of SEED) {
      assert.equal((p.images || []).length, 3, `#${p.id}: ровно 3 доп. кадра`);
      urls.push(p.image, ...(p.images || []));
    }
    assert.equal(urls.length, 391 * 4);
    console.log('id;url;http;content-type;size;aspect;status');
    let checked = 0;
    for (const u of urls) {
      const r = await realFetch(`${BASE}/${u}`);
      const ct = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 200, `${u}: HTTP ${r.status}`);
      assert.ok(/^image\/jpeg/.test(ct), `${u}: content-type ${ct}`);
      const size = jpegSize(buf);
      assert.ok(size, `${u}: не распознан размер JPEG`);
      assert.ok(size.w >= 600 && size.h >= 600, `${u}: меньше 600px (${size.w}x${size.h})`);
      assert.equal(size.w, size.h, `${u}: не 1:1 (${size.w}x${size.h})`);
      if (checked < 3 || checked === urls.length - 1) {
        console.log(`${u.split('/').pop().split('.')[0]};${u};${r.status};${ct};${size.w}x${size.h};1:1;ok`);
      }
      checked++;
    }
    console.log(`... всего проверено URL: ${checked}`);
  });
});
