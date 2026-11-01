const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractPublishBlock, extractRedactFn } = require('./helpers/load');

// План пуша — чистая функция: проверяем, чем именно бот соберётся пушить,
// не поднимая git и не трогая репозиторий.
function loadPublish() {
  const factory = new Function(`${extractPublishBlock()}\nreturn { PUBLISH_PATHS, publishPlan };`);
  return factory();
}

describe('Публикация каталога из бота', () => {
  it('без токена пушит через сохранённые креды origin, без токена в аргументах', () => {
    const { publishPlan } = loadPublish();
    const plan = publishPlan({});
    assert.deepEqual(plan.args, ['push', 'origin', 'HEAD:refs/heads/main']);
    assert.equal(plan.branch, 'main');
    assert.equal(plan.via, 'saved credentials');
    assert.equal(JSON.stringify(plan.args).includes('token'), false);
  });

  it('с токеном пушит явным URL и не переписывает remote', () => {
    const { publishPlan } = loadPublish();
    const plan = publishPlan({ GITHUB_PUSH_TOKEN: 'ghp_secret123' });
    assert.equal(plan.args[0], 'push');
    assert.equal(plan.args[1], 'https://x-access-token:ghp_secret123@github.com/ssrjkk/shopwatch.git');
    assert.equal(plan.args[2], 'HEAD:refs/heads/main');
    assert.equal(plan.via, 'GITHUB_PUSH_TOKEN');
    // ни одной команды, которая пишет секрет в конфиг репозитория
    assert.equal(plan.args.some((a) => /config|remote set-url/.test(String(a))), false);
  });

  it('удалённый репозиторий и ветка берутся из окружения', () => {
    const { publishPlan } = loadPublish();
    const plan = publishPlan({ GITHUB_PUSH_REMOTE: 'https://github.com/ssrjkk/other.git', GITHUB_PUSH_BRANCH: 'pages', GITHUB_PUSH_TOKEN: 'tok_12345678' });
    assert.equal(plan.branch, 'pages');
    assert.equal(plan.args[1], 'https://x-access-token:tok_12345678@github.com/ssrjkk/other.git');
    assert.equal(plan.args[2], 'HEAD:refs/heads/pages');
  });

  it('в коммит попадают только файлы витрины: ни базы, ни .env, ни -A', () => {
    const { PUBLISH_PATHS } = loadPublish();
    assert.deepEqual(PUBLISH_PATHS.slice().sort(), ['index.html', 'products-data.js', 'public/index.html', 'public/products-data.js', 'public/uploads', 'uploads'].sort());
    for (const forbidden of ['.', '..', '-A', '.', 'watchop.db', '.env', 'server.js', 'node_modules']) {
      assert.equal(PUBLISH_PATHS.includes(forbidden), false, `в список публикации не должен попадать ${forbidden}`);
    }
  });

  it('сообщения об ошибках git не содержат токенов', () => {
    const factory = new Function('process', `${extractRedactFn()}\nreturn redactSecrets;`);
    const real = process.env.GITHUB_PUSH_TOKEN;
    process.env.GITHUB_PUSH_TOKEN = 'ghp_supersecret_abcdef';
    try {
      const redact = factory(process);
      const leak = `remote: fatal: authentication failed for https://x-access-token:ghp_supersecret_abcdef@github.com/ssrjkk/shopwatch.git`;
      const out = redact(leak);
      assert.equal(out.includes('ghp_supersecret_abcdef'), false, out);
      assert.match(out, /x-access-token:\*\*\*@/);
      assert.equal(redact('bot123456:AAdeadbeefdeadbeef').includes('AAdeadbeefdeadbeef'), false);
    } finally {
      if (real === undefined) delete process.env.GITHUB_PUSH_TOKEN;
      else process.env.GITHUB_PUSH_TOKEN = real;
    }
  });
});
