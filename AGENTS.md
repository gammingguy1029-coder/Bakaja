# AGENTS.md — ShadowBlog

Guidance for AI agents and contributors working in this repository. Read this
before making changes. This document describes the project's architecture,
conventions, and invariants so edits stay consistent and do not break the app.

> **Orientation for agents:** The backend is one file (`server.js`, ~960
> lines). The frontend is split into plain HTML + CSS + JS files under `public/`
> — no bundler, no modules, no build step. There are three entry pages: `/`
> (study blog), `/login` (standalone sign-in), and `/app` (WhatsApp-style chat
> app). Everything else is config/docs. If
> you are looking for "where does X live?", jump to the **task → location map**
> at the end of §2. The **do-not-break list** (§12) and **validation checklist**
> (§13) are the contract: read them before and after every change.

---

## 1. Overview

**ShadowBlog** is a small, self-contained web app: a responsive study blog with
code-based private chat rooms, an Owner-only admin panel, and a separate
WhatsApp-style chat app at `/app` reached through `/login`.

Defining constraints — respect these in every change:

- **No build step.** Plain HTML, CSS, and JavaScript. No bundler, transpiler,
  TypeScript, or framework. Node serves files as-is.
- **Backend is a single file.** `server.js` contains the entire Express server,
  storage layer, and API. Keep it that way; do not split it into modules unless
  explicitly asked.
- **Frontend is split into plain files.** `public/index.html` is markup only;
  `public/css/*.css` and `public/js/*.js` are loaded with `<link>` and deferred
  classic `<script>` tags. No bundler, modules, or external CDN assets.
- **CommonJS + `'use strict'`.** The backend uses `require(...)` and starts with
  `'use strict';`. Do not convert to ESM.
- **Dual storage modes.** PostgreSQL when `DATABASE_URL` is present, otherwise
  an in-memory store that resets on restart. Both must stay functionally
  equivalent.

---

## 2. Repository layout

| Path | Purpose |
|---|---|
| `server.js` | Entire backend: Express app, storage adapters (Postgres + memory), REST API, auth, Giphy proxy, static serving, error handling, boot sequence. |
| `public/index.html` | Blog entry page markup: blog, dialogs, private screen, admin pane, toasts. |
| `public/login.html` | Standalone sign-in / register page (`/login`). |
| `public/app.html` | WhatsApp-style app shell markup (`/app`); reuses the same element IDs as `index.html`. |
| `public/css/base.css` | Shared variables, reset, layout, forms, buttons, dialogs. |
| `public/css/blog.css` | Blog hero, posts, cards, comments. |
| `public/css/chat.css` | Private screen, chat, inbox, admin pane, dark theme, all media queries. |
| `public/css/social.css` | Friends, GIF picker, notifications, reactions, toasts. |
| `public/css/login.css` | Split-panel sign-in page. |
| `public/css/app.css` | Three-column app layout, sidebar, details pane, notifications drawer, responsive app rules. |
| `public/js/core.js` | Shared state/helpers, `api()`/`readWithBackoff()`, command dispatch, avatar/badge, GIF URL validation, `toast()`. |
| `public/js/blog.js` | Posts, hash views, comments. |
| `public/js/chat.js` | Rooms, polling, optimistic send, GIF messages, reactions. |
| `public/js/admin.js` | Owner panel. |
| `public/js/social.js` | User search, friend requests, DMs, notifications. |
| `public/js/gifs.js` | Giphy picker. |
| `public/js/app.js` | All DOM event wiring and startup for the **blog** page. |
| `public/js/login.js` | Login/register form handling and redirect to `/app`. |
| `public/js/shell.js` | Controller for `/app`: sidebar tabs, chat list, details pane, notifications drawer, app-specific wiring. |
| `package.json` | `shadowblog` v1.0.0, private, Node >= 18, `start` script = `node server.js`. |
| `package-lock.json` | Lockfile v3 (committed; keep dependencies reproducible). |
| `render.yaml` | Render Blueprint: free web service + free PostgreSQL (Singapore), `/health` check. |
| `FIX.txt` | Human-facing deployment, troubleshooting, private commands, retention, and backup/restore guide. |
| `README.md` | Short overview and quick start. |
| `.gitignore` | Ignores `node_modules/`, `.env`, `.env.*`, `*.dump`, `*.sql`, logs, `/out/`. |

Treat `FIX.txt` as the source of truth for deployment and operational
procedures; update it when deployment behavior changes.

### Task → location map

