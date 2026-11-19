'use strict';

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const COOKIE = 'shadowblog_session';
const DAY = 86400000;
const SESSION_MS = 30 * DAY;
const cookieOptions = { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' };
const INVALID = 'This code is invalid / expired. Ask admin to Validate it.';
const DENIED = 'Access Denied - Owner Only';
const defaultRoles = [ ['Owner','#9b5800'], ['Admin','#1756b8'], ['Mod','#137445'], ['VIP','#7443a8'], ['Member','#555d6d'] ];
const seeds = [ ['MOON123', 'Moon Room', false], ['VIP99', 'VIP Room', false], ['ADMIN', 'Admin Chat', true] ];
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false },
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 4000, statement_timeout: 10000
}) : null;

function logError(context, error) {
  console.error(`[ShadowBlog] ${context}: ${error.code || error.message || String(error)}`);
}
pool?.on('error', error => logError('Idle database connection', error));
process.on('unhandledRejection', error => logError('Unhandled rejection', error || 'Unknown error'));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function access(room, user) {
  if (!room || !room.active) throw new HttpError(404, INVALID);
  if (room.admin_only && user.role !== 'Owner') throw new HttpError(403, DENIED);
}

const schema = `
  CREATE TABLE IF NOT EXISTS roles (name TEXT PRIMARY KEY, color TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS roles_lower_name ON roles (lower(name));
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    role TEXT NOT NULL REFERENCES roles(name), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS codes (
    id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, room TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
    admin_only BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY, room TEXT NOT NULL REFERENCES codes(code) ON DELETE CASCADE,
    username TEXT NOT NULL, role TEXT NOT NULL REFERENCES roles(name), text TEXT NOT NULL,
    client_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (room, username, client_id)
  );
  CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room, id);
  CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS comments_post_id ON comments(post_id, id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS memberships (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL REFERENCES codes(code) ON DELETE CASCADE,
    PRIMARY KEY (user_id, code)
  );
  CREATE TABLE IF NOT EXISTS app_meta (name TEXT PRIMARY KEY);
`;

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(rollback => logError('Rollback failed', rollback));
    throw error;
  } finally { client.release(); }
}
const rows = async (db, sql, ...params) => (await db.query(sql, params)).rows;
const one = async (...args) => (await rows(...args))[0];
async function ownerPassword(existing, save) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured && existing) return null;
  const password = configured || crypto.randomBytes(9).toString('base64url');
  if (Buffer.byteLength(password) > 72) throw new Error('ADMIN_PASSWORD must be at most 72 UTF-8 bytes');
  if (!existing || existing.role !== 'Owner' || !await bcrypt.compare(password, existing.password)) {
    await save(await bcrypt.hash(password, 10));
  }
  return !configured ? password : null;
}

