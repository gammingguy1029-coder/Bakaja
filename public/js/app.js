'use strict';
renderPosts(); viewBlog();
window.addEventListener('hashchange',viewBlog);
$('menu-toggle').addEventListener('click',() => $('menu-toggle').setAttribute('aria-expanded',String($('navigation').classList.toggle('open'))));
for (const link of $('navigation').querySelectorAll('a')) link.addEventListener('click',() => {
  $('navigation').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded','false');
});
for (const control of document.querySelectorAll('[data-close]')) control.addEventListener('click',() => $(control.dataset.close).close());
authDialog.addEventListener('close',() => { if (!authDialog.open) { savedCommand = null; $('login-pass').value = ''; } });
$('auth-toggle').addEventListener('click',() => authView(authMode === 'login' ? 'register' : 'login'));
$('auth-form').addEventListener('submit',async event => {
  event.preventDefault(); if ($('auth-submit').disabled) return;
  const username = $('login-user').value.trim().toLowerCase(), password = $('login-pass').value;
  if (!/^[a-z0-9_]{3,20}$/.test(username)) { status('auth-status','Username must be 3–20 characters: a–z, 0–9, or underscore.',true); return; }
  if (authMode === 'register' && password.length < 6) { status('auth-status','Password must be at least 6 characters.',true); return; }
  $('auth-submit').disabled = true; $('auth-toggle').disabled = true;
  const next = savedCommand;
  try {
    user = (await api(`/auth/${authMode}`,{ method:'POST', body:{ username,password }, showWake:true })).user;
    const resume = next && savedCommand === next && authDialog.open;
    if (authDialog.open) authDialog.close();
    $('login-pass').value = '';
    syncSocialButtons(); void refreshBadges();
    if (resume) await runCommand(next.command,next.target);
  } catch (error) { if (authDialog.open) status('auth-status',error.message,true); }
  finally { $('auth-submit').disabled = false; $('auth-toggle').disabled = false; }
});
$('room-join').addEventListener('submit',event => {
  event.preventDefault(); const code = $('room-code').value.trim().toUpperCase(); $('room-code').value = '';
  void runCommand({ name:'join',code },$('rooms-status'));
});
$('back').addEventListener('click',leavePrivate);
$('my-profile').addEventListener('click',() => showProfile(user));
for (const id of ['chat-rooms','inbox-join']) $(id).addEventListener('click',() => void runCommand({ name:'rooms' },$('chat-status')));
$('show-panel').addEventListener('click',() => { setPanel(true); $('close-panel').focus(); void loadPanel(); });
$('close-panel').addEventListener('click',() => { setPanel(false); $('back').focus({ preventScroll:true }); void refreshInbox(); });
compact.addEventListener('change',() => { syncPane(); void refreshInbox(); });
window.visualViewport?.addEventListener('resize',resizePrivate);
window.visualViewport?.addEventListener('scroll',resizePrivate);
document.addEventListener('visibilitychange',() => { if (document.hidden) stopPoll(); else if (room) void poll(room); });
$('chat-form').addEventListener('submit',event => {
  event.preventDefault();
  if (!room || !user) return;
  const input = $('chat-input'), text = input.value.trim(), command = parseCommand(text);
  if (command) { input.value = ''; void runCommand(command,$('chat-status')); return; }
  if ((!text && !selectedGif) || text.length > 1000) { status('chat-status','Enter a message or choose a GIF (max 1000 characters).',true); return; }
  input.value = '';
  const id = requestId(), gif = selectedGif;
  const node = messageNode({ username:user.username, role:user.role, text, gif_url:gif?.url, title:gif?.title, created_at:new Date().toISOString() },true,true);
  const pending = { id, node, text, gif, sending:false };
  room.pending.set(id,pending); list.append(node); catchUp(true);
  void send(room,pending);
});
$('create-room').addEventListener('submit',event => {
  event.preventDefault();
  void panelAction(event.submitter || event.currentTarget.querySelector('button'),async () => {
    const name = $('room-name').value;
    const { room:created } = await api('/codes',{ method:'POST', body:{ room:name, admin_only:$('owner-only').checked }, showWake:true });
    if ($('room-name').value === name) $('room-name').value = '';
    status('owner-status',`Created ${created.room} — code: ${created.code}`); await loadPanel();
  });
});
$('create-role').addEventListener('submit',event => {
  event.preventDefault();
  void panelAction(event.submitter || event.currentTarget.querySelector('button'),async () => {
    const name = $('role-name').value;
    const { role } = await api('/roles',{ method:'POST', body:{ name, color:$('role-color').value }, showWake:true });
    if ($('role-name').value === name) $('role-name').value = '';
    status('owner-status',`Created ${role.name}.`); await loadPanel();
  });
});

// --- Social features, GIF picker, notifications ---
for (const id of ['friends-open','chat-friends']) $(id).addEventListener('click',() => openFriends());
for (const id of ['notifications-open','chat-notifications']) $(id).addEventListener('click',openNotifications);
for (const control of document.querySelectorAll('#friends-dialog .tab')) control.addEventListener('click',() => void loadFriends(control.dataset.tab));
$('friend-search-form').addEventListener('submit',friendSearch);
$('notif-read').addEventListener('click',() => void markAllRead());
$('gif-open').addEventListener('click',openGifPicker);
$('gif-search-form').addEventListener('submit',event => {
  event.preventDefault();
  const query = $('gif-search').value.trim();
  if (!query) { status('gif-search-status','Enter a search term.',true); return; }
  void gifSearch(query);
});
$('gif-use').addEventListener('click',useGif);
void initGifs();
void ready.then(() => { syncSocialButtons(); void refreshBadges(); });
setInterval(() => { if (!document.hidden) void refreshBadges(true); },15000);
