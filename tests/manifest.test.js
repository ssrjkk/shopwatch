const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('PWA manifest: один сайт, витрина ссылается на него', () => {
  const pub = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.json'), 'utf8'));
  const root = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

  it('корень и public/ совпадают побайтово', () => {
    assert.equal(
      fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.json'), 'utf8'),
      'manifest.json разошёлся — прогони npm run sync:pages'
    );
  });

  it('обязательные поля на месте, цвета как у витрины', () => {
    for (const m of [pub, root]) {
      assert.ok(m.name && m.short_name, 'name/short_name');
      assert.equal(m.start_url, './index.html');
      assert.equal(m.display, 'standalone');
      assert.equal(m.theme_color, '#141619');
      assert.equal(m.background_color, '#F4F5F7');
    }
  });

  it('index.html подключает манифест', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('<link rel="manifest" href="manifest.json"'), 'нет <link rel=manifest>');
  });
});