const postgres = {
  async init() {
    return transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(581063211)');
      await db.query(schema);
      for (const [name, color] of defaultRoles) {
        await db.query('INSERT INTO roles(name, color) VALUES($1, $2) ON CONFLICT DO NOTHING', [name, color]);
      }
      const first = await one(db, `INSERT INTO app_meta(name) VALUES($1) ON CONFLICT DO NOTHING RETURNING name`, 'seed-rooms-v1');
      if (first) for (const seed of seeds) {
        await db.query('INSERT INTO codes(code, room, admin_only) VALUES($1, $2, $3) ON CONFLICT DO NOTHING', seed);
      }
      return ownerPassword(await one(db, 'SELECT * FROM users WHERE username = $1', 'admin'),
        password => db.query(`INSERT INTO users(username, password, role) VALUES($1, $2, 'Owner')
          ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role`, ['admin', password]));
    });
  },
  async prune() {
    await pool.query(`DELETE FROM messages WHERE created_at < now() - INTERVAL '14 days' OR id IN (
      SELECT id FROM (SELECT id, row_number() OVER(PARTITION BY room ORDER BY id DESC) AS place FROM messages) ranked WHERE place > 500
    )`);
    await pool.query(`DELETE FROM comments WHERE created_at < now() - INTERVAL '14 days' OR id IN (
      SELECT id FROM (SELECT id, row_number() OVER(PARTITION BY post_id ORDER BY id DESC) AS place FROM comments) ranked WHERE place > 200
    )`);
    await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  },
  user: username => one(pool, 'SELECT * FROM users WHERE username = $1', username),
  register: (username, password) => one(pool, `INSERT INTO users(username, password, role) VALUES($1, $2, 'Member')
    ON CONFLICT (username) DO NOTHING RETURNING id, username, role`, username, password),
  session: hash => one(pool, `SELECT u.id, u.username, u.role FROM users u JOIN sessions s ON s.user_id = u.id
    WHERE s.token_hash = $1 AND s.expires_at > now()`, hash),
  addSession: (hash, userId, expires) => pool.query('INSERT INTO sessions VALUES($1, $2, $3)', [hash, userId, expires]),
  endSession: hash => pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash]),
  codes: () => rows(pool, 'SELECT * FROM codes ORDER BY id'),
  createCode: (code, room, adminOnly) => one(pool, `INSERT INTO codes(code, room, admin_only) VALUES($1, $2, $3)
    ON CONFLICT (code) DO NOTHING RETURNING *`, code, room, adminOnly),
  setCode: (code, active) => one(pool, 'UPDATE codes SET active = $2 WHERE code = $1 RETURNING *', code, active),
  deleteCode: code => one(pool, 'DELETE FROM codes WHERE code = $1 RETURNING code', code),
  joined: user => rows(pool, `SELECT c.code, c.room FROM codes c JOIN memberships m ON m.code = c.code
    WHERE m.user_id = $1 AND c.active AND (NOT c.admin_only OR $2) ORDER BY c.id`, user.id, user.role === 'Owner'),
  join: (code, user) => transaction(async db => {
    const room = await one(db, 'SELECT * FROM codes WHERE code = $1 FOR SHARE', code);
    access(room, user);
    await db.query('INSERT INTO memberships VALUES($1, $2) ON CONFLICT DO NOTHING', [user.id, code]);
    return room;
  }),
  messages: (code, user, after, text, clientId) => transaction(async db => {
    // Serialize sends per room so a higher committed ID cannot skip an in-flight lower ID during polling.
    const room = text === undefined
      ? await one(db, 'SELECT * FROM codes WHERE code = $1 FOR SHARE', code)
      : await one(db, 'SELECT * FROM codes WHERE code = $1 FOR NO KEY UPDATE', code);
    access(room, user);
    if (user.role !== 'Owner' && !await one(db, 'SELECT 1 FROM memberships WHERE user_id = $1 AND code = $2', user.id, code)) {
      throw new HttpError(403, 'Join this room with its code first.');
    }
    if (text !== undefined) {
      return one(db, `WITH saved AS (
        INSERT INTO messages(room, username, role, text, client_id) VALUES($1, $2, $3, $4, $5)
        ON CONFLICT (room, username, client_id) DO UPDATE SET client_id = EXCLUDED.client_id RETURNING *
      ) SELECT saved.*, roles.color FROM saved JOIN roles ON roles.name = saved.role`, code, user.username, user.role, text, clientId);
    }
    if (after === null) return rows(db, `SELECT recent.*, roles.color FROM (
      SELECT * FROM messages WHERE room = $1 ORDER BY id DESC LIMIT 100
    ) recent JOIN roles ON roles.name = recent.role ORDER BY recent.id`, code);
    return rows(db, `SELECT m.*, roles.color FROM messages m JOIN roles ON roles.name = m.role
      WHERE m.room = $1 AND m.id > $2 ORDER BY m.id LIMIT 100`, code, after);
  }),
  comments: post => rows(pool, `SELECT * FROM (SELECT * FROM comments WHERE post_id = $1 ORDER BY id DESC LIMIT 200) recent ORDER BY id`, post),
  comment: (post, name, text) => one(pool, 'INSERT INTO comments(post_id, username, text) VALUES($1, $2, $3) RETURNING *', post, name, text),
  users: () => rows(pool, 'SELECT id, username, role FROM users ORDER BY username'),
  roles: () => rows(pool, 'SELECT name, color FROM roles ORDER BY name'),
  createRole: (name, color) => one(pool, 'INSERT INTO roles(name, color) VALUES($1, $2) ON CONFLICT DO NOTHING RETURNING *', name, color),
  setRole: (id, name) => one(pool, `UPDATE users SET role = roles.name FROM roles
    WHERE users.id = $1 AND users.role <> 'Owner' AND lower(roles.name) = lower($2) AND roles.name <> 'Owner'
    RETURNING users.id, users.username, users.role`, id, name)
};