| If you need to change… | Go to |
|---|---|
| An API route, auth, rate limit, validation, or error response | `server.js` — `api.*` routes, `wrap()`, `HttpError`, helpers near the bottom |
| Storage behavior (users, codes, messages, comments, sessions) | `server.js` — **both** `postgres` and `memoryStore()` adapters |
| Schema, seed data, owner account migration, retention | `server.js` — `schema`, `defaultRoles`, `seeds`, `migrateOwnerUsername()`, `ownerPassword()`, `prune()` |
| Startup readiness / DB retry / cold-start gate | `server.js` — `boot()`, `ready`, the `!ready` guard in `wrap()` |
| Blog posts, hash views, comments | `public/js/blog.js` + `public/css/blog.css` |
| Commands, shared state, fetch wrapper, wake banner | `public/js/core.js` |
| Chat UI, polling, optimistic send, request-ID guards | `public/js/chat.js` — `poll()`, `send()`, `*RequestId` vars |
| GIF messages, reactions | `public/js/chat.js` (`messageNode`, `reactionControls`) + `public/js/gifs.js` |
| Friends, search, DMs, notifications | `public/js/social.js` + `public/css/social.css` |
| Owner panel | `public/js/admin.js` |
| Markup / DOM structure (blog) | `public/index.html` |
| Event listeners / startup (blog) | `public/js/app.js` |
| Sign-in page | `public/login.html`, `public/css/login.css`, `public/js/login.js` |
| Chat app shell (`/app`) | `public/app.html`, `public/css/app.css`, `public/js/shell.js` |
| Page routes (`/login`, `/app`) | `server.js` near the static serving block |
| Deploy config (Render, env vars, health check) | `render.yaml` and `FIX.txt` |
| Docs describing behavior | `README.md` (short), `FIX.txt` (ops), this file (architecture) |

---

## 3. Architecture & runtime model

### Startup (`boot()` at the bottom of `server.js`)

1. Before anything listens, `ADMIN_PASSWORD` is validated: if missing or over
   72 UTF-8 bytes, the process prints a clear error and exits with code 1. No
   random owner password is ever generated.
2. `app.listen(PORT || 3000, '0.0.0.0')` starts immediately.
3. `boot()` calls `store.init()` up to 6 times with 3s backoff; on total failure
   it retries every 30s via `setTimeout`.
4. `init()` creates the schema, seeds default roles and rooms, and ensures the
   `rube` owner account using `ADMIN_PASSWORD` as its password. No password is
   ever generated or logged.
