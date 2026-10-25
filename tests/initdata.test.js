const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { extractVerifyFn } = require('./helpers/load');

function isValidEnv(val) {
  return val && typeof val === 'string' && val.trim() !== '' && !val.startsWith('ВСТАВЬ_');
}

describe('verifyTelegramInitData (Mini App signature)', () => {
  let verify;
  before(() => {
    verify = eval(`(function(){ ${extractVerifyFn()}; return verifyTelegramInitData; })()`);
  });

  function sign(token, params) {
    const now = String(Math.floor(Date.now() / 1000));
    const withDate = { auth_date: now, ...params };
    const dcs = Object.entries(withDate).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    return new URLSearchParams({ ...withDate, hash }).toString();
  }

  it('rejects a stale signature (older than 24h)', () => {
    process.env.TG_BOT_TOKEN = 'test-token-abc';
    const old = { auth_date: String(Math.floor(Date.now() / 1000) - 90000), user: '{}' };
    const dcs = Object.entries(old).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update('test-token-abc').digest();
    const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    assert.equal(verify(new URLSearchParams({ ...old, hash }).toString()), null);
  });

  it('accepts a valid signature and returns the user', () => {
    process.env.TG_BOT_TOKEN = 'test-token-abc';
    const user = { id: 42, first_name: 'Ivan', username: 'ivan' };
    const initData = sign('test-token-abc', { query_id: 'q1', user: JSON.stringify(user) });
    assert.deepEqual(verify(initData), user);
  });

  it('rejects tampered data', () => {
    process.env.TG_BOT_TOKEN = 'test-token-abc';
    const user = { id: 42, username: 'ivan' };
    let initData = sign('test-token-abc', { user: JSON.stringify(user) });
    initData = initData.replace('ivan', 'petr');
    assert.equal(verify(initData), null);
  });

  it('rejects missing hash and empty input', () => {
    process.env.TG_BOT_TOKEN = 'test-token-abc';
    assert.equal(verify('auth_date=1'), null);
    assert.equal(verify(''), null);
    assert.equal(verify(null), null);
  });

  it('rejects when bot token is not configured', () => {
    process.env.TG_BOT_TOKEN = '';
    const initData = sign('test-token-abc', { user: '{}' });
    assert.equal(verify(initData), null);
  });
});