function memoryStore() {
  const users = new Map(), sessions = new Map(), codes = new Map(), roles = new Map();
  const memberships = new Map(), messages = new Map(), comments = new Map();
  let uid = 0, cid = 0, mid = 0, commentId = 0;
  const now = () => new Date();
  const view = ({ id, username, role }) => ({ id, username, role });
  function createCode(code, room, admin_only) {
    if (codes.has(code)) return;
    const record = { id: ++cid, code, room, admin_only, active: true, created_at: now() };
    codes.set(code, record);
    return record;
  }
  function pruneLists(map, limit) {
    const cutoff = Date.now() - 14 * DAY;
    for (const [key, list] of map) {
      const kept = list.slice(-limit).filter(item => item.created_at.getTime() >= cutoff);
      if (kept.length) map.set(key, kept); else map.delete(key);
    }
  }
  return {
    async init() {
      for (const [name, color] of defaultRoles) roles.set(name.toLowerCase(), { name, color });
      seeds.forEach(seed => createCode(...seed));
      return ownerPassword(users.get('admin'), password => {
        users.set('admin', { id: ++uid, username: 'admin', password, role: 'Owner', created_at: now() });
      });
    },
    prune() {
      pruneLists(messages, 500);
      pruneLists(comments, 200);
      for (const [hash, session] of sessions) if (session.expires <= Date.now()) sessions.delete(hash);
    },
    user: name => users.get(name),
    register(username, password) {
      if (users.has(username)) return;
      const record = { id: ++uid, username, password, role: 'Member', created_at: now() };
      users.set(username, record);
      return view(record);
    },
    session(hash) {
      const record = sessions.get(hash);
      if (record && record.expires > Date.now()) return view(record.user);
    },
    addSession(hash, id, expires) { sessions.set(hash, { user: [...users.values()].find(u => u.id === id), expires }); },
    endSession: hash => sessions.delete(hash),
    codes: () => [...codes.values()],
    createCode,
    setCode(code, active) {
      const record = codes.get(code);
      if (record) { record.active = active; return record; }
    },
    deleteCode(code) {
      if (!codes.delete(code)) return;
      messages.delete(code);
      for (const set of memberships.values()) set.delete(code);
      return { code };
    },
    joined(user) {
      return [...codes.values()].filter(c => memberships.get(user.id)?.has(c.code) && c.active && (!c.admin_only || user.role === 'Owner'))
        .map(({ code, room }) => ({ code, room }));
    },
    join(code, user) {
      const room = codes.get(code);
      access(room, user);
      if (!memberships.has(user.id)) memberships.set(user.id, new Set());
      memberships.get(user.id).add(code);
      return room;
    },
    messages(code, user, after, text, clientId) {
      access(codes.get(code), user);
      if (user.role !== 'Owner' && !memberships.get(user.id)?.has(code)) throw new HttpError(403, 'Join this room with its code first.');
      const list = messages.get(code) || [];
      if (text === undefined) return after === null ? list.slice(-100) : list.filter(m => m.id > after).slice(0, 100);
      const existing = clientId && list.find(m => m.client_id === clientId && m.username === user.username);
      if (existing) return existing;
      const item = { id: ++mid, room: code, username: user.username, role: user.role, color: roles.get(user.role.toLowerCase()).color,
        text, client_id: clientId, created_at: now() };
      list.push(item);
      messages.set(code, list);
      return item;
    },
    comments: post => (comments.get(post) || []).slice(-200),
    comment(post_id, username, text) {
      const list = comments.get(post_id) || [];
      const item = { id: ++commentId, post_id, username, text, created_at: now() };
      list.push(item);
      comments.set(post_id, list);
      return item;
    },
    users: () => [...users.values()].map(view).sort((a, b) => a.username.localeCompare(b.username)),
    roles: () => [...roles.values()].sort((a, b) => a.name.localeCompare(b.name)),
    createRole(name, color) {
      const key = name.toLowerCase();
      if (roles.has(key)) return;
      const role = { name, color };
      roles.set(key, role);
      return role;
    },
    setRole(id, name) {
      const role = roles.get(name.toLowerCase());
      const user = [...users.values()].find(u => u.id === id);
      if (role && user && role.name !== 'Owner' && user.role !== 'Owner') { user.role = role.name; return view(user); }
    }
  };
}

