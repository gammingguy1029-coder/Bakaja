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
// Set SECURE_COOKIES=true for any HTTPS deploy that does not set NODE_ENV=production.
const secureCookies = process.env.NODE_ENV === 'production' || process.env.SECURE_COOKIES === 'true';
const cookieOptions = { httpOnly: true, sameSite: 'lax', path: '/', secure: secureCookies };
const INVALID = 'This code is invalid / expired. Ask admin to Validate it.';
const DENIED = 'Access Denied - Owner Only';
const defaultRoles = [ ['Owner','#9b5800'], ['Admin','#1756b8'], ['Mod','#137445'], ['VIP','#7443a8'], ['Member','#555d6d'] ];
const seeds = [ ['MOON123', 'Moon Room', false], ['VIP99', 'VIP Room', false], ['ADMIN', 'Admin Chat', true] ];
const MAX_POST_ID = 6; // Keep in sync with the `posts` array in public/index.html.
const OWNER_USERNAME = 'rube'; // Login name for the Owner account.
// ADMIN_PASSWORD is mandatory: it is the only source for the Owner password.
// Validate before listening so a misconfigured deploy fails immediately and
// clearly instead of retrying storage init with a misleading error.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.error('[ShadowBlog] ADMIN_PASSWORD is required. Set it in the environment and restart.');
  process.exit(1);
}
if (Buffer.byteLength(ADMIN_PASSWORD) > 72) {
  console.error('[ShadowBlog] ADMIN_PASSWORD must be at most 72 UTF-8 bytes.');
  process.exit(1);
}
// Optional: set GIPHY_API_KEY to enable the in-chat GIF picker. The key stays
// server-side; the browser only ever sees sanitized media URLs from the proxy.
const GIPHY_KEY = process.env.GIPHY_API_KEY || '';
const REACTIONS = ['👍','❤️','😂','🎉','👀','🔥'];
const gifCache = new Map(); // query -> { at, items } (in-memory, 5-minute TTL)
const dmLabel = (a, b) => `DM: ${[a, b].sort().join(' & ')}`.slice(0, 80);
function isGifMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'giphy.com' || url.hostname.endsWith('.giphy.com'));
  } catch { return false; }
}
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
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS gif_url TEXT;
  CREATE TABLE IF NOT EXISTS friendships (
    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
    dm_code TEXT UNIQUE REFERENCES codes(code) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_a, user_b)
  );
  CREATE INDEX IF NOT EXISTS friendships_status ON friendships (status);
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT NOT NULL DEFAULT '{}',
    read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, id DESC);
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
// ADMIN_PASSWORD is authoritative when set: the stored hash is only rewritten
// when it no longer matches, so redeploying with the same value is a no-op.
// Changing it on a later deploy DOES reset the owner password on startup.
// Existing databases created before the rename keep their Owner account: move
// it to the new username so sessions, messages and memberships keep working.
async function migrateOwnerUsername(db) {
  if (OWNER_USERNAME === 'admin') return;
  const legacy = await one(db, 'SELECT id, role FROM users WHERE username = $1', 'admin');
  if (!legacy || legacy.role !== 'Owner') return;
  const taken = await one(db, 'SELECT id, role FROM users WHERE username = $1', OWNER_USERNAME);
  if (taken?.role === 'Owner') {
    logError('Owner username migration', `"${OWNER_USERNAME}" is already an Owner; legacy "admin" left unchanged.`);
    return;
  }
  if (taken) {
    // Move a pre-registered regular user aside instead of letting
    // ownerPassword() silently promote them to Owner.
    let renamed = `${OWNER_USERNAME}_${taken.id}`;
    for (let n = 1; await one(db, 'SELECT 1 FROM users WHERE username = $1', renamed); n++) {
      renamed = `${OWNER_USERNAME}_${taken.id}_${n}`.slice(0, 20);
    }
    await db.query('UPDATE users SET username = $1 WHERE id = $2', [renamed, taken.id]);
    console.log(`[ShadowBlog] Renamed conflicting account to "${renamed}" during owner migration.`);
  }
  await db.query('UPDATE users SET username = $1 WHERE id = $2', [OWNER_USERNAME, legacy.id]);
  console.log(`[ShadowBlog] Owner username migrated: admin -> ${OWNER_USERNAME}`);
}

