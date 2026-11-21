# ShadowBlog

A responsive study blog with code-based private chat, direct messages, friend
requests, GIF reactions, and notifications. Requires Node.js 18+ with no build
step. Run `npm install` and `npm start`, then visit `http://localhost:3000`.

Set `ADMIN_PASSWORD` (required — the app won't start without it) for the owner
account, and `DATABASE_URL` for persistent storage. On Windows you can set it
for a session with `$env:ADMIN_PASSWORD = 'your-password'` before `npm start`.
Optionally set `GIPHY_API_KEY` to enable the in-chat GIF picker; without
it the GIF button stays hidden and the rest of the app works normally. See
[FIX.txt](FIX.txt) for setup, private commands, and backup instructions.

Visit **`/login`** to sign in or register — a successful sign-in opens a
WhatsApp-style chat app at **`/app`** with a chat list, friends/rooms tabs,
conversation, details pane, and notifications. The original blog and its
comment-box commands (`/join`, `/rooms`, `/admin`, `/app`) still work — typing
`/app` in any post's comment box opens the chat app.

The frontend lives in `public/` as plain HTML, CSS, and JS files (see
[AGENTS.md](AGENTS.md) for the architecture).