const store = pool ? postgres : memoryStore();
let ready = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!pool) console.warn('WARNING: DATABASE_URL is missing. MEMORY_NO_DB mode: ALL DATA RESETS ON RESTART.');
async function cleanup() {
  try { await store.prune(); } catch (error) { logError('Retention cleanup failed', error); }
}
async function boot() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const generated = await store.init();
      if (generated) console.log(`[ShadowBlog] Generated admin password (shown once): ${generated}`);
      await cleanup();
      ready = true;
      setInterval(cleanup, 3600000).unref();
      return;
    } catch (error) {
      logError(`Startup storage attempt ${attempt}/6`, error);
      if (attempt < 6) await delay(3000);
    }
  }
  setTimeout(boot, 30000).unref();
}

app.get('/health', (_req, res) => res.type('text').send(`ok - mode: ${pool ? 'RENDER_DB' : 'MEMORY_NO_DB'}`));
const api = express.Router();
app.use('/api', api);
api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(express.json({ limit: '10kb' }), cookieParser());
const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
function wrap(handler, login = false, owner = false) {
  return route(async (req, res) => {
    if (!ready) {
      res.set('Retry-After', '3');
      throw new HttpError(503, 'Waking up the server, please wait...');
    }
    const token = req.cookies[COOKIE];
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) req.sessionHash = hashToken(token);
    req.user = req.sessionHash ? await store.session(req.sessionHash) : null;
    if (login && !req.user) throw new HttpError(401, 'Please log in first.');
    if (owner && req.user.role !== 'Owner') throw new HttpError(403, DENIED);
    await handler(req, res);
  });
}
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
async function loginSession(req, res, user, status = 200) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.addSession(hashToken(token), user.id, new Date(Date.now() + SESSION_MS));
  if (req.sessionHash) await store.endSession(req.sessionHash);
  res.cookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_MS });
  res.status(status).json({ user: { id: user.id, username: user.username, role: user.role } });
}
function limiter(max, windowMs) {
  const counts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, count] of counts) if (count.until <= now) counts.delete(key);
  }, 60000).unref();
  return (key, res) => {
    const now = Date.now();
    let count = counts.get(key);
    if (!count || count.until <= now) {
      count = { n: 0, until: now + windowMs };
      counts.set(key, count);
    }
    if (count.n >= max) {
      res.set('Retry-After', String(Math.ceil((count.until - now) / 1000)));
      throw new HttpError(429, 'Too many attempts. Please try again later.');
    }
    count.n++;
  };
}
const authLimit = limiter(10, 15 * 60000);
const postLimit = limiter(20, 60000);
function posting(req, res) { postLimit(req.user ? `user:${req.user.id}` : `ip:${req.ip}`, res); }
function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function credentials(body) {
  const username = string(body?.username).toLowerCase();
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Username must be 3–20 characters: a–z, 0–9, or underscore.');
  return { username, password };
}
function textValue(body, max) {
  const text = string(body?.text);
  if (!text || text.length > max || text.includes('\0')) throw new HttpError(400, `Enter text between 1 and ${max} characters.`);
  if (/^\/(?:join|admin|rooms|logout)(?=\s|$)/i.test(text)) throw new HttpError(400, 'Commands are not saved.');
  return text;
}
function roomCode(req) {
  const code = req.params.code.toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(code)) throw new HttpError(404, INVALID);
  return code;
}
function intParam(raw, min, max, error) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new HttpError(400, error);
  return Number(raw);
}