async function ownerPassword(existing, save, dropSessions) {
  if (!existing || existing.role !== 'Owner' || !await bcrypt.compare(ADMIN_PASSWORD, existing.password)) {
    await save(await bcrypt.hash(ADMIN_PASSWORD, 10));
    // A password reset must invalidate sessions issued under the old password.
    if (existing && dropSessions) await dropSessions(existing.id);
  }
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
      await migrateOwnerUsername(db);
      return ownerPassword(await one(db, 'SELECT * FROM users WHERE username = $1', OWNER_USERNAME),
        password => db.query(`INSERT INTO users(username, password, role) VALUES($1, $2, 'Owner')
          ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role`, [OWNER_USERNAME, password]),
        id => pool.query('DELETE FROM sessions WHERE user_id = $1', [id]));
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
    await pool.query(`DELETE FROM notifications WHERE created_at < now() - INTERVAL '14 days' OR id IN (
      SELECT id FROM (SELECT id, row_number() OVER(PARTITION BY user_id ORDER BY id DESC) AS place FROM notifications) ranked WHERE place > 50
    )`);
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
  messages: (code, user, after, text, clientId, gifUrl = null) => transaction(async db => {
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
        INSERT INTO messages(room, username, role, text, client_id, gif_url) VALUES($1, $2, $3, $4, $5, $6)
        ON CONFLICT (room, username, client_id) DO UPDATE SET client_id = EXCLUDED.client_id RETURNING *
      ) SELECT saved.*, roles.color FROM saved JOIN roles ON roles.name = saved.role`, code, user.username, user.role, text, clientId, gifUrl);
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
    RETURNING users.id, users.username, users.role`, id, name),

  // --- Social features -------------------------------------------------------
  userById: id => one(pool, `SELECT u.id, u.username, u.role, r.color FROM users u
    LEFT JOIN roles r ON r.name = u.role WHERE u.id = $1`, id),
  searchUsers: (query, excludeId, limit) => rows(pool,
    'SELECT id, username, role FROM users WHERE strpos(lower(username), lower($1)) > 0 AND id <> $2 ORDER BY username LIMIT $3',
    query, excludeId, limit),
  pendingCount: async id => (await one(pool,
    "SELECT count(*)::int AS count FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'pending'", id)).count,
  sendFriendRequest: (fromId, toId) => one(pool, `INSERT INTO friendships(user_a, user_b, requester_id, status)
    VALUES (LEAST($1,$2), GREATEST($1,$2), $1, 'pending') ON CONFLICT (user_a, user_b) DO NOTHING RETURNING *`, fromId, toId),
  acceptFriendRequest: (viewerId, friendId, label) => transaction(async db => {
    const row = await one(db, `UPDATE friendships SET status = 'accepted'
      WHERE user_a = LEAST($1,$2) AND user_b = GREATEST($1,$2) AND requester_id <> $1 AND status = 'pending' RETURNING *`, viewerId, friendId);
    if (!row || row.dm_code) return row;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = null;
    for (let tries = 0; tries < 12 && !code; tries++) {
      const candidate = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
      const inserted = await one(db, 'INSERT INTO codes(code, room) VALUES($1,$2) ON CONFLICT (code) DO NOTHING RETURNING code', candidate, label);
      if (inserted) code = candidate;
    }
    if (!code) throw new Error('Could not create a direct-message room.');
    await db.query('INSERT INTO memberships(user_id, code) VALUES ($1,$2),($3,$2) ON CONFLICT DO NOTHING', [row.user_a, code, row.user_b]);
    await db.query('UPDATE friendships SET dm_code = $1 WHERE user_a = $2 AND user_b = $3', [code, row.user_a, row.user_b]);
    return { ...row, dm_code: code };
  }),
  declineFriendRequest: (viewerId, friendId) => one(pool, `DELETE FROM friendships
    WHERE user_a = LEAST($1,$2) AND user_b = GREATEST($1,$2) AND requester_id <> $1 AND status = 'pending' RETURNING *`, viewerId, friendId),
  cancelFriendRequest: (viewerId, friendId) => one(pool, `DELETE FROM friendships
    WHERE user_a = LEAST($1,$2) AND user_b = GREATEST($1,$2) AND requester_id = $1 AND status = 'pending' RETURNING *`, viewerId, friendId),
  removeFriend: (viewerId, friendId) => transaction(async db => {
    const row = await one(db, `DELETE FROM friendships
      WHERE user_a = LEAST($1,$2) AND user_b = GREATEST($1,$2) AND status = 'accepted' RETURNING *`, viewerId, friendId);
    if (row?.dm_code) await db.query('DELETE FROM codes WHERE code = $1', [row.dm_code]);
    return row;
  }),
  friends: id => rows(pool, `SELECT u.id, u.username, u.role, r.color, f.dm_code
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
    LEFT JOIN roles r ON r.name = u.role
    WHERE (f.user_a = $1 OR f.user_b = $1) AND f.status = 'accepted' ORDER BY u.username`, id),
  // `id` is always the OTHER person in the pair: the requester for incoming
  // rows, the recipient for outgoing rows. UI actions pass person.id back.
  requests: id => rows(pool, `SELECT f.requester_id, u.id, u.username, u.role, r.color
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = $1
      THEN (CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END)
      ELSE f.requester_id END
    LEFT JOIN roles r ON r.name = u.role
    WHERE (f.user_a = $1 OR f.user_b = $1) AND f.status = 'pending' ORDER BY f.created_at DESC`, id),
  accessibleRoom: async (code, user) => {
    const room = await one(pool, 'SELECT * FROM codes WHERE code = $1', code);
    access(room, user);
    if (user.role !== 'Owner' && !await one(pool, 'SELECT 1 FROM memberships WHERE user_id = $1 AND code = $2', user.id, code)) {
      throw new HttpError(403, 'Join this room with its code first.');
    }
    return room;
  },
  addReaction: async (code, messageId, userId, emoji) => {
    if (!await one(pool, 'SELECT 1 FROM messages WHERE id = $1 AND room = $2', messageId, code)) throw new HttpError(404, 'Message not found.');
    await pool.query('INSERT INTO message_reactions(message_id, user_id, emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [messageId, userId, emoji]);
    return { emoji, mine: true };
  },
  removeReaction: async (code, messageId, userId, emoji) => {
    if (!await one(pool, 'SELECT 1 FROM messages WHERE id = $1 AND room = $2', messageId, code)) throw new HttpError(404, 'Message not found.');
    await pool.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, userId, emoji]);
    return { emoji, mine: false };
  },
  reactions: async (ids, viewerId) => {
    if (!ids.length) return [];
    return rows(pool, `SELECT message_id, emoji, count(*)::int AS count, bool_or(user_id = $2) AS mine
      FROM message_reactions WHERE message_id = ANY($1) GROUP BY message_id, emoji ORDER BY message_id, emoji`, ids, viewerId);
  },
  notify: (userId, type, actorId, payload) => one(pool,
    'INSERT INTO notifications(user_id, type, actor_id, payload) VALUES($1,$2,$3,$4) RETURNING id, type, actor_id, payload, read, created_at',
    userId, type, actorId, JSON.stringify(payload)),
  notifications: async id => {
    const list = await rows(pool, `SELECT n.id, n.type, n.payload, n.read, n.created_at, u.username AS actor_username
      FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.user_id = $1 ORDER BY n.id DESC LIMIT 50`, id);
    return list.map(n => ({ ...n, payload: typeof n.payload === 'string' ? JSON.parse(n.payload) : n.payload }));
  },
  markNotificationsRead: id => pool.query('UPDATE notifications SET read = true WHERE user_id = $1', id)
};