5. `ready = true` only after init + initial `prune()` succeed. An hourly
   `setInterval` runs `prune()` (unref'd).
6. While `!ready`, API routes return `503` with `Retry-After: 3` and the message
   "Waking up the server, please wait...". Do not remove this gate — Render free
   instances sleep and cold starts are common. Note that `/health` is **not**
   gated: it reports process liveness immediately, so a healthy `/health` does
   not mean the DB is ready. The client's wake banner is driven by these 503s
   and by slow responses (>1.4s), not by `/health`.

### Storage selection

```js
const store = pool ? postgres : memoryStore();
```

- `pool` is a `pg.Pool` created only if `process.env.DATABASE_URL` is set (SSL
  with `rejectUnauthorized: false`, max 5 connections, 10s statement timeout).
- `/health` reports `ok - mode: RENDER_DB` or `ok - mode: MEMORY_NO_DB`.
- **Missing** `DATABASE_URL` → memory mode (warning logged). **Unreachable**
  configured DB → no silent fallback; startup retries and API stays 503.
- Both adapters implement the same interface: `init`, `prune`, `user`,
  `register`, `session`, `addSession`, `endSession`, `codes`, `createCode`,
  `setCode`, `deleteCode`, `joined`, `join`, `messages`, `comments`, `comment`,
  `users`, `roles`, `createRole`, `setRole`, `userById`, `searchUsers`,
  `pendingCount`, `sendFriendRequest`, `acceptFriendRequest`,
  `declineFriendRequest`, `cancelFriendRequest`, `removeFriend`, `friends`,
  `requests`, `accessibleRoom`, `addReaction`, `removeReaction`, `reactions`,
  `notify`, `notifications`, `markNotificationsRead`. Any change to this
  interface must be made in **both** adapters. `withReactions()` in `server.js`
  attaches reaction arrays to message payloads for both.

### Request lifecycle

`app.use('/api', api)` mounts all API routes under `/api`. Middleware order
matters: `Cache-Control: no-store`, then `express.json({ limit: '10kb' })` and
`cookieParser()`. `wrap(handler, login, owner)` wraps every API route: checks
`ready`, resolves the session cookie into `req.user`, enforces `login`/`owner`
guards, and funnels errors to `next`. `HttpError(status, message)` is the
expected error type; the final error middleware maps it to JSON, handles payload
size/parse errors, and returns 503 for transient DB connectivity errors.

### End-to-end data flow (worked examples)

Understanding these round-trips prevents most "I changed one side and broke the
other" bugs.

**Sending a chat message (idempotent):**
1. Browser `send(current, pending)` generates a UUID `client_id`, renders a
   *pending* bubble immediately, then `POST /rooms/:code/messages` with
   `{ text, client_id }`.
2. `wrap(..., login=true)` resolves the session cookie → `req.user` and enforces
   login; `posting()` applies the 20/min rate limit; `textValue()` validates.
3. `postgres.messages()` opens a transaction with
   `SELECT ... FOR NO KEY UPDATE` on the room row — this **serializes sends per
   room** so a higher committed ID cannot overtake an in-flight lower ID during
   polling. It checks membership (or Owner bypass), then `INSERT ... ON CONFLICT
   (room, username, client_id) DO UPDATE ... RETURNING *` with a join to `roles`
   for the color.
4. The saved message replaces the pending bubble in the UI. A retried send with
   the same `client_id` returns the same row instead of duplicating it.
5. Other clients' `poll()` calls use `GET /rooms/:code/messages?after=<lastId>`,
   which returns up to 100 messages with `id > after`; `current.ids` dedupes and
   the cursor `lastId` advances.

**Login / commands:**
- `/join`, `/admin`, `/rooms`, `/logout`, `/app` are typed into a **comment box**
  (not a chat composer) and intercepted client-side by `parseCommand()` →
  `runCommand()`. They are never sent as text; `textValue()` also rejects them
  server-side as defense in depth. A `401` during a command reopens the auth
  dialog and stashes the command in `savedCommand` so it resumes after login.
  `/app` navigates to the standalone chat app; when signed out, the app's own
  guard sends the user to `/login?next=/app`.
- Login writes a 32-byte random token as a cookie; only its SHA-256 hash is
  stored in `sessions`. Every request re-resolves `req.user` from that hash.

**Owner admin actions:** `/admin` → `loadPanel()` fetches
`/codes`, `/users`, `/roles` (all `owner`-guarded) and wires mutations. Note the
asymmetry: assigning a role uses `POST /users/:id/role` with the role **name**,
and the server refuses to change an existing Owner (`setRole` is the one place
the Owner role is deliberately protected).

### Static file serving

- `express.static(publicDir)` first (index disabled, dotfiles denied).
- A **legacy root fallback** serves only top-level browser assets
  (`.html/.css/.js/.ico/.png/.jpg/.jpeg/.webp/.svg/.woff/.woff2`) and never
  `server.js` or config files. Preserve that regex guard.
- `/` and `/index.html` resolve `public/index.html`, then root `index.html`.
- `/login` and `/app` have explicit routes (extensionless paths are not mapped
  by `express.static`) serving `public/login.html` and `public/app.html`.
  `/app` is guarded client-side only: `shell.js` redirects to
  `/login?next=/app` when `/api/me` returns no user. All data endpoints are
  still server-guarded, so this is a UX redirect, not a security boundary.

---

## 4. Environment & configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | No | Postgres connection string. Absent → memory mode. Treat as a credential. |
| `ADMIN_PASSWORD` | **Yes** | Owner (`rube`) password. Max 72 UTF-8 bytes (bcrypt). Required at startup — the app exits with an error if missing. Changing it on a later deploy resets the owner password (but redeploying with the same value is a no-op). |
| `NODE_ENV` | No | `production` makes session cookies `secure`. |
| `SECURE_COOKIES` | No | Set to `true` to force `secure` cookies on an HTTPS deploy that does not set `NODE_ENV=production`. |
| `PORT` | No | Defaults to `3000`. |
| `GIPHY_API_KEY` | No | Enables the GIF picker. Kept server-side only; when absent, `/api/gifs/config` reports `configured:false` and the GIF button is hidden. |

Node **>= 18** required (`package.json` `engines`). No `.env` file is committed;
`.env*` is gitignored.

---

## 5. Commands & workflows

```bash
npm install          # install dependencies
npm start            # node server.js — serves on http://localhost:3000
```

There are **no** build, lint, or test scripts. Verify changes manually (see
§13). Do not add a build step.

Deployment: via the Render Blueprint (`render.yaml`) or manually. See
`FIX.txt` for the full procedures. Key facts: `npm install` build command,
`npm start` start command, `/health` health check, internal DB URL for the
service, external DB URL for backup/restore from your machine, same region for
both resources.

---

## 6. Data model & storage

Postgres schema (created idempotently with `CREATE TABLE IF NOT EXISTS`):

- **roles** — `name` PK, `color`. Unique index on `lower(name)`.
- **users** — `id` serial PK, `username` unique, `password` (bcrypt hash),
  `role` FK→roles, `created_at`.
- **codes** — `id`, `code` unique, `room`, `active`, `admin_only`, `created_at`.
  Codes are the room join keys.
- **messages** — `id`, `room` FK→codes(code) `ON DELETE CASCADE`, `username`,
  `role` FK→roles, `text`, `gif_url` (nullable, allowlisted https URL),
  `client_id` UUID, `created_at`, unique `(room, username, client_id)` for
  idempotent sends.
- **comments** — `id`, `post_id`, `username`, `text`, `created_at`.
- **sessions** — `token_hash` PK, `user_id` FK→users `ON DELETE CASCADE`,
  `expires_at`.
- **memberships** — `(user_id, code)` PK, both FKs with cascade delete.
- **app_meta** — `name` PK; a `seed-rooms-v1` marker prevents re-seeding rooms.
- **friendships** — `(user_a, user_b)` PK normalized to min/max IDs,
  `requester_id`, `status` (`pending`/`accepted`), `dm_code` FK→codes(code),
  `created_at`. Accept is idempotent and creates the DM code + memberships.
- **message_reactions** — `(message_id, user_id, emoji)` PK, cascades with
  messages. Emoji set is a fixed allowlist.
- **notifications** — `id`, `user_id`, `type`, `actor_id`, `payload` (JSON text),
  `read`, `created_at`; keep newest 50 per user.

Seeds: default roles `Owner, Admin, Mod, VIP, Member` with fixed colors; rooms
`MOON123` (Moon Room), `VIP99` (VIP Room), `ADMIN` (Admin Chat, `admin_only`);
owner user `rube`. An existing `admin` Owner is renamed to `rube` on startup
(messages, sessions and memberships are preserved). If a regular user already
holds `rube`, they are moved to `rube_<id>` first so they cannot be promoted to
Owner by accident; if `rube` is already an Owner, the legacy account is left
alone and a warning is logged.

Retention (`prune()`, hourly): messages keep newest 500 per room and delete
older than 14 days; comments keep newest 200 per post and delete older than 14
days; expired sessions and notifications older than 14 days (or beyond 50 per
user) deleted. `message_reactions` cascade with messages. Memory store mirrors
these limits.

Free Postgres expires after ~30 days — back up before expiry (see `FIX.txt`).
Keep dumps private (they contain password hashes).

---

## 7. HTTP API reference

All routes are under `/api`, return JSON, and use the `wrap()` guard. `login`
means a session is required; `owner` additionally requires `role === 'Owner'`.

| Method | Path | Guard | Purpose |
|---|---|---|---|
| POST | `/auth/register` | — | Create user (Member) + session. Username `a–z0–9_` 3–20; password 6–72 bytes. IP rate limited. |
| POST | `/auth/login` | — | Login + session. IP rate limited. |
| POST | `/auth/logout` | — | Invalidate session, clear cookie. |
| GET | `/me` | — | Current user or null. |
| GET | `/codes` | login + owner | List all codes. |
| POST | `/codes` | login + owner | Generate a random 6-char code for a named room (1–80 chars); optional `admin_only`. |
| POST | `/codes/:code/validate` | login + owner | Set `active = true`. |
| POST | `/codes/:code/invalidate` | login + owner | Set `active = false`. |
| DELETE | `/codes/:code` | login + owner | Delete code, its messages, and memberships. |
| POST | `/codes/:code/join` | login | Validate code and join room (owner bypasses `admin_only`). Deliberately a POST because it writes a membership. |
| GET | `/rooms` | login | Rooms the user has joined that are active. |
| GET | `/rooms/:code/messages` | login | Poll messages; optional `?after=<id>` cursor; max 100 per call. |
| POST | `/rooms/:code/messages` | login | Send message (≤1000 chars) with optional `client_id` UUID for idempotency. Rate limited. |
| GET | `/posts/:id/comments` | — | Comments for post id 1–6; newest 200. |
| POST | `/posts/:id/comments` | — | Add comment (≤500 chars); name from session or `Guest`. Rate limited. |
| GET | `/users` | login + owner | List users. |
| POST | `/users/:id/role` | login + owner | Assign a non-Owner role. |
| GET | `/roles` | login + owner | List roles. |
| POST | `/roles` | login + owner | Create role: name 1–24 `[a-z0-9 _-]`, color `#rrggbb`. |
| POST | `/rooms/:code/messages/:id/reactions` | login | Add a fixed-set emoji reaction. Rate limited. |
| DELETE | `/rooms/:code/messages/:id/reactions/:emoji` | login | Remove own reaction. |
| GET | `/gifs/config` | — | Whether `GIPHY_API_KEY` is configured. |
| GET | `/gifs/search?q=` | login | Giphy proxy; sanitized results, memory-cached 5 min. Rate limited. |
| GET | `/users/search?q=` | login | Username substring (2–20 chars), max 20 results, excludes self, projection only. |
| POST | `/friends/request` | login | Send request by username. Rate limited; 20 pending max. |
| GET | `/friends` | login | `{ friends, incoming, outgoing }`. |
| POST | `/friends/:id/accept` | login | Accept pending request; creates DM room. |
| POST | `/friends/:id/decline` | login | Decline incoming request. |
| POST | `/friends/:id/cancel` | login | Cancel outgoing request. |
| DELETE | `/friends/:id` | login | Unfriend; deletes DM room and messages. |
| GET | `/notifications` | login | Newest 50 notifications for the user. |
| POST | `/notifications/read` | login | Mark all notifications read. |

Validation helpers: `string`, `credentials`, `textValue`, `messageText`,
`roomCode` (uppercased, `^[A-Z0-9]{1,12}$`), `intParam`, `isGifMediaUrl`.
`textValue`/`messageText` reject the command words from being stored as
content. `messageText` allows empty text only when a valid `gif_url` is sent.
Keep server-side validation authoritative — the browser checks are convenience
only.

---

## 8. Frontend structure

`public/index.html` is markup only. It loads `css/{base,blog,chat,social}.css`
in that order (cascade order matters — `chat.css` holds the media queries), then
seven deferred **classic** scripts in this order:
`core.js → blog.js → chat.js → admin.js → social.js → gifs.js → app.js`.

Classic scripts share the global lexical scope: top-level `const`/`let`/`function`
from one file are visible in the others. Do NOT add imports/exports or convert
to ES modules. Function declarations are available by the time `app.js` runs,
so later files may call functions defined in earlier ones.

DOM regions:
- `#blog` — public blog: header/nav (with hidden friend/notification buttons),
  hero, `#posts` cards, wake banner (`#wake`), announcements (`#announcement`).
- Dialogs: `#auth-dialog`, `#rooms-dialog`, `#profile-dialog`, `#friends-dialog`
  (Friends / Requests / Add tabs), `#gifs-dialog`, `#notifications-dialog`.
- `#private` — dark private screen: `.inbox`, `.chat` (composer has `#gif-open`
  and `#gif-preview`), `.owner-pane`. Toasts live in `#toasts`.

Key state (in `core.js`): `user`, `savedCommand`, `authMode`, `room` (with
`lastId`, `ids`, `pending`), `pollTimer`, `pollRequest`, `wakeCount`,
`pollWaiting`, `panelAllowed`, `selectedGif`, and the `*RequestId` guards.

Important flows:
- `blog.js`: `renderPosts()` / `viewBlog()` — 6 hard-coded posts and hash views.
- `core.js`: `parseCommand()` / `runCommand()` — commands typed in a comment or
  chat box; reopens auth on 401 and resumes after login (also handles the
  `friends`, `notifications`, `gifs` commands).
- `core.js`: `api()` / `readWithBackoff()` — fetch with abort, 22s timeout,
  wake-banner tracking, exponential backoff on 5xx. `toast()` shows transient
  messages; `isGifMediaUrl()` mirrors the server-side URL check.
- `chat.js`: `poll()` (2s normal / 10s error, `after` cursor, dedupe via
  `current.ids`), `send()` (optimistic UUID `client_id`, optional `gif_url`),
  `messageNode()` (renders `.message-gif` and `.reactions`), `reactionControls()`.
- `social.js`: `openFriends()`/`loadFriends()` (debounced-by-request-ID search,
  Accept/Decline/Cancel/Remove), `refreshBadges()` (15s poll + toasts),
  `openNotifications()`.
- `gifs.js`: `initGifs()` hides the button when `configured:false`;
  `gifSearch()` → `selectGif()` → `useGif()` sets `selectedGif` for the composer.
- `admin.js`: `loadPanel()` loads codes/users/roles and wires owner mutations.
- `app.js`: all event listeners and startup (`initGifs()`, `ready.then(...)`).

Styling: light palette on `:root`, dark theme scoped to `.private-screen` and
`.private-dialog`. `social.css` adds badges, toasts, GIF grid, reactions.
Responsive breakpoints 1024/900/700/540px; `prefers-reduced-motion` respected.
Accessibility (`aria-*`, `.sr`, focus management) is intentional — keep it.

### Chat app page (`/app`)

`app.html` deliberately reuses the **same element IDs** as the private screen
(`#private`, `#workspace`, `#inbox-rooms`, `#chat`, `#messages`, `#chat-form`,
`#gif-open`, `#owner-pane`, `#toasts`, `#wake`, plus all dialog IDs). This lets
it load `core.js`, `chat.js`, `admin.js`, `social.js`, and `gifs.js` unchanged —
compact bubbles, grouping, reactions, GIF picker, friend actions, and
`refreshBadges()` all work without duplicated code. It does **not** load
`app.js` (the blog's wiring); `shell.js` supplies the equivalent listeners plus
app-specific behavior. `app.css` restyles the shared DOM into three columns.

`shell.js` responsibilities: auth redirect, sidebar user header, Chats/Friends/
Rooms tabs, chat list (last-message previews fetched client-side from
`/rooms/:code/messages`, capped to joined rooms), details pane, notifications
drawer, and wiring for the reused dialogs. Unread dots are derived from
`notifications` payloads that carry a room code — there is no per-room unread
API. Mobile uses a `showing-chat` class on `#workspace` to swap list ↔ conversation.

Any shared-module change must keep the blog page working too: guard optional
DOM nodes (see `syncSocialButtons()` in `social.js`) rather than assuming a
button exists on both pages.

Chat visual direction (Instagram-DM inspired, Minimalism + micro-interactions):
compact bubbles (5–10px padding, `max-width:min(82%,78ch)`, 16px radius with a
5px tail), 3px message gaps, 56px header, pill composer with circular send
button, `Today` divider, and consecutive messages from the same author grouped
via `data-author` + `.grouped` (author/badge hidden, time-only meta). Structural
icons are inline SVG, **not** emoji; emoji are reserved for reactions/content.
Bubble and press animations are transform/opacity only (no layout shift) and
are disabled under `prefers-reduced-motion`. Keep touch targets ≥24px
(44px header/composer icon buttons) and ≥8px gaps between adjacent controls.

---

## 9. Security model

- Sessions: 32-byte random token, only its SHA-256 hash stored; cookie
  `httpOnly`, `sameSite=lax`, `path=/`, `secure` in production, 30-day expiry.
  Logging in ends the previous session.
- Passwords: `bcryptjs` (v3) cost 10; 72-byte maximum enforced on both register
  and login, and on `ADMIN_PASSWORD` at boot. `bcrypt.compare` is also called
  with overlong input guarded, so an overlong password cannot cause a crash or
  an account-enumeration timing difference.
- Rate limits: auth 10 per 15 min per IP; posts 20 per min per user (or IP for
  guests). `limiter()` implements a true sliding window with a `Retry-After`
  header. Counts are kept in memory per process and reset on restart; a
  multi-instance deployment would need a shared store.
- Authorization: owner-only endpoints guard on `req.user.role === 'Owner'`;
  room `admin_only` checks; non-owners must have a membership to post; owners
  bypass membership and admin-only rooms.
- CSRF: there is no CSRF token. Safety relies on `SameSite=Lax` cookies plus the
  rule that **every state-changing endpoint is a non-GET request** (even joining
  a room). Keep new mutations on POST/DELETE; adding a GET that writes state
  reopens the hole. `SameSite=Lax` also means cross-site POSTs do not carry the
  cookie, which is the actual CSRF barrier here.
- Login returns the same `401 Wrong password` for an unknown user and a bad
  password so accounts cannot be enumerated.
- Input validation is server-side and strict; payloads capped at 10kb.
- Giphy: the API key is read only from `GIPHY_API_KEY` on the server and never
  sent to the browser. The proxy returns only sanitized https URLs on
  `giphy.com`/`*.giphy.com`; `isGifMediaUrl()` is enforced again when sending a
  message. Results are cached in memory (5 min, 200-query cap). A failed or
  unconfigured provider degrades to a hidden button — never a broken app.
- User search requires login, is rate limited, and returns only
  `{id, username, role}`; `strpos(lower(...), lower(...))` avoids `LIKE`
  wildcard injection. Friend actions verify direction (requester vs recipient)
  server-side — never trust the client for accept/decline/cancel.
- Notifications are per-user; `GET /notifications` cannot read another user's
  events. Reactions are per `(message, user, emoji)` and rate limited.
- Never log secrets. `ADMIN_PASSWORD` is required from the environment and is
  never generated or printed; startup only reports its absence or invalid length.

---

## 10. Conventions & style rules for edits

- Backend: CommonJS `require`, `'use strict';`, async/await with 2-space
  indentation, `const` by default. Use `HttpError` for expected failures and
  throw into the central error middleware; don't write ad-hoc `res.status`
  error responses in handlers.
- When adding an API endpoint: define it on `api` with `wrap(...)`, add guards,
  validate inputs, and mirror any storage change in **both** `postgres` and
  `memoryStore`, plus the corresponding client call in `index.html`.
- Keep `app.disable('x-powered-by')` and `trust proxy` settings.
- Frontend: vanilla ES2020+ DOM APIs, `element()`/`button()`/`status()` helpers,
  `textContent` (not `innerHTML`) for user data. No external scripts/styles.
- Preserve the split-file, no-build structure: add new code to the appropriate
  `public/js/*.js` or `public/css/*.css` file, keep `index.html` as markup, and
  keep classic-script load order in `index.html` (shared globals, no modules).
- Docs: keep `README.md` short; put detailed ops info in `FIX.txt`; reflect
  behavior changes in this file too.

---

## 11. Deployment & operations notes

- Render Blueprint (`render.yaml`) creates a free web service and free Postgres
  in Singapore; `DATABASE_URL` comes from the database, `ADMIN_PASSWORD` and
  `GIPHY_API_KEY` are set manually (`sync: false`), `NODE_ENV=production`.
- Use the **internal** DB URL for the service; **external** URL for backup and
  restore from your own machine. Both resources must be in the same region.
- `/health` checks the web process only, not DB connectivity. A stuck wake-up
  banner usually means a bad/unreachable `DATABASE_URL` — check logs.
- Free web services sleep after ~15 min idle; first request can take 30–60s.
  The client wake-up banner and backoff are designed for this — don't remove.
- Forgot owner password: set a new `ADMIN_PASSWORD` and redeploy; startup
  updates the DB and invalidates sessions issued under the old password.
  Username stays `rube`.
- Backup/restore commands are documented in `FIX.txt`. Restore into an empty
  DB before starting the app against it so seeding doesn't conflict.

---

## 12. Gotchas / do-not-break list

- Do **not** introduce a build step, framework, or ES modules. The frontend is
  intentionally split into plain files but has no bundler and no package
  imports. Keep the classic-script load order in `index.html` intact.
- Do **not** let the root static fallback serve `server.js`, config, dotfiles,
  or dependencies (keep the allow-list regex and `server.js` exclusion).
- Do **not** silently fall back from an unreachable `DATABASE_URL` to memory
  mode — missing and unreachable are deliberately different.
- Keep the `ready` gate and client-side retry/backoff; cold starts depend on it.
- Keep both storage adapters in sync; memory mode must behave like Postgres.
- Respect the bcrypt 72-byte limit for any password handling.
- Post IDs are only 1–6 (`intParam(..., 1, 6, ...)`); adding posts requires
  changing both the frontend `posts` array and the server limit.
- Room codes are uppercased and validated as `^[A-Z0-9]{1,12}$`.
- Message/comment retention limits (500/200, 14 days) and the 100-message poll
  page size are deliberate; change with care.
- `client_id` idempotency and `FOR NO KEY UPDATE` row locking prevent duplicate
  or skipped messages during polling — preserve this behavior.
- Never store command words (`/join`, `/admin`, `/rooms`, `/logout`, `/app`) as content.
- Keep every state-changing endpoint non-GET; joining a room is `POST
  /codes/:code/join` for exactly this reason.
- `ADMIN_PASSWORD` is authoritative on boot: changing it in the environment
  resets the owner password on restart. The stored hash is only rewritten when
  it no longer matches, so redeploying with the same value is a no-op.
- The two storage adapters (`postgres` and `memoryStore`) intentionally
  duplicate the same interface. There is no shared shim — keep them in lockstep.
  A quick way to check: compare the method lists of `postgres` and the object
  returned by `memoryStore()`; they should match exactly.
- `migrateOwnerUsername()` normalizes the legacy `admin` Owner to `rube` while
  preserving sessions/messages/memberships, and renames a conflicting regular
  user aside. Do not "simplify" this migration — it is what keeps existing DBs
  from losing their Owner or accidentally promoting a regular user.
- `CSS` cascade order is load order: `base → blog → chat → social`. `chat.css`
  deliberately contains the responsive media queries; moving them earlier
  would let later rules override mobile layout. Verify the mobile view after
  any CSS file changes.
- DM rooms are ordinary `codes` rows with memberships, so they show up in
  `/rooms` and the owner panel. Do not add a separate DM message path — the
  existing `messages()` adapter handles them. Unfriend deletes the DM code,
  which cascades its messages and reactions in Postgres and is done explicitly
  in the memory adapter's `removeFriend`.
- Accept must stay idempotent and must not create a second DM room on repeated
  calls (`dm_code` guard). Friend request direction is enforced in SQL by the
  `requester_id <> $1` / `= $1` clauses — do not move that check to the client.
- `requests()` must return `id` as the **other** person in the pair: the
  requester for incoming rows, the recipient for outgoing rows. The UI passes
  `person.id` into accept/decline/cancel; returning the requester's own id for
  outgoing rows makes Cancel always fail with 400. Both adapters use a
  direction-aware CASE/branch for this.
- Reactions include `count` and `mine` in every message payload via
  `withReactions()`. Both adapters' `reactions()` must return the same shape.
  A poll refreshes reaction state, so optimistic client updates are temporary.
- GIF URLs are validated twice (proxy output and send input) against
  `giphy.com` hosts. Never accept arbitrary image URLs — that would open
  tracking/SSRF-style abuse. The Giphy key must never appear in client code or
  logs.
- When editing shared frontend modules (`core.js`, `chat.js`, `social.js`,
  `gifs.js`, `admin.js`), both `/` and `/app` load them. A function that
  dereferences an element only present on one page must guard for `null`.
  `app.html` must keep the shared element IDs in sync with the blog page.

### Change-safety map

Before finishing any change, find your change in the left column and run the
matching verification on the right (full steps in §13):

| You changed… | Verify |
|---|---|
| An API route or guard | Call it with no session (expect 401), as Member (expect 403 for owner routes), as Owner (expect success). #4, #7, #9 |
| Either storage adapter | Run once in memory mode and once with `DATABASE_URL`; confirm data persists only in the latter. #8; compare adapter method lists |
| Schema / seeds / owner logic | Start against a fresh DB and an existing DB; confirm roles, rooms, and `rube` are correct and data is preserved. #6, #8 |
| Boot / readiness / client retry | Restart with a bad `DATABASE_URL`; confirm API stays 503, `/health` still answers, and the wake banner shows. #1, #2 |
| Frontend async UI (poll/send/panel) | Open two browser sessions and confirm messages appear in both without duplicates; switch rooms quickly to test stale-response guards. #5, #6 |
| Validation / rate limits | Try bad usernames, oversized text, invalid codes; confirm clean JSON errors and 429 after the limit. #9 |
| Friends / DMs | Register two users, request → accept → message → unfriend; confirm the DM disappears and its messages are gone. #10 |
| Reactions / GIFs | React from two sessions and confirm counts; send a message with only a `gif_url`; try an off-host GIF URL and confirm 400. #11, #12 |
| Giphy proxy | Start with no key: button hidden, `/api/gifs/config` false. With a key: search returns only allowlisted URLs. #12 |

---

## 13. Validation checklist (no automated tests exist)

There is no test suite, lint, or build step, so manual smoke-testing is the only
verification. Do not skip it — use the **change-safety map** above to pick the
relevant subset, and run the full list for larger changes.

After changes, smoke-test manually:

1. `npm install && npm start`; open `http://localhost:3000`.
2. Check `/health` reports the expected mode.
3. Blog loads, hash nav works, comments post and appear.
4. Register/login/logout; verify session cookie and `/me`.
5. Type `/join MOON123` in a comment box → private chat opens; send and poll
   messages (open two browser sessions to confirm delivery).
6. Log in as `rube`, type `/admin` → admin panel opens; create a code, validate
   /invalidate, delete, assign a role, create a role.
7. In `/users` / `/roles` flows, confirm non-owners get `Access Denied`.
8. With `DATABASE_URL` unset, restart and confirm memory-mode data resets; with
   it set, confirm persistence.
9. Exercise validation errors (bad username, oversized text, invalid code) and
   confirm clean JSON errors, not stack traces.
10. With two accounts: search, send a request, Accept (and separately Decline
    and Cancel), open the DM, send a GIF-only message, then Unfriend and confirm
    the DM room and its messages are gone.
11. React to a message from two accounts; confirm both see the same count and
    the `mine` state is per-user. Confirm reactions survive a page reload.
12. With `GIPHY_API_KEY` unset, confirm the GIF button is hidden and
    `/api/gifs/config` returns `configured:false`. With a key, search for a GIF,
    insert it, and send it. Confirm an `https://evil.com/...` `gif_url` is
    rejected with 400.
13. Visit `/login` while signed out: register and confirm redirect to `/app`.
    Confirm `/app` redirects to `/login?next=/app` when signed out. On `/app`,
    verify the chat list, Friends/Rooms tabs, details pane, notifications drawer
    + mark-read, sending a message, and sign-out returning to `/login`.
14. Confirm the blog's command flow (`/join`, `/rooms`, `/admin`) still works
    after any shared-module change.
15. Type `/app` in a post comment box: it opens the chat app; when signed out it
    lands on `/login?next=/app`. Posting `/app` as plain text is rejected.

If deployment behavior changed, also validate the Render steps in `FIX.txt`.
If you changed documentation, keep `README.md` short, `FIX.txt` authoritative
for ops, and this file authoritative for architecture — update all that apply.