api.post('/auth/register', wrap(async (req, res) => {
  authLimit(req.ip, res);
  const { username, password } = credentials(req.body);
  if (password.length < 6 || Buffer.byteLength(password) > 72) throw new HttpError(400, 'Password must be at least 6 characters and at most 72 UTF-8 bytes.');
  if (await store.user(username)) throw new HttpError(409, 'Username already taken');
  const user = await store.register(username, await bcrypt.hash(password, 10));
  if (!user) throw new HttpError(409, 'Username already taken');
  await loginSession(req, res, user, 201);
}));
api.post('/auth/login', wrap(async (req, res) => {
  authLimit(req.ip, res);
  const { username, password } = credentials(req.body);
  const user = await store.user(username);
  if (!user) throw new HttpError(404, 'User not found - switch to Register');
  if (Buffer.byteLength(password) > 72 || !await bcrypt.compare(password, user.password)) throw new HttpError(401, 'Wrong password');
  await loginSession(req, res, user);
}));
api.post('/auth/logout', wrap(async (req, res) => {
  if (req.sessionHash) await store.endSession(req.sessionHash);
  res.clearCookie(COOKIE, cookieOptions).json({ ok: true });
}));
api.get('/me', wrap((req, res) => res.json({ user: req.user || null })));
api.get('/codes', wrap(async (_req, res) => res.json({ codes: await store.codes() }), true, true));
api.post('/codes', wrap(async (req, res) => {
  const name = string(req.body?.room);
  if (!name || name.length > 80 || name.includes('\0')) throw new HttpError(400, 'Enter a room name with 1–80 characters.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let tries = 0; tries < 12; tries++) {
    const code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    const room = await store.createCode(code, name, req.body?.admin_only === true);
    if (room) return res.status(201).json({ room });
  }
  throw new HttpError(503, 'Could not generate a unique code. Try again.');
}, true, true));
for (const [action, active] of [['validate', true], ['invalidate', false]]) {
  api.post(`/codes/:code/${action}`, wrap(async (req, res) => {
    const room = await store.setCode(roomCode(req), active);
    if (!room) throw new HttpError(404, INVALID);
    res.json({ room });
  }, true, true));
}
api.delete('/codes/:code', wrap(async (req, res) => {
  if (!await store.deleteCode(roomCode(req))) throw new HttpError(404, INVALID);
  res.json({ ok: true });
}, true, true));
api.get('/codes/:code/check', wrap(async (req, res) => {
  const { code, room } = await store.join(roomCode(req), req.user);
  res.json({ room: { code, room } });
}, true));
api.get('/rooms', wrap(async (req, res) => res.json({ rooms: await store.joined(req.user) }), true));
api.get('/rooms/:code/messages', wrap(async (req, res) => {
  const after = req.query.after === undefined ? null : intParam(req.query.after, 0, 2147483647, 'Invalid message cursor.');
  res.json({ messages: await store.messages(roomCode(req), req.user, after) });
}, true));
api.post('/rooms/:code/messages', wrap(async (req, res) => {
  posting(req, res);
  const text = textValue(req.body, 1000);
  const clientId = req.body?.client_id == null ? null : string(req.body.client_id).toLowerCase();
  if (clientId !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(clientId)) throw new HttpError(400, 'Invalid message request ID.');
  res.status(201).json({ message: await store.messages(roomCode(req), req.user, null, text, clientId) });
}, true));
api.get('/posts/:id/comments', wrap(async (req, res) => {
  res.json({ comments: await store.comments(intParam(req.params.id, 1, 6, 'Unknown post.')) });
}));
api.post('/posts/:id/comments', wrap(async (req, res) => {
  posting(req, res);
  const post = intParam(req.params.id, 1, 6, 'Unknown post.');
  res.status(201).json({ comment: await store.comment(post, req.user?.username || 'Guest', textValue(req.body, 500)) });
}));
api.get('/users', wrap(async (_req, res) => res.json({ users: await store.users() }), true, true));
api.post('/users/:id/role', wrap(async (req, res) => {
  const id = intParam(req.params.id, 1, 2147483647, 'Invalid user ID.');
  const role = string(req.body?.role);
  if (role.length > 24 || role.includes('\0')) throw new HttpError(400, 'Invalid role.');
  const user = await store.setRole(id, role);
  if (!user) throw new HttpError(400, 'Unknown user or role, or cannot change the Owner role.');
  res.json({ user });
}, true, true));
api.get('/roles', wrap(async (_req, res) => res.json({ roles: await store.roles() }), true, true));
api.post('/roles', wrap(async (req, res) => {
  const name = string(req.body?.name);
  const color = string(req.body?.color);
  if (!/^[a-z0-9][a-z0-9 _-]{0,23}$/i.test(name) || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new HttpError(400, 'Enter a role name (1–24 letters, numbers, spaces, underscores or dashes) and a valid color.');
  }
  const role = await store.createRole(name, color);
  if (!role) throw new HttpError(409, 'Role already exists.');
  res.status(201).json({ role });
}, true, true));
api.use((_req, res) => res.status(404).json({ error: 'API route not found.' }));