function memoryStore() {
  const users = new Map(), sessions = new Map(), codes = new Map(), roles = new Map();
  const memberships = new Map(), messages = new Map(), comments = new Map();
  const friendships = new Map(), reactionMap = new Map(), notifications = new Map();
  const messageIndex = new Map(); // message id -> room code
  let uid = 0, cid = 0, mid = 0, commentId = 0, notifId = 0;
  const friendshipKey = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const now = () => new Date();
  const view = ({ id, username, role }) => ({ id, username, role });
  function createCode(code, room, admin_only) {
    if (codes.has(code)) return;
    const record = { id: ++cid, code, room, admin_only, active: true, created_at: now() };
    codes.set(code, record);
    return record;
  }
  function dropSessions(userId) {
    for (const [hash, session] of sessions) if (session.user?.id === userId) sessions.delete(hash);
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
      return ownerPassword(users.get(OWNER_USERNAME), password => {
        users.set(OWNER_USERNAME, { id: ++uid, username: OWNER_USERNAME, password, role: 'Owner', created_at: now() });
      }, dropSessions);
    },
    prune() {
      pruneLists(messages, 500);
      pruneLists(comments, 200);
      const cutoff = Date.now() - 14 * DAY;
      const live = new Set();
      for (const [code, list] of messages) for (const item of list) { live.add(item.id); messageIndex.set(item.id, code); }
      for (const id of reactionMap.keys()) if (!live.has(id)) reactionMap.delete(id);
      for (const [hash, session] of sessions) if (session.expires <= Date.now()) sessions.delete(hash);
      for (const [id, list] of notifications) {
        const kept = list.filter(item => item.created_at.getTime() >= cutoff).slice(0, 50);
        if (kept.length) notifications.set(id, kept); else notifications.delete(id);
      }
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
      for (const item of messages.get(code) || []) { messageIndex.delete(item.id); reactionMap.delete(item.id); }
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
    messages(code, user, after, text, clientId, gifUrl = null) {
      access(codes.get(code), user);
      if (user.role !== 'Owner' && !memberships.get(user.id)?.has(code)) throw new HttpError(403, 'Join this room with its code first.');
      const list = messages.get(code) || [];
      if (text === undefined) return after === null ? list.slice(-100) : list.filter(m => m.id > after).slice(0, 100);
      const existing = clientId && list.find(m => m.client_id === clientId && m.username === user.username);
      if (existing) return existing;
      const item = { id: ++mid, room: code, username: user.username, role: user.role, color: roles.get(user.role.toLowerCase()).color,
        text, gif_url: gifUrl, client_id: clientId, created_at: now() };
      list.push(item);
      messages.set(code, list);
      messageIndex.set(item.id, code);
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
    },

    // --- Social features (mirror of the postgres adapter) -------------------
    userById(id) {
      const found = [...users.values()].find(u => u.id === id);
      return found ? { ...view(found), color: roles.get(found.role.toLowerCase())?.color } : undefined;
    },
    searchUsers(query, excludeId, limit) {
      const needle = query.toLowerCase();
      return [...users.values()].filter(u => u.id !== excludeId && u.username.toLowerCase().includes(needle))
        .sort((a, b) => a.username.localeCompare(b.username)).slice(0, limit).map(view);
    },
    pendingCount(id) {
      return [...friendships.values()].filter(f => f.status === 'pending' && (f.user_a === id || f.user_b === id)).length;
    },
    sendFriendRequest(fromId, toId) {
      const key = friendshipKey(fromId, toId);
      if (friendships.has(key)) return undefined;
      const row = { user_a: Math.min(fromId, toId), user_b: Math.max(fromId, toId), requester_id: fromId,
        status: 'pending', dm_code: null, created_at: now() };
      friendships.set(key, row);
      return row;
    },
    acceptFriendRequest(viewerId, friendId, label) {
      const row = friendships.get(friendshipKey(viewerId, friendId));
      if (!row || row.status !== 'pending' || row.requester_id === viewerId) return undefined;
      row.status = 'accepted';
      if (!row.dm_code) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = null;
        for (let tries = 0; tries < 12 && !code; tries++) {
          const candidate = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
          if (!codes.has(candidate)) code = candidate;
        }
        if (!code) throw new Error('Could not create a direct-message room.');
        createCode(code, label, false);
        for (const id of [row.user_a, row.user_b]) {
          if (!memberships.has(id)) memberships.set(id, new Set());
          memberships.get(id).add(code);
        }
        row.dm_code = code;
      }
      return row;
    },
    declineFriendRequest(viewerId, friendId) {
      const key = friendshipKey(viewerId, friendId), row = friendships.get(key);
      if (!row || row.status !== 'pending' || row.requester_id === viewerId) return undefined;
      friendships.delete(key);
      return row;
    },
    cancelFriendRequest(viewerId, friendId) {
      const key = friendshipKey(viewerId, friendId), row = friendships.get(key);
      if (!row || row.status !== 'pending' || row.requester_id !== viewerId) return undefined;
      friendships.delete(key);
      return row;
    },
    removeFriend(viewerId, friendId) {
      const key = friendshipKey(viewerId, friendId), row = friendships.get(key);
      if (!row || row.status !== 'accepted') return undefined;
      friendships.delete(key);
      if (row.dm_code) {
        for (const item of messages.get(row.dm_code) || []) { messageIndex.delete(item.id); reactionMap.delete(item.id); }
        codes.delete(row.dm_code);
        messages.delete(row.dm_code);
      }
      return row;
    },
    friends(id) {
      return [...friendships.values()].filter(f => f.status === 'accepted' && (f.user_a === id || f.user_b === id))
        .map(f => {
          const other = [...users.values()].find(u => u.id === (f.user_a === id ? f.user_b : f.user_a));
          return other ? { ...view(other), color: roles.get(other.role.toLowerCase())?.color, dm_code: f.dm_code } : null;
        }).filter(Boolean).sort((a, b) => a.username.localeCompare(b.username));
    },
    requests(id) {
      return [...friendships.values()].filter(f => f.status === 'pending' && (f.user_a === id || f.user_b === id))
        .map(f => {
          const otherId = f.requester_id === id ? (f.user_a === id ? f.user_b : f.user_a) : f.requester_id;
          const other = [...users.values()].find(u => u.id === otherId);
          return other ? { requester_id: f.requester_id, ...view(other), color: roles.get(other.role.toLowerCase())?.color } : null;
        }).filter(Boolean);
    },
    accessibleRoom(code, user) {
      const room = codes.get(code);
      access(room, user);
      if (user.role !== 'Owner' && !memberships.get(user.id)?.has(code)) throw new HttpError(403, 'Join this room with its code first.');
      return room;
    },
    addReaction(code, messageId, userId, emoji) {
      if (messageIndex.get(messageId) !== code) throw new HttpError(404, 'Message not found.');
      if (!reactionMap.has(messageId)) reactionMap.set(messageId, new Map());
      const byEmoji = reactionMap.get(messageId);
      if (!byEmoji.has(emoji)) byEmoji.set(emoji, new Set());
      byEmoji.get(emoji).add(userId);
      return { emoji, mine: true };
    },
    removeReaction(code, messageId, userId, emoji) {
      if (messageIndex.get(messageId) !== code) throw new HttpError(404, 'Message not found.');
      reactionMap.get(messageId)?.get(emoji)?.delete(userId);
      return { emoji, mine: false };
    },
    reactions(ids, viewerId) {
      const out = [];
      for (const id of ids) {
        const byEmoji = reactionMap.get(id);
        if (!byEmoji) continue;
        for (const [emoji, set] of byEmoji) out.push({ message_id: id, emoji, count: set.size, mine: set.has(viewerId) });
      }
      return out.sort((a, b) => a.message_id - b.message_id || a.emoji.localeCompare(b.emoji));
    },
    notify(userId, type, actorId, payload) {
      if (!notifications.has(userId)) notifications.set(userId, []);
      const row = { id: ++notifId, type, actor_id: actorId, payload, read: false, created_at: now() };
      notifications.get(userId).unshift(row);
      return row;
    },
    notifications(id) {
      return (notifications.get(id) || []).slice(0, 50).map(n => ({
        id: n.id, type: n.type, payload: n.payload, read: n.read, created_at: n.created_at,
        actor_username: [...users.values()].find(u => u.id === n.actor_id)?.username || null
      }));
    },
    markNotificationsRead(id) { for (const item of notifications.get(id) || []) item.read = true; }
  };
}

