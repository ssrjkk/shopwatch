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

  it('robots.txt и sitemap.xml зеркалятся в корень для Pages', () => {
    for (const f of ['robots.txt', 'sitemap.xml']) {
      const a = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const b = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
      assert.equal(a, b, `${f} разошёлся — прогони npm run sync:pages`);
    }
    const robots = fs.readFileSync(path.join(__dirname, '..', 'robots.txt'), 'utf8');
    assert.match(robots, /^User-agent: \*/m, 'robots без User-agent');
    assert.match(robots, /sitemap\.xml/, 'robots без ссылки на sitemap');
    const sm = fs.readFileSync(path.join(__dirname, '..', 'sitemap.xml'), 'utf8');
    assert.match(sm, /https:\/\/example\.invalid\/demo\//, 'sitemap без канонического URL');
  });

  it('соцкарточки и фавикон на месте, в витрине нет чужих хотлинков', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image"'), 'нет twitter:card');
    assert.ok(html.includes('<link rel="icon" href="data:image/svg+xml,'), 'нет фавикона');
    assert.ok(!html.includes('images.unsplash.com'), 'в витрине остался хотлинк Unsplash');
    assert.ok(!html.includes('pitergsm.ru'), 'в витрине остался хотлинк PiterGSM');
    assert.ok(html.includes('uploads/demo/ph-1.svg'), 'og:image не на локальном демо-фото');
  });
});
