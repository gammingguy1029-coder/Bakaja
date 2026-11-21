'use strict';
const $ = id => document.getElementById(id);
let user = null, savedCommand = null, authMode = 'login', room = null, pollTimer, pollRequest;
let wakeCount = 0, pollWaiting = false, panelAllowed = false;
let roomRequestId = 0, roomsRequestId = 0, inboxRequestId = 0;
const authDialog = $('auth-dialog'), roomsDialog = $('rooms-dialog'), profileDialog = $('profile-dialog');
const list = $('messages');
const compact = matchMedia('(max-width:900px)');
const msgTime = new Intl.DateTimeFormat(undefined,{ hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
let selectedGif = null; // GIF chosen in the picker, sent with the next chat message
const dmLabel = (a, b) => `DM: ${[a, b].sort().join(' & ')}`.slice(0, 80);
function isGifMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'giphy.com' || url.hostname.endsWith('.giphy.com'));
  } catch { return false; }
}
function toast(message, error = false) {
  const node = element('div',`toast${error ? ' error' : ''}`,message);
  $('toasts').append(node);
  setTimeout(() => node.remove(), 5500);
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = 'quiet') {
  const node = element('button',className,text);
  node.type = 'button';
  node.addEventListener('click',action);
  return node;
}
function status(id, message = '', error = false) {
  const node = typeof id === 'string' ? $(id) : id;
  node.textContent = message;
  node.classList.toggle('error',error);
}
const WAKE_TEXT = 'Waking up the server, please wait...';
function syncWake() {
  const node = $('wake');
  const visible = pollWaiting || wakeCount > 0;
  if (visible && node.dataset.error) { node.textContent = WAKE_TEXT; delete node.dataset.error; }
  node.hidden = !visible;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve,ms)); }
async function api(path, { method = 'GET', body, signal, showWake = false } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{ once:true });
  let counted = false;
  const wakeTimer = showWake ? setTimeout(() => { counted = true; wakeCount++; syncWake(); },1400) : undefined;
  const timeout = setTimeout(abort,22000);
  try {
    const response = await fetch(`/api${path}`, {
      method, signal:controller.signal, credentials:'same-origin', cache:'no-store',
      ...(body === undefined ? {} : { headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const error = new Error(data?.error || 'The server is temporarily unavailable.');
      error.status = response.ok ? 503 : response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof TypeError || error.name === 'AbortError') {
      const offline = new Error('Connection interrupted. Please try again.');
      offline.status = 503;
      throw offline;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort',abort);
    clearTimeout(timeout); clearTimeout(wakeTimer);
    if (counted) { wakeCount--; syncWake(); }
  }
}
async function readWithBackoff(path, maxAttempts = 5, options = {}) {
  let wait = 1000, counted = false;
  try {
    for (let attempt = 1; ; attempt++) {
      try { return await api(path,{ showWake:true, ...options }); }
      catch (error) {
        if (error.status < 500 || attempt >= maxAttempts) throw error;
        if (!counted) { counted = true; wakeCount++; syncWake(); }
        await delay(wait);
        wait = Math.min(wait * 2,10000);
      }
    }
  } finally { if (counted) { wakeCount--; syncWake(); } }
}
async function initialize() {
  // 12 attempts cover a ~60s Render cold start, but must give up eventually so
  // the rest of the UI (comments, dialogs) is not left waiting on `ready`.
  try { user = (await readWithBackoff('/me',12)).user; }
  catch (error) {
    const message = error.message || 'Could not connect to the server. Please reload.';
    status('announcement',message,true);
    $('wake').textContent = message;
    $('wake').dataset.error = 'true';
    $('wake').hidden = false;
  }
}
const ready = initialize();
function parseCommand(text) {
  const match = /^\/(join|admin|rooms|logout|app)(?=\s|$)(?:\s+([\s\S]*))?$/i.exec(text);
  return match ? { name:match[1].toLowerCase(), code:(match[2] || '').trim().toUpperCase() } : null;
}
function authView(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('auth-title').textContent = register ? 'Register' : 'Login'; $('auth-submit').textContent = register ? 'Register' : 'Login';
  $('auth-toggle').textContent = register ? 'Switch to Login' : 'Switch to Register';
  status('auth-status');
}
function openAuth(command, target) {
  savedCommand = { command, target };
  if (roomsDialog.open) roomsDialog.close();
  if (profileDialog.open) profileDialog.close();
  $('auth-form').reset(); authView('login');
  if (!authDialog.open) authDialog.showModal();
}
async function runCommand(command, target) {
  status(target);
  await ready;
  try {
    if (command.name === 'logout') {
      await api('/auth/logout',{ method:'POST', showWake:true });
      user = null; savedCommand = null;
      if (authDialog.open) authDialog.close();
      if (roomsDialog.open) roomsDialog.close();
      if (typeof syncSocialButtons === 'function') syncSocialButtons();
      leavePrivate();
      location.hash = '#home';
      status('announcement','Logged out.');
      return;
    }
    // /app is a navigation, not a data action — signed-out users are handled
    // by the app's own redirect to /login?next=/app.
    if (command.name === 'app') { location.assign('/app'); return; }
    if (!user) { openAuth(command,target); return; }
    switch (command.name) {
      case 'join': await openRoom(command.code); break;
      case 'rooms': await openRooms(); break;
      case 'friends': openFriends(); break;
      case 'notifications': openNotifications(); break;
      case 'gifs': openGifPicker(); break;
      case 'admin':
        user = (await readWithBackoff('/me')).user;
        if (!user) { openAuth(command,target); return; }
        if (user.role !== 'Owner') throw new Error('Access Denied - Owner Only');
        await openAdmin(); break;
    }
  } catch (error) {
    if (error.status === 401 && command.name !== 'logout') { user = null; openAuth(command,target); return; }
    status(target,error.message,true);
  }
}
function avatar(name, crown = false) {
  const words = name.trim().split(/\s+/);
  const initials = words.slice(0,2).map(word => Array.from(word)[0] || '').join('').toUpperCase();
  const node = element('span',`avatar${crown ? ' owner-avatar' : ''}`,crown ? '♛' : initials || '#');
  node.setAttribute('aria-hidden','true');
  return node;
}
function showProfile(account) {
  if (!account || $('private').hidden) return;
  const owner = account.role === 'Owner';
  const self = account.username === user?.username;
  const badge = badgeFor(account.role,account.color);
  if (owner) badge.classList.add('owner-badge');
  $('profile-title').textContent = self ? 'Your profile' : 'Chat profile';
  $('profile-identity').replaceChildren(avatar(account.username,owner),element('h3',null,`@${account.username}`),badge);
  const banner = $('profile-banner');
  banner.classList.toggle('owner-banner',owner);
  banner.textContent = owner ? 'ShadowBlog Owner · Manages private rooms, invite codes, and access.' : self ? 'This is how your account appears to others in chat.' : 'Private chat member';
  if (!profileDialog.open) profileDialog.showModal();
}
function badgeFor(role, color) {
  const badge = element('span','badge',role === 'Owner' ? 'OWNER' : role);
  badge.style.setProperty('--role-color',/^#[a-f0-9]{6}$/i.test(color || '') ? color : '#555d6d');
  return badge;
}
function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(n => n.toString(16).padStart(2,'0')).join('');
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
}