const store = pool ? postgres : memoryStore();
async function withReactions(items, viewerId) {
  if (!items.length) return items;
  const found = await store.reactions(items.map(item => item.id), viewerId);
  const byMessage = new Map();
  for (const reaction of found) {
    if (!byMessage.has(reaction.message_id)) byMessage.set(reaction.message_id, []);
    byMessage.get(reaction.message_id).push({ emoji: reaction.emoji, count: Number(reaction.count), mine: Boolean(reaction.mine) });
  }
  return items.map(item => ({ ...item, reactions: byMessage.get(item.id) || [] }));
}
let ready = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!pool) console.warn('WARNING: DATABASE_URL is missing. MEMORY_NO_DB mode: ALL DATA RESETS ON RESTART.');
async function cleanup() {
  try { await store.prune(); } catch (error) { logError('Retention cleanup failed', error); }
}
async function boot() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await store.init();
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
    if (owner && (!req.user || req.user.role !== 'Owner')) throw new HttpError(403, DENIED);
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
  const hits = new Map();
  // Housekeeping only; the per-call filter below is the authoritative window.
  setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      const recent = times.filter(time => time > now - windowMs);
      if (recent.length) hits.set(key, recent); else hits.delete(key);
    }
  }, 60000).unref();
  return (key, res) => {
    const now = Date.now();
    const times = (hits.get(key) || []).filter(time => time > now - windowMs);
    if (times.length >= max) {
      hits.set(key, times);
      res.set('Retry-After', String(Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000))));
      throw new HttpError(429, 'Too many attempts. Please try again later.');
    }
    times.push(now);
    hits.set(key, times);
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
  if (/^\/(?:join|admin|rooms|logout|app)(?=\s|$)/i.test(text)) throw new HttpError(400, 'Commands are not saved.');
  return text;
}
// Chat messages may contain only a GIF, so empty text is allowed when a valid
// gif_url is supplied. Command words are still rejected as defense in depth.
function messageText(body, hasGif) {
  const text = string(body?.text);
  if (!text && !hasGif) throw new HttpError(400, 'Enter text or choose a GIF.');
  if (text.length > 1000 || text.includes('\0')) throw new HttpError(400, 'Enter text between 1 and 1000 characters.');
  if (/^\/(?:join|admin|rooms|logout|app)(?=\s|$)/i.test(text)) throw new HttpError(400, 'Commands are not saved.');
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
  // Same response for an unknown user and a wrong password: do not leak which
  // usernames are registered.
  if (!user) throw new HttpError(401, 'Wrong password');
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
api.post('/codes/:code/join', wrap(async (req, res) => {
  const { code, room } = await store.join(roomCode(req), req.user);
  res.json({ room: { code, room } });
}, true));
api.get('/rooms', wrap(async (req, res) => res.json({ rooms: await store.joined(req.user) }), true));
api.get('/rooms/:code/messages', wrap(async (req, res) => {
  const after = req.query.after === undefined ? null : intParam(req.query.after, 0, 2147483647, 'Invalid message cursor.');
  const messages = await store.messages(roomCode(req), req.user, after);
  res.json({ messages: await withReactions(messages, req.user.id) });
}, true));
api.post('/rooms/:code/messages', wrap(async (req, res) => {
  posting(req, res);
  const code = roomCode(req);
  const gifUrl = req.body?.gif_url == null ? null : string(req.body.gif_url);
  if (gifUrl !== null && !isGifMediaUrl(gifUrl)) throw new HttpError(400, 'Invalid GIF link.');
  const text = messageText(req.body, gifUrl !== null);
  const clientId = req.body?.client_id == null ? null : string(req.body.client_id).toLowerCase();
  if (clientId !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(clientId)) throw new HttpError(400, 'Invalid message request ID.');
  const message = await store.messages(code, req.user, null, text, clientId, gifUrl);
  res.status(201).json({ message: (await withReactions([message], req.user.id))[0] });
}, true));
const reactionLimit = limiter(60, 60000);
api.post('/rooms/:code/messages/:id/reactions', wrap(async (req, res) => {
  reactionLimit(req.user.id, res);
  const code = roomCode(req), id = intParam(req.params.id, 1, 2147483647, 'Invalid message.');
  const emoji = string(req.body?.emoji);
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Unsupported reaction.');
  await store.accessibleRoom(code, req.user);
  res.status(201).json({ reaction: await store.addReaction(code, id, req.user.id, emoji) });
}, true));
api.delete('/rooms/:code/messages/:id/reactions/:emoji', wrap(async (req, res) => {
  reactionLimit(req.user.id, res);
  const code = roomCode(req), id = intParam(req.params.id, 1, 2147483647, 'Invalid message.');
  const emoji = req.params.emoji;
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Unsupported reaction.');
  await store.accessibleRoom(code, req.user);
  res.json({ reaction: await store.removeReaction(code, id, req.user.id, emoji) });
}, true));

// --- GIF picker proxy (Giphy) -------------------------------------------------
api.get('/gifs/config', (_req, res) => res.json({ configured: Boolean(GIPHY_KEY) }));
const gifLimit = limiter(15, 60000);
api.get('/gifs/search', wrap(async (req, res) => {
  if (!GIPHY_KEY) throw new HttpError(503, 'GIF search is not configured. Ask the owner to set GIPHY_API_KEY.');
  const query = string(req.query.q);
  if (query.length < 1 || query.length > 50) throw new HttpError(400, 'Enter a search term (1–50 characters).');
  gifLimit(req.user.id, res);
  const key = query.toLowerCase();
  const cached = gifCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60000) return res.json({ gifs: cached.items, configured: true });
  const target = new URL('https://api.giphy.com/v1/gifs/search');
  target.searchParams.set('api_key', GIPHY_KEY);
  target.searchParams.set('q', query);
  target.searchParams.set('limit', String(12));
  target.searchParams.set('rating', 'pg');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(target, { signal: controller.signal });
    if (!response.ok) throw new Error(`Giphy returned ${response.status}`);
    const data = await response.json();
    const gifs = (Array.isArray(data.data) ? data.data : []).map(item => ({
      id: String(item.id),
      title: String(item.title || 'GIF').slice(0, 80),
      url: item.images?.original?.url,
      preview: item.images?.fixed_height_small?.url || item.images?.fixed_height?.url
    })).filter(gif => isGifMediaUrl(gif.url) && isGifMediaUrl(gif.preview));
    if (gifCache.size > 200) gifCache.clear();
    gifCache.set(key, { at: Date.now(), items: gifs });
    res.json({ gifs, configured: true });
  } catch (error) {
    logError('GIF search', error);
    throw new HttpError(502, 'GIF search is unavailable right now.');
  } finally { clearTimeout(timer); }
}, true));

