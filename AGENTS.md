# AGENTS.md — ShadowBlog

Guidance for AI agents and contributors working in this repository. Read this
before making changes. This document describes the project's architecture,
conventions, and invariants so edits stay consistent and do not break the app.

---

## 1. Overview

**ShadowBlog** is a small, self-contained web app: a responsive study blog with
code-based private chat rooms and an Owner-only admin panel.

Defining constraints — respect these in every change:

- **No build step.** Plain HTML, CSS, and JavaScript. No bundler, transpiler,
  TypeScript, or framework. Node serves files as-is.
- **Backend is a single file.** `server.js` contains the entire Express server,
  storage layer, and API. Keep it that way; do not split it into modules unless
  explicitly asked.
- **Frontend is a single file.** `public/index.html` holds inline `<style>` and
  `<script>`. Keep it dependency-free and inline.
- **CommonJS + `'use strict'`.** The backend uses `require(...)` and starts with
  `'use strict';`. Do not convert to ESM.
- **Dual storage modes.** PostgreSQL when `DATABASE_URL` is present, otherwise
  an in-memory store that resets on restart. Both must stay functionally
  equivalent.

---

## 2. Repository layout

| Path | Purpose |
|---|---|
| `server.js` | Entire backend: Express app, storage adapters (Postgres + memory), REST API, auth, static serving, error handling, boot sequence. |
| `public/index.html` | Entire frontend: public blog, private chat UI, admin panel, all CSS and JS inline. |
| `package.json` | `shadowblog` v1.0.0, private, Node >= 18, `start` script = `node server.js`. |
| `package-lock.json` | Lockfile v3 (committed; keep dependencies reproducible). |
| `render.yaml` | Render Blueprint: free web service + free PostgreSQL (Singapore), `/health` check. |
| `FIX.txt` | Human-facing deployment, troubleshooting, private commands, retention, and backup/restore guide. |
| `README.md` | Short overview and quick start. |
| `.gitignore` | Ignores `node_modules/`, `.env`, `.env.*`, `*.dump`, `*.sql`, logs, `/out/`. |

Treat `FIX.txt` as the source of truth for deployment and operational
procedures; update it when deployment behavior changes.

---

## 3. Architecture & runtime model

### Startup (`boot()` at the bottom of `server.js`)

1. `app.listen(PORT || 3000, '0.0.0.0')` starts immediately.
2. `boot()` calls `store.init()` up to 6 times with 3s backoff; on total failure
   it retries every 30s via `setTimeout`.
3. `init()` creates the schema, seeds default roles and rooms, and ensures the
   `rube` owner account. If `ADMIN_PASSWORD` was unset, a one-time generated
   password is printed to the console (shown once only).
