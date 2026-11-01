const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { extractBackupBlock } = require('./helpers/load');

describe('backups and DB integrity', () => {
  let api;
  let memdb;
  let tmpdir;

  before(() => {
    memdb = new DatabaseSync(':memory:');
    memdb.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    memdb.prepare("INSERT INTO t (v) VALUES ('hello')").run();
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchop-backup-'));
    const saved = [];
    const api_new = new Function('db', 'fs', 'path', 'os', 'getSetting', 'setSetting', 'rootDir',
      `const __dirname = rootDir;\n${extractBackupBlock()}\nreturn { runBackup, checkDbIntegrity, handleBackupRequest };`
    )(memdb, fs, path, os, (k) => memdb.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '', (k, v) => memdb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v)), os.tmpdir());
    api = api_new;
  });

  it('VACUUM INTO создаёт читаемый файл с теми же данными', () => {
    const r = api.runBackup('test', { dir: tmpdir, conn: memdb, keep: 10 });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(r.file), 'файл бекапа создан');
    const copy = new DatabaseSync(r.file, { readonly: true });
    assert.equal(copy.prepare("SELECT v FROM t WHERE id = 1").get().v, 'hello', 'данные на месте');
    assert.equal(copy.prepare("SELECT COUNT(*) AS c FROM t").get().c, 1);
    copy.close();
  });

  it('ротация держит только N последних', () => {
    for (let i = 0; i < 5; i++) {
      const r = api.runBackup('test', { dir: tmpdir, conn: memdb, keep: 3 });
      assert.equal(r.ok, true);
    }
    const files = fs.readdirSync(tmpdir).filter((f) => /^watchop-.*\.db$/.test(f));
    assert.ok(files.length <= 3, `файлов: ${files.length}`);
  });

  it('integrity_check проходит на живой базе', () => {
    const r = api.checkDbIntegrity();
    assert.equal(r.ok, true);
  });

  it('последний бекап запоминается в settings', () => {
    api.runBackup('test', { dir: tmpdir, conn: memdb, keep: 10 });
    const v = memdb.prepare("SELECT value FROM settings WHERE key = 'last_backup_at'").get();
    assert.ok(v && !Number.isNaN(Date.parse(v.value)), 'last_backup_at — валидная дата');
  });

  it('кнопка Бекап БД присылает файл админу в личку', async () => {
    const sentDocs = [];
    const ctx = {
      from: { id: 1, username: 'admin' },
      reply: async (t) => 'replied:' + String(t).slice(0, 40),
      replyWithDocument: async (doc, extra) => { sentDocs.push({ file: doc.source, caption: (extra || {}).caption }); return true; },
    };
    const r = await api.handleBackupRequest(ctx);
    assert.equal(r, true, 'отправили документ');
    assert.equal(sentDocs.length, 1, 'документ отправлен');
    assert.ok(require('fs').existsSync(sentDocs[0].file), 'файл бекапа существует');
    assert.match(sentDocs[0].caption || '', /Бекап базы/);
    fs.rmSync(tmpdir, { recursive: true, force: true });
    const path = require('path');
    fs.rmSync(path.join(os.tmpdir(), 'backups'), { recursive: true, force: true });
  });
});