// --- Social: user search, friend requests, notifications ---------------------
const friendLimit = limiter(30, 60000);
api.get('/users/search', wrap(async (req, res) => {
  friendLimit(req.user.id, res);
  const query = string(req.query.q);
  if (query.length < 2 || query.length > 20) throw new HttpError(400, 'Enter 2–20 characters to search.');
  res.json({ users: await store.searchUsers(query, req.user.id, 20) });
}, true));
api.post('/friends/request', wrap(async (req, res) => {
  friendLimit(req.user.id, res);
  const username = string(req.body?.username).toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Invalid username.');
  if (username === req.user.username) throw new HttpError(400, 'You cannot friend yourself.');
  const target = await store.user(username);
  if (!target) throw new HttpError(404, 'No user with that username.');
  if (await store.pendingCount(req.user.id) >= 20) throw new HttpError(429, 'You have too many pending requests.');
  let request;
  try {
    request = await store.sendFriendRequest(req.user.id, target.id);
  } catch (error) {
    // A duplicate pair can surface as a driver unique-violation instead of a
    // falsy return value (e.g. a stale/conflicting schema). Keep it a clean 409.
    if (error.code === '23505') throw new HttpError(409, 'A request or friendship already exists.');
    throw error;
  }
  if (!request) throw new HttpError(409, 'A request or friendship already exists.');
  // The friendship is already saved. A notification failure must not turn a
  // successful request into a generic 500 for the sender.
  try {
    await store.notify(target.id, 'friend_request', req.user.id, { username: req.user.username });
  } catch (error) {
    logError('Friend request notification', error);
  }
  res.status(201).json({ request: { id: target.id, username: target.username, requester_id: request.requester_id } });
}, true));
api.get('/friends', wrap(async (req, res) => {
  const [friends, requests] = await Promise.all([store.friends(req.user.id), store.requests(req.user.id)]);
  res.json({
    friends: friends.map(friend => ({ ...friend, dm_room: dmLabel(req.user.username, friend.username) })),
    incoming: requests.filter(item => item.requester_id !== req.user.id),
    outgoing: requests.filter(item => item.requester_id === req.user.id)
  });
}, true));
api.post('/friends/:id/accept', wrap(async (req, res) => {
  const id = intParam(req.params.id, 1, 2147483647, 'Invalid user ID.');
  const other = await store.userById(id);
  if (!other) throw new HttpError(404, 'Unknown user.');
  const label = dmLabel(req.user.username, other.username);
  const row = await store.acceptFriendRequest(req.user.id, id, label);
  if (!row) throw new HttpError(400, 'No pending request from that user.');
  const room = row.dm_code ? { code: row.dm_code, room: label } : null;
  await store.notify(row.requester_id, 'friend_accepted', req.user.id, { username: req.user.username, room });
  res.json({ friend: { id: other.id, username: other.username, role: other.role, color: other.color || null, dm_code: row.dm_code, dm_room: label }, room });
}, true));
api.post('/friends/:id/decline', wrap(async (req, res) => {
  const id = intParam(req.params.id, 1, 2147483647, 'Invalid user ID.');
  if (!await store.declineFriendRequest(req.user.id, id)) throw new HttpError(400, 'No pending request from that user.');
  res.json({ ok: true });
}, true));
api.post('/friends/:id/cancel', wrap(async (req, res) => {
  const id = intParam(req.params.id, 1, 2147483647, 'Invalid user ID.');
  if (!await store.cancelFriendRequest(req.user.id, id)) throw new HttpError(400, 'No pending request for that user.');
  res.json({ ok: true });
}, true));
api.delete('/friends/:id', wrap(async (req, res) => {
  const id = intParam(req.params.id, 1, 2147483647, 'Invalid user ID.');
  if (!await store.removeFriend(req.user.id, id)) throw new HttpError(400, 'You are not friends with that user.');
  res.json({ ok: true });
}, true));
api.get('/notifications', wrap(async (req, res) => {
  res.json({ notifications: await store.notifications(req.user.id) });
}, true));
api.post('/notifications/read', wrap(async (req, res) => {
  await store.markNotificationsRead(req.user.id);
  res.json({ ok: true });
}, true));
api.get('/posts/:id/comments', wrap(async (req, res) => {
  res.json({ comments: await store.comments(intParam(req.params.id, 1, MAX_POST_ID, 'Unknown post.')) });
}));
api.post('/posts/:id/comments', wrap(async (req, res) => {
  posting(req, res);
  const post = intParam(req.params.id, 1, MAX_POST_ID, 'Unknown post.');
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
// Dedicated entry points for the standalone sign-in page and WhatsApp-style app.
// These are explicit routes because express.static does not map extensionless
// paths to *.html. Both files live under public/ and are served as-is.
app.get(['/login','/app'], route(async (req, res) => {
  res.set('Cache-Control','no-cache');
  return res.sendFile(path.join(publicDir, req.path === '/login' ? 'login.html' : 'app.html'));
}));
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
  // Classify by driver error code only: matching message text could turn an
  // ordinary validation error containing "timeout" into a spurious 503.
  const unavailable = pool && /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|57|08|53)/i.test(String(error.code || ''));
  if (unavailable) res.set('Retry-After', '3');
  res.status(unavailable ? 503 : 500).json({ error: unavailable ? 'Storage is temporarily unavailable. Try again shortly.' : 'Something went wrong. Please try again.' });
});
app.listen(process.env.PORT || 3000, '0.0.0.0', () => { console.log('[ShadowBlog] HTTP server listening'); });
void boot();
