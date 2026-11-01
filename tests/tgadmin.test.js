const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractTgAdminBlock } = require('./helpers/load');

// Блок админов исполняется изолированно: свой process.env, свой tgBot-стаб и
// settings-стаб, чтобы проверять резолв юзернеймов, рассылку и управление
// списком админов без сети и без реальной базы.
function loadAdmin(env) {
  const sent = [];
  const settings = new Map();
  const tgBot = {
    telegram: {
      sendMessage: (id, text, options) => {
        sent.push({ id: String(id), text, options });
        return { catch: () => {} };
      },
    },
  };
  const fakeProcess = { env: { ...env } };
  const api = new Function(
    'process',
    'tgBot',
    'redactSecrets',
    'getSetting',
    'setSetting',
    `${extractTgAdminBlock()}
return { isTgAdminCtx, tgAdminIdList, tgAdminUsernameList, notifyTgAdmins, addTgAdminId, removeTgAdminId, addTgAdminUsername, removeTgAdminUsername, tgAdminRoster, loadTgAdminExtras };`
  )(fakeProcess, tgBot, (v) => v, (k) => settings.get(k) ?? '', (k, v) => settings.set(k, String(v)));
  return { ...api, sent, settings };
}

describe('TG admins: несколько админов по ID и юзернеймам', () => {
  it('ID через запятую — все админы, посторонний нет', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111, 222' });
    assert.equal(a.isTgAdminCtx({ from: { id: 222 } }), true);
    assert.equal(a.isTgAdminCtx({ from: { id: '111' } }), true);
    assert.equal(a.isTgAdminCtx({ from: { id: 333 } }), false);
  });

  it('юзернейм из TG_ADMIN_USERNAMES резолвится в ID при первом сообщении', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111', TG_ADMIN_USERNAMES: '@SheferochekGle' });
    assert.equal(a.isTgAdminCtx({ from: { id: '777', username: 'sheferochekgle' } }), true);
    assert.equal(a.tgAdminIdList().includes('777'), true);
    // резолв сохраняется в settings, чтобы переживать перезапуск
    assert.equal(a.settings.get('tg_extra_admin_ids'), '777');
    // дальше админа узнаём по ID даже без юзернейма в апдейте
    assert.equal(a.isTgAdminCtx({ from: { id: '777' } }), true);
    // регистр не важен
    assert.equal(a.isTgAdminCtx({ from: { id: '888', username: 'SHEFEROCHekgle' } }), true);
    const b = loadAdmin({ TG_ADMIN_ID: '111', TG_ADMIN_USERNAMES: 'sheferochekgle' });
    assert.equal(b.isTgAdminCtx({ from: { id: '999', username: 'someone_else' } }), false);
  });

  it('уведомления уходят всем резолвнутым админам', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111', TG_ADMIN_USERNAMES: 'sheferochekgle' });
    a.isTgAdminCtx({ from: { id: '777', username: 'sheferochekgle' } });
    a.notifyTgAdmins('заявка');
    assert.deepEqual(a.sent.map((s) => s.id).sort(), ['111', '777']);
    assert.equal(a.sent[0].text, 'заявка');
  });

  it('без админов в env ничего не падает и не шлётся', () => {
    const a = loadAdmin({});
    assert.equal(a.isTgAdminCtx({ from: { id: '777', username: 'sheferochekgle' } }), false);
    a.notifyTgAdmins('заявка');
    assert.equal(a.sent.length, 0);
  });

  it('ctx без from не админ', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111' });
    assert.equal(a.isTgAdminCtx({}), false);
    assert.equal(a.isTgAdminCtx(undefined), false);
  });

  it('админ добавляет и убирает админов из бота, список живёт в settings', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111' });
    assert.equal(a.addTgAdminId('777'), 'ok');
    assert.equal(a.addTgAdminUsername('ivan_petrov'), 'ok');
    assert.equal(a.tgAdminIdList().includes('777'), true);
    assert.equal(a.tgAdminUsernameList().includes('ivan_petrov'), true);
    assert.equal(a.settings.get('tg_extra_admin_ids'), '777');
    assert.equal(a.settings.get('tg_extra_admin_usernames'), 'ivan_petrov');

    // перезапуск: extras подхватываются из settings
    const b = loadAdmin({ TG_ADMIN_ID: '111' });
    b.settings.set('tg_extra_admin_ids', a.settings.get('tg_extra_admin_ids'));
    b.settings.set('tg_extra_admin_usernames', a.settings.get('tg_extra_admin_usernames'));
    b.loadTgAdminExtras();
    assert.equal(b.isTgAdminCtx({ from: { id: '777' } }), true);
    assert.equal(b.isTgAdminCtx({ from: { id: '1', username: 'ivan_petrov' } }), true);

    assert.equal(a.removeTgAdminId('777'), 'ok');
    assert.equal(a.removeTgAdminUsername('ivan_petrov'), 'ok');
    assert.equal(a.tgAdminIdList().includes('777'), false);
    assert.equal(a.tgAdminUsernameList().includes('ivan_petrov'), false);
    assert.equal(a.removeTgAdminId('777'), 'none');
  });

  it('админов из .env из бота не убрать и не задублировать', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111', TG_ADMIN_USERNAMES: 'boss' });
    assert.equal(a.addTgAdminId('111'), 'env');
    assert.equal(a.removeTgAdminId('111'), 'env');
    assert.equal(a.addTgAdminUsername('@boss'), 'env');
    assert.equal(a.removeTgAdminUsername('boss'), 'env');
    assert.equal(a.tgAdminIdList().length, 1);
  });

  it('валидация ввода: мусор не проходит', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111' });
    assert.equal(a.addTgAdminId('abc'), 'bad');
    assert.equal(a.addTgAdminId('12'), 'bad');
    assert.equal(a.addTgAdminUsername('a b'), 'bad');
    assert.equal(a.addTgAdminUsername('x'), 'bad');
    assert.equal(a.tgAdminIdList().length, 1);
    assert.equal(a.tgAdminUsernameList().length, 0);
  });

  it('ростер помечает источник каждого админа', () => {
    const a = loadAdmin({ TG_ADMIN_ID: '111', TG_ADMIN_USERNAMES: 'boss' });
    a.addTgAdminId('777');
    const rows = a.tgAdminRoster();
    assert.deepEqual(rows.find((r) => r.value === '111'), { source: '.env', kind: 'id', value: '111' });
    assert.deepEqual(rows.find((r) => r.value === 'boss'), { source: '.env', kind: 'username', value: 'boss' });
    assert.deepEqual(rows.find((r) => r.value === '777'), { source: 'бот', kind: 'id', value: '777' });
  });

  it('админка TG: бренд, доставки, категории, дизайн и ручная заявка проведены', () => {
    const { serverSrc } = require('./helpers/load');
    const src = serverSrc();
    const checks = [
      ["pf_(name|brand|series|category|price|stock|specs|image)", "правка бренда в карточке"],
      ["tgBot.action('ord_new'", "кнопка новой заявки"],
      ["step === 'ord_new_items'", "шаг состава заявки"],
      ["step === 'ord_new_fio'", "шаг ФИО заявки"],
      ["step === 'ord_new_phone'", "шаг телефона заявки"],
      ["createManualOrder(db,", "создание заявки через ядро"],
      ["tg_cfg_delivery_methods", "кнопка доставки в панели текстов"],
      ["tg_cfg_extra_categories", "кнопка категорий в панели текстов"],
      ["Дизайн", "пункт дизайна в админ-меню"],
      ["design_stealth", "кнопка дизайна stealth"],
      ["design_classic", "кнопка дизайна classic"],
      ["setStoreDesign(__dirname", "применение дизайна пишет файлы"],
    ];
    for (const [sub, what] of checks) assert.ok(src.includes(sub), what);
  });
});