const project = __dirname;
const publicDir = path.join(project, 'public');
const staticOptions = {
  index: false, dotfiles: 'deny', redirect: false,
  setHeaders(res, filename) { if (path.basename(filename) === 'index.html') res.setHeader('Cache-Control', 'no-cache'); }
};
app.use(express.static(publicDir, staticOptions));
// Legacy root fallback: only top-level browser assets, never source/config, dependencies, or dotfiles.
const rootStatic = express.static(project, staticOptions);
app.use((req, res, next) => {
  if (/^\/[a-z0-9_-]+\.(?:html|css|js|ico|png|jpe?g|webp|svg|woff2?)$/i.test(req.path) && req.path.toLowerCase() !== '/server.js') {
    return rootStatic(req, res, next);
  }
  next();
});
app.get(['/', '/index.html'], route(async (_req, res) => {
  for (const folder of [publicDir, project]) {
    const filename = path.join(folder, 'index.html');
    try { await fs.access(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(filename);
  }
  res.status(404).type('text').send('index.html not found - Upload public/index.html');
}));
app.use((_req, res) => res.status(404).type('text').send('Not found.'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (error.type === 'entity.parse.failed' || error instanceof URIError) return res.status(400).json({ error: 'Invalid request.' });
  logError('Request failed', error);
  const unavailable = pool && /^(ECONN|ETIMEDOUT|57P0|08)|terminat|timeout/i.test(error.code || error.message);
  if (unavailable) res.set('Retry-After', '3');
  res.status(unavailable ? 503 : 500).json({ error: unavailable ? 'Storage is temporarily unavailable. Try again shortly.' : 'Something went wrong. Please try again.' });
});
app.listen(process.env.PORT || 3000, '0.0.0.0', () => { console.log('[ShadowBlog] HTTP server listening'); });
void boot();