4. `ready = true` only after init + initial `prune()` succeed. A hourly
   `setInterval` runs `prune()` (unref'd).
5. While `!ready`, API routes return `503` with `Retry-After: 3` and the message
   "Waking up the server, please wait...". Do not remove this gate — Render free
   instances sleep and cold starts are common.

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
  `users`, `roles`, `createRole`, `setRole`. Any change to this interface must be
  made in **both** adapters.

### Request lifecycle

`app.use('/api', api)` mounts all API routes under `/api`. Middleware order
matters: `Cache-Control: no-store`, then `express.json({ limit: '10kb' })` and
`cookieParser()`. `wrap(handler, login, owner)` wraps every API route: checks
`ready`, resolves the session cookie into `req.user`, enforces `login`/`owner`
guards, and funnels errors to `next`. `HttpError(status, message)` is the
expected error type; the final error middleware maps it to JSON, handles payload
size/parse errors, and returns 503 for transient DB connectivity errors.

### Static file serving

- `express.static(publicDir)` first (index disabled, dotfiles denied).
- A **legacy root fallback** serves only top-level browser assets
  (`.html/.css/.js/.ico/.png/.jpg/.jpeg/.webp/.svg/.woff/.woff2`) and never
  `server.js` or config files. Preserve that regex guard.
- `/` and `/index.html` resolve `public/index.html`, then root `index.html`.

---

## 4. Environment & configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | No | Postgres connection string. Absent → memory mode. Treat as a credential. |
| `ADMIN_PASSWORD` | No | Owner password. Max 72 UTF-8 bytes (bcrypt). If unset at first run, a random password is generated and logged once. Setting it on later deploys updates the owner password in the DB. |
| `NODE_ENV` | No | `production` makes session cookies `secure`. |
| `SECURE_COOKIES` | No | Set to `true` to force `secure` cookies on an HTTPS deploy that does not set `NODE_ENV=production`. |
| `PORT` | No | Defaults to `3000`. |

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
  `role` FK→roles, `text`, `client_id` UUID, `created_at`, unique
  `(room, username, client_id)` for idempotent sends.
- **comments** — `id`, `post_id`, `username`, `text`, `created_at`.
- **sessions** — `token_hash` PK, `user_id` FK→users `ON DELETE CASCADE`,
  `expires_at`.
- **memberships** — `(user_id, code)` PK, both FKs with cascade delete.
- **app_meta** — `name` PK; a `seed-rooms-v1` marker prevents re-seeding rooms.

Seeds: default roles `Owner, Admin, Mod, VIP, Member` with fixed colors; rooms
`MOON123` (Moon Room), `VIP99` (VIP Room), `ADMIN` (Admin Chat, `admin_only`);
owner user `rube`. An existing `admin` Owner is renamed to `rube` on startup
(messages, sessions and memberships are preserved). If a regular user already
holds `rube`, they are moved to `rube_<id>` first so they cannot be promoted to
Owner by accident; if `rube` is already an Owner, the legacy account is left
alone and a warning is logged.

Retention (`prune()`, hourly): messages keep newest 500 per room and delete
older than 14 days; comments keep newest 200 per post and delete older than 14
days; expired sessions deleted. Memory store mirrors these limits.

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

Validation helpers: `string`, `credentials`, `textValue`, `roomCode`
(uppercased, `^[A-Z0-9]{1,12}$`), `intParam`. `textValue` rejects the command
words from being stored as messages/comments. Keep server-side validation
authoritative — the browser checks are convenience only.

---

## 8. Frontend structure (`public/index.html`)

DOM regions:
- `#blog` — public blog: header/nav, hero, `#posts` cards, wake banner
  (`#wake`), screen-reader announcements (`#announcement`).
- Dialogs: `#auth-dialog` (login/register), `#rooms-dialog` (list + join),
  `#profile-dialog`.
- `#private` — dark private screen: `.inbox` room list, `.chat` (header,
  status, `#messages` log, composer), `.owner-pane` admin panel.

Key state (declared near the top of the script): `user`, `savedCommand`,
`authMode`, `room` (with `lastId`, `ids`, `pending`), `pollTimer`,
`pollRequest`, `wakeCount`, `pollWaiting`, `panelAllowed`, and several
`*RequestId` guards.

Important flows:
- `renderPosts()` / `viewBlog()` — build the 6 hard-coded posts and switch
  hash views (`home`, `notes`, `study-tips`, `about`).
- `parseCommand()` — recognises `/join`, `/admin`, `/rooms`, `/logout` typed in
  any comment or chat box; `runCommand()` dispatches them and reopens the auth
  dialog on 401, resuming the saved command after login.
- `api()` / `readWithBackoff()` — fetch wrapper with abort support, 22s timeout,
  wake-banner tracking, and retry with exponential backoff on 5xx.
- Polling: `poll()` fetches new messages with an `after` cursor, deduplicates via
  `current.ids`, scrolls only when near the bottom or on own messages, and
  reschedules itself (2s normal, 10s on error). `stopPoll()` aborts on leave or
  tab hide.
- Optimistic send: `send()` posts with a generated UUID `client_id`; the saved
  message replaces the pending node; failures offer a "tap to retry" button.
- Request-ID guards (`roomRequestId`, `roomsRequestId`, `inboxRequestId`,
  `panelLoadId`) discard stale responses. Preserve these when editing async UI.
- `enterChat()` / `leavePrivate()` / `showPrivate()` manage the private screen,
  `inert` states, and body class `private`.
- Owner panel: `loadPanel()` loads codes/users/roles and wires validate,
  invalidate, delete, open, role assignment, room creation, and role creation.

Styling: light palette on `:root`, dark theme scoped to `.private-screen` and
`.private-dialog` (they override CSS variables). Responsive breakpoints at
1024/900/700/540px. Respect `prefers-reduced-motion`. Accessibility features
(`aria-*`, `.sr` class, focus management) are intentional — keep them.

---

## 9. Security model

- Sessions: 32-byte random token, only its SHA-256 hash stored; cookie
  `httpOnly`, `sameSite=lax`, `path=/`, `secure` in production, 30-day expiry.
  Logging in ends the previous session.
- Passwords: `bcryptjs` cost 10; 72-byte maximum enforced everywhere.
- Rate limits: auth 10 per 15 min per IP; posts 20 per min per user (or IP for
  guests). `limiter()` implements a true sliding window. Counts are kept in
  memory per process and reset on restart; a multi-instance deployment would
  need a shared store.
- Authorization: owner-only endpoints guard on `req.user.role === 'Owner'`;
  room `admin_only` checks; non-owners must have a membership to post; owners
  bypass membership and admin-only rooms.
- CSRF: there is no CSRF token. Safety relies on `SameSite=Lax` cookies plus the
  rule that **every state-changing endpoint is a non-GET request**. Keep new
  mutations on POST/DELETE — adding a GET that writes state reopens the hole.
- Login returns the same `401 Wrong password` for an unknown user and a bad
  password so accounts cannot be enumerated.
- Input validation is server-side and strict; payloads capped at 10kb.
- Never log secrets. Generated admin password is an intentional one-time
  exception.

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
- Preserve the inline single-file structure and the no-build constraint.
- Docs: keep `README.md` short; put detailed ops info in `FIX.txt`; reflect
  behavior changes in this file too.

---

## 11. Deployment & operations notes

- Render Blueprint (`render.yaml`) creates a free web service and free Postgres
  in Singapore; `DATABASE_URL` comes from the database, `ADMIN_PASSWORD` is set
  manually (`sync: false`), `NODE_ENV=production`.
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

- Do **not** introduce a build step, framework, or separate frontend files.
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
- Never store command words (`/join`, `/admin`, `/rooms`, `/logout`) as content.
- Keep every state-changing endpoint non-GET; joining a room is `POST
  /codes/:code/join` for exactly this reason.
- `ADMIN_PASSWORD` is authoritative on boot: changing it in the environment
  resets the owner password on restart. The stored hash is only rewritten when
  it no longer matches, so redeploying with the same value is a no-op.
- The two storage adapters (`postgres` and `memoryStore`) intentionally
  duplicate the same interface. There is no shared shim — keep them in lockstep.

---

## 13. Validation checklist (no automated tests exist)

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

If deployment behavior changed, also validate the Render steps in `FIX.txt`.
