'use strict';
// Standalone sign-in page. Uses core.js's api(), ready state, and toast().
const loginForm = $('login-form'), loginError = $('login-error');
const submit = $('login-submit'), toggle = $('auth-mode-toggle');
let mode = 'login';

function nextPath() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}
function setMode(value) {
  mode = value;
  const register = value === 'register';
  $('auth-heading').textContent = register ? 'Create your account' : 'Welcome back';
  $('auth-sub').textContent = register ? 'Pick a username and password to get started.' : 'Sign in to continue to your chats.';
  submit.textContent = register ? 'Create account' : 'Sign in';
  toggle.textContent = register ? 'I already have an account' : 'Create an account';
  $('login-pass').autocomplete = register ? 'new-password' : 'current-password';
  status(loginError);
}
toggle.addEventListener('click',() => setMode(mode === 'login' ? 'register' : 'login'));
loginForm.addEventListener('submit',async event => {
  event.preventDefault();
  if (submit.disabled) return;
  const username = $('login-user').value.trim().toLowerCase(), password = $('login-pass').value;
  if (!/^[a-z0-9_]{3,20}$/.test(username)) { status(loginError,'Username must be 3–20 characters: a–z, 0–9, or underscore.',true); return; }
  if (password.length < 6) { status(loginError,'Password must be at least 6 characters.',true); return; }
  submit.disabled = true; toggle.disabled = true;
  status(loginError,'Signing in…');
  try {
    user = (await api(`/auth/${mode}`,{ method:'POST',body:{ username,password },showWake:true })).user;
    location.replace(nextPath());
  } catch (error) {
    status(loginError,error.message,true);
    submit.disabled = false; toggle.disabled = false;
  }
});
void ready.then(() => { if (user) location.replace(nextPath()); });
