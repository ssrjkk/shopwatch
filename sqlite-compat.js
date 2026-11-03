/**
 * sqlite-compat.js — Полифилл `node:sqlite` (DatabaseSync) для Node 18 / 20
 * и автономный встроенный фолбэк для `dotenv`, `cors`, `express`, `telegraf`,
 * если `node_modules` ещё не установлен (позволяет запускать `node server.js` и `npm test` из коробки).
 * Если в системе установлен Node 22.5+ и `node_modules`, используются нативные пакеты.
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const origLoad = Module._load;

let NativeSqlite = null;
try {
  NativeSqlite = origLoad.call(Module, 'node:sqlite', module, false);
} catch (e) {
  NativeSqlite = null;
}

function createSqlitePolyfill() {
  const uid = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const reqPipe = path.join(os.tmpdir(), `watchop_sql_req_${uid}`);
  const resPipe = path.join(os.tmpdir(), `watchop_sql_res_${uid}`);
  const pyScript = path.join(os.tmpdir(), `watchop_sql_srv_${uid}.py`);

  execSync(`mkfifo ${reqPipe} ${resPipe}`);

  fs.writeFileSync(
    pyScript,
    `import sqlite3, json, sys, os

req_path = sys.argv[1]
res_path = sys.argv[2]

dbs = {}
stmts = {}
next_db_id = 1
next_stmt_id = 1

req_f = open(req_path, 'r', encoding='utf-8')
res_f = open(res_path, 'w', encoding='utf-8')

while True:
    line = req_f.readline()
    if not line:
        break
    msg = json.loads(line)
    cmd = msg.get('cmd')
    try:
        if cmd == 'open':
            p = msg['path']
            conn = sqlite3.connect(p, isolation_level=None, check_same_thread=False, timeout=10.0)
            conn.row_factory = sqlite3.Row
            try:
                conn.execute("PRAGMA journal_mode = WAL")
                conn.execute("PRAGMA synchronous = NORMAL")
                conn.execute("PRAGMA busy_timeout = 5000")
            except Exception:
                pass
            did = next_db_id
            next_db_id += 1
            dbs[did] = conn
            res = {'ok': True, 'dbId': did}
        elif cmd == 'close':
            conn = dbs.pop(msg['dbId'], None)
            if conn:
                conn.close()
            res = {'ok': True}
        elif cmd == 'exec':
            conn = dbs[msg['dbId']]
            sql = msg['sql']
            s_strip = sql.strip().upper()
            if s_strip.startswith(('BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'VACUUM', 'PRAGMA')):
                for part in [p.strip() for p in sql.split(';') if p.strip()]:
                    conn.execute(part)
            else:
                conn.executescript(sql)
            res = {'ok': True}
        elif cmd == 'prepare':
            sid = next_stmt_id
            next_stmt_id += 1
            stmts[sid] = (msg['dbId'], msg['sql'])
            res = {'ok': True, 'stmtId': sid}
        elif cmd == 'run':
            did, sql = stmts[msg['stmtId']]
            conn = dbs[did]
            cur = conn.cursor()
            cur.execute(sql, msg['params'])
            res = {'ok': True, 'changes': cur.rowcount, 'lastInsertRowid': cur.lastrowid}
        elif cmd == 'get':
            did, sql = stmts[msg['stmtId']]
            conn = dbs[did]
            cur = conn.cursor()
            cur.execute(sql, msg['params'])
            row = cur.fetchone()
            res = {'ok': True, 'row': dict(row) if row is not None else None}
        elif cmd == 'all':
            did, sql = stmts[msg['stmtId']]
            conn = dbs[did]
            cur = conn.cursor()
            cur.execute(sql, msg['params'])
            rows = cur.fetchall()
            res = {'ok': True, 'rows': [dict(r) for r in rows]}
    except BaseException as e:
        res = {'ok': False, 'error': str(e)}
    res_f.write(json.dumps(res) + '\\n')
    res_f.flush()
`
  );

  const child = spawn('python3', ['-u', pyScript, reqPipe, resPipe], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();

  const reqFd = fs.openSync(reqPipe, 'w');
  const resFd = fs.openSync(resPipe, 'r');
  const readBuf = Buffer.alloc(65536);
  let leftover = '';

  function rpc(payload) {
    fs.writeSync(reqFd, JSON.stringify(payload) + '\n');
    while (true) {
      const nl = leftover.indexOf('\n');
      if (nl >= 0) {
        const line = leftover.slice(0, nl);
        leftover = leftover.slice(nl + 1);
        const parsed = JSON.parse(line);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed;
      }
      const n = fs.readSync(resFd, readBuf, 0, readBuf.length, null);
      if (n <= 0) throw new Error('SQLite bridge EOF');
      leftover += readBuf.toString('utf8', 0, n);
    }
  }

  function cleanupPipes() {
    try { fs.closeSync(reqFd); } catch (e) {}
    try { fs.closeSync(resFd); } catch (e) {}
    try { fs.unlinkSync(reqPipe); } catch (e) {}
    try { fs.unlinkSync(resPipe); } catch (e) {}
    try { fs.unlinkSync(pyScript); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
  process.on('exit', cleanupPipes);

  class StatementSync {
    constructor(stmtId) { this._id = stmtId; }
    run(...params) {
      const r = rpc({ cmd: 'run', stmtId: this._id, params });
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    }
    get(...params) {
      const r = rpc({ cmd: 'get', stmtId: this._id, params });
      return r.row === null ? undefined : r.row;
    }
    all(...params) {
      const r = rpc({ cmd: 'all', stmtId: this._id, params });
      return r.rows;
    }
  }

  class DatabaseSync {
    constructor(dbPath) {
      const r = rpc({ cmd: 'open', path: String(dbPath || ':memory:') });
      this._id = r.dbId;
    }
    exec(sql) { rpc({ cmd: 'exec', dbId: this._id, sql: String(sql) }); }
    prepare(sql) {
      const r = rpc({ cmd: 'prepare', dbId: this._id, sql: String(sql) });
      return new StatementSync(r.stmtId);
    }
    close() { rpc({ cmd: 'close', dbId: this._id }); }
  }

  return { DatabaseSync, StatementSync };
}

if (!NativeSqlite) {
  NativeSqlite = createSqlitePolyfill();
}

// Built-in minimal fallbacks when node_modules is not installed
const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function createExpressFallback() {
  function express() {
    const stack = [];
    const errorHandlers = [];

    const app = function (req, res) {
      const parsedUrl = new URL(req.url || '/', 'http://localhost');
      req.path = parsedUrl.pathname;
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      req.ip = xff || req.socket?.remoteAddress || '127.0.0.1';

      res.status = function (code) {
        res.statusCode = code;
        return res;
      };
      res.json = function (obj) {
        const body = Buffer.from(JSON.stringify(obj), 'utf8');
        if (!res.getHeader('Content-Type')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        const etag = '"' + crypto.createHash('sha1').update(body).digest('hex') + '"';
        if (!res.getHeader('ETag')) res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          return res.end();
        }
        return res.end(body);
      };

      let idx = 0;
      function next(err) {
        if (err) {
          for (const eh of errorHandlers) {
            try { return eh(err, req, res, () => {}); } catch (e) {}
          }
          res.statusCode = err.status || 500;
          return res.end(JSON.stringify({ error: err.message || 'Server error' }));
        }
        const layer = stack[idx++];
        if (!layer) {
          if (!res.headersSent) {
            res.statusCode = 404;
            res.end('Not Found');
          }
          return;
        }
        try {
          if (layer.type === 'mw') {
            if (layer.prefix && !req.path.startsWith(layer.prefix)) return next();
            const origPath = req.path;
            if (layer.prefix) req.path = req.path.slice(layer.prefix.length) || '/';
            const out = layer.fn(req, res, (e) => {
              req.path = origPath;
              next(e);
            });
            if (out && typeof out.catch === 'function') out.catch(next);
          } else if (layer.type === 'route') {
            let matched = false;
            if (req.method === layer.method) {
              if (req.path === layer.path) {
                req.params = {};
                matched = true;
              } else if (layer.path.includes(':')) {
                const keys = [];
                const rx = new RegExp('^' + layer.path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
                const m = req.path.match(rx);
                if (m) {
                  req.params = {};
                  keys.forEach((k, idx) => { req.params[k] = decodeURIComponent(m[idx + 1]); });
                  matched = true;
                }
              }
            }
            if (matched) {
              res.send = res.send || function (body) {
                const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
                return res.end(buf);
              };
              const out = layer.fn(req, res, next);
              if (out && typeof out.catch === 'function') out.catch(next);
            } else {
              return next();
            }
          }
        } catch (e) {
          next(e);
        }
      }
      next();
    };

    app.use = function (a, b) {
      if (typeof a === 'function') {
        if (a.length === 4) errorHandlers.push(a);
        else stack.push({ type: 'mw', prefix: '', fn: a });
      } else if (typeof a === 'string' && typeof b === 'function') {
        stack.push({ type: 'mw', prefix: a.replace(/\/$/, ''), fn: b });
      }
      return app;
    };
    app.set = function () { return app; };
    app.get = function (p, fn) { stack.push({ type: 'route', method: 'GET', path: p, fn }); return app; };
    app.post = function (p, fn) { stack.push({ type: 'route', method: 'POST', path: p, fn }); return app; };
    app.listen = function (port, host, cb) {
      const srv = http.createServer(app);
      if (typeof host === 'function') return srv.listen(port, host);
      if (host === '0.0.0.0') return srv.listen(port, cb);
      return srv.listen(port, host, cb);
    };
    return app;
  }

  express.json = function (opts = {}) {
    const maxBytes = opts.limit === '100kb' ? 102400 : 1048576;
    return function (req, res, next) {
      if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return next();
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on('data', (c) => {
        if (aborted) return;
        total += c.length;
        if (total > maxBytes) {
          aborted = true;
          const err = new Error('Payload Too Large');
          err.type = 'entity.too.large';
          err.status = 413;
          return next(err);
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        const buf = Buffer.concat(chunks);
        if (typeof opts.verify === 'function') {
          try { opts.verify(req, res, buf, 'utf8'); } catch (e) { return next(e); }
        }
        if (!buf.length) { req.body = {}; return next(); }
        try {
          req.body = JSON.parse(buf.toString('utf8'));
          return next();
        } catch (e) {
          const err = new Error('Invalid JSON');
          err.status = 400;
          return next(err);
        }
      });
    };
  };

  express.static = function (rootDir, opts = {}) {
    return function (req, res, next) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const rel = decodeURIComponent(req.path === '/' ? '/index.html' : req.path);
      if (rel.includes('..')) return next();
      const file = path.join(rootDir, rel);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return next();
        const buf = fs.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream');
        if (opts.immutable && opts.maxAge === '365d') {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=0');
        }
        const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          return res.end();
        }
        res.statusCode = 200;
        return res.end(buf);
      } catch (e) {
        return next();
      }
    };
  };

  return express;
}

const FALLBACK_MODULES = {
  dotenv: {
    config() {
      try {
        const envPath = path.join(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
          for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
          }
        }
      } catch (e) {}
      return {};
    },
  },
  cors: function () {
    return function (req, res, next) { next(); };
  },
  express: createExpressFallback(),
  telegraf: {
    Telegraf: class {
      constructor() { this.telegram = { getMe: async () => ({ username: 'bot' }), sendMessage: async () => ({}) }; }
      use() {}
      command() {}
      start() {}
      hears() {}
      action() {}
      on() {}
      launch() { return Promise.resolve(); }
      stop() {}
    },
    Markup: {
      button: {
        callback: (text, data) => ({ text, callback_data: data }),
        url: (text, url) => ({ text, url }),
        webApp: (text, url) => ({ text, web_app: { url } }),
      },
      inlineKeyboard: (rows) => ({ reply_markup: { inline_keyboard: rows } }),
      keyboard: (rows) => ({ resize: () => ({ reply_markup: { keyboard: rows, resize_keyboard: true } }) }),
    },
    session: () => (ctx, next) => next(),
  },
};

Module._load = function (request, parent, isMain) {
  if (request === 'node:sqlite' || request === 'sqlite') {
    return NativeSqlite;
  }
  try {
    return origLoad.apply(this, arguments);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && FALLBACK_MODULES[request]) {
      return FALLBACK_MODULES[request];
    }
    throw err;
  }
};

module.exports = NativeSqlite;
