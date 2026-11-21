'use strict';
// Controller for the WhatsApp-style /app page. Reuses core/chat/social/gifs modules.
const workspace = $('workspace');
let currentTab = 'chats', chatRequestId = 0, friendsCache = [];

function wire(id, event, fn) { const node = $(id); if (node) node.addEventListener(event,fn); }
function loginRedirect() { location.replace('/login?next=/app'); }
function setTab(name) {
  currentTab = name;
  for (const control of document.querySelectorAll('.app-tabs .tab')) control.setAttribute('aria-selected',String(control.dataset.appTab === name));
  for (const key of ['chats','friends','rooms']) $(`tab-${key}`).hidden = key !== name;
  if (name === 'friends') void loadFriendsPanel();
  if (name === 'rooms') void loadRoomsPanel();
}

async function loadChats() {
  const request = ++chatRequestId;
  try {
    const [friendData, roomData, noteData] = await Promise.all([api('/friends'),api('/rooms'),api('/notifications')]);
    if (request !== chatRequestId) return;
    friendsCache = friendData.friends;
    const unread = new Set(noteData.notifications.filter(item => !item.read && item.payload?.room?.code).map(item => item.payload.room.code));
    const entries = [];
    for (const friend of friendData.friends) if (friend.dm_code) entries.push({ code:friend.dm_code, room:friend.dm_room || dmLabel(user.username,friend.username), kind:'dm', person:friend });
    for (const item of roomData.rooms) {
      if (!entries.some(entry => entry.code === item.code)) entries.push({ code:item.code, room:item.room, kind:'room' });
    }
    await Promise.allSettled(entries.map(async entry => {
      try {
        const { messages } = await api(`/rooms/${encodeURIComponent(entry.code)}/messages`);
        const last = messages[messages.length - 1];
        entry.preview = last ? (last.text || (last.gif_url ? 'GIF' : '')) : '';
        entry.at = last?.created_at || null;
      } catch { entry.preview = ''; }
    }));
    if (request !== chatRequestId) return;
    renderChats(entries,unread);
  } catch (error) { toast(error.message,true); }
}
function renderChats(entries, unread) {
  const listNode = $('app-chat-list');
  listNode.replaceChildren();
  if (!entries.length) { listNode.append(element('li','sidebar-empty','No chats yet. Add a friend or join a room.')); return; }
  for (const entry of entries) {
    const row = button('',() => openEntry(entry),'chat-row');
    if (room?.code === entry.code) row.setAttribute('aria-current','true');
    const name = entry.kind === 'dm' ? entry.person?.username || entry.room : entry.room;
    row.append(avatar(name,entry.person?.role === 'Owner'));
    const body = element('div','chat-row-body');
    const top = element('div','chat-row-top');
    top.append(element('strong',null,entry.kind === 'dm' ? `@${name}` : name));
    if (entry.at) {
      const time = element('time',null,msgTime.format(new Date(entry.at)));
      time.dateTime = entry.at; top.append(time);
    }
    body.append(top,element('span','chat-row-preview',entry.preview || 'No messages yet'));
    row.append(body);
    if (unread.has(entry.code)) row.append(element('span','unread-dot'));
    listNode.append(row);
  }
}
function openEntry(entry) {
  workspace.classList.add('showing-chat');
  enterChat({ code:entry.code, room:entry.room });
  if (user?.role === 'Owner') $('show-panel').hidden = false;
  renderDetails(entry);
}
function backToChats() {
  workspace.classList.remove('showing-chat');
  enterChat(null);
  $('details-content').replaceChildren(element('p','inbox-note','Select a chat to see details.'));
}
function renderDetails(entry) {
  const node = $('details-content');
  node.replaceChildren();
  const identity = element('div','details-identity');
  identity.append(avatar(entry.kind === 'dm' ? entry.person?.username || entry.room : entry.room,entry.person?.role === 'Owner'));
  identity.append(element('strong',null,entry.kind === 'dm' ? `@${entry.person?.username || entry.room}` : entry.room));
  if (entry.kind === 'dm' && entry.person?.role) identity.append(badgeFor(entry.person.role,entry.person.color));
  node.append(identity);
  node.append(element('p','details-meta',entry.kind === 'dm' ? `Direct message · ${entry.person?.role || 'Member'}` : `Room code: ${entry.code}`));
  const actions = element('div','details-actions');
  actions.append(button('Go to message',() => $('chat-input').focus(),'quiet'));
  if (entry.kind === 'dm' && entry.person) {
    actions.append(button('View profile',() => showProfile(entry.person),'quiet'));
    actions.append(button('Remove friend',control => void unfriend(control,entry.person.id,entry.person.username),'danger'));
  } else {
    actions.append(button('Copy room code',async () => {
      try { await navigator.clipboard.writeText(entry.code); toast('Room code copied.'); }
      catch { toast(`Room code: ${entry.code}`); }
    },'quiet'));
  }
  node.append(actions);
}

async function loadFriendsPanel() {
  try {
    const data = await api('/friends');
    friendsCache = data.friends;
    const friends = $('app-friends-list'), incoming = $('app-incoming'), outgoing = $('app-outgoing');
    friends.replaceChildren(); incoming.replaceChildren(); outgoing.replaceChildren();
    if (!data.friends.length) friends.append(element('li','inbox-note','No friends yet. Find someone below.'));
    for (const friend of data.friends) {
      const actions = [];
      if (friend.dm_code) actions.push(button('Chat',() => openEntry({ code:friend.dm_code, room:friend.dm_room || dmLabel(user.username,friend.username), kind:'dm', person:friend }),'primary'));
      actions.push(button('Remove',control => void unfriend(control,friend.id,friend.username),'danger'));
      friends.append(friendRow(friend,actions));
    }
    if (!data.incoming.length) incoming.append(element('li','inbox-note','No incoming requests.'));
    for (const person of data.incoming) incoming.append(friendRow(person,[
      button('Accept',control => void friendAction(control,person.id,'accept'),'primary'),
      button('Decline',control => void friendAction(control,person.id,'decline'),'danger')
    ]));
    if (!data.outgoing.length) outgoing.append(element('li','inbox-note','No outgoing requests.'));
    for (const person of data.outgoing) outgoing.append(friendRow(person,[button('Cancel',control => void friendAction(control,person.id,'cancel'),'danger')]));
  } catch (error) { status('app-friend-status',error.message,true); }
}
async function appFriendSearch(event) {
  event.preventDefault();
  const query = $('app-friend-search').value.trim();
  if (query.length < 2) { status('app-friend-status','Enter at least 2 characters.',true); return; }
  status('app-friend-status','Searching…');
  try {
    const { users } = await api(`/users/search?q=${encodeURIComponent(query)}`);
    status('app-friend-status',users.length ? '' : 'No users found.');
    const results = $('app-friends-list');
    for (const person of users) {
      if (dataHasFriend(person)) continue;
      results.append(friendRow(person,[button('Add',async control => {
        control.disabled = true;
        try { await api('/friends/request',{ method:'POST',body:{ username:person.username },showWake:true }); toast(`Request sent to @${person.username}.`); control.textContent='Sent'; void loadFriendsPanel(); }
        catch (error) { toast(error.message,true); control.disabled = false; }
      },'primary')]));
    }
  } catch (error) { status('app-friend-status',error.message,true); }
}
function dataHasFriend(person) { return friendsCache.some(friend => friend.username === person.username); }

async function loadRoomsPanel() {
  try {
    const { rooms } = await api('/rooms');
    const listNode = $('app-rooms-list'); listNode.replaceChildren();
    if (!rooms.length) { listNode.append(element('li','inbox-note','No rooms joined yet.')); return; }
    for (const item of rooms) listNode.append(friendRow({ username:item.room, role:'Room' },[button('Open',() => openEntry({ code:item.code, room:item.room, kind:'room' }),'primary')]));
  } catch (error) { status('app-room-status',error.message,true); }
}
async function appJoinRoom(event) {
  event.preventDefault();
  const input = $('app-room-code'), code = input.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(code)) { status('app-room-status','Enter a valid room code.',true); return; }
  input.value = '';
  try {
    const { room } = await api(`/codes/${encodeURIComponent(code)}/join`,{ method:'POST',showWake:true });
    openEntry({ code:room.code, room:room.room, kind:'room' });
    status('app-room-status',''); void loadChats();
  } catch (error) { status('app-room-status',error.message,true); }
}

function wireAll() {
  for (const control of document.querySelectorAll('[data-close]')) control.addEventListener('click',() => $(control.dataset.close).close());
  for (const buttonNode of document.querySelectorAll('.app-tabs .tab')) buttonNode.addEventListener('click',() => setTab(buttonNode.dataset.appTab));
  wire('room-join','submit',event => {
    event.preventDefault(); const code = $('room-code').value.trim().toUpperCase(); $('room-code').value = '';
    void runCommand({ name:'join',code },$('rooms-status'));
  });
  wire('chat-form','submit',event => {
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
  wire('back','click',backToChats);
  wire('close-details','click',() => $('details-pane').hidden = true);
  wire('my-profile','click',() => showProfile(user));
  wire('chat-rooms','click',() => setTab('rooms'));
  wire('chat-friends','click',() => setTab('friends'));
  for (const id of ['new-chat']) wire(id,'click',() => setTab('friends'));
  wire('show-panel','click',() => { setPanel(true); $('close-panel').focus(); void loadPanel(); });
  wire('close-panel','click',() => { setPanel(false); $('back').focus({ preventScroll:true }); void refreshInbox(); });
  wire('create-room','submit',event => {
    event.preventDefault();
    void panelAction(event.submitter || event.currentTarget.querySelector('button'),async () => {
      const name = $('room-name').value;
      const { room:created } = await api('/codes',{ method:'POST',body:{ room:name,admin_only:$('owner-only').checked },showWake:true });
      if ($('room-name').value === name) $('room-name').value = '';
      status('owner-status',`Created ${created.room} — code: ${created.code}`); await loadPanel();
    });
  });
  wire('create-role','submit',event => {
    event.preventDefault();
    void panelAction(event.submitter || event.currentTarget.querySelector('button'),async () => {
      const name = $('role-name').value;
      const { role } = await api('/roles',{ method:'POST',body:{ name,color:$('role-color').value },showWake:true });
      if ($('role-name').value === name) $('role-name').value = '';
      status('owner-status',`Created ${role.name}.`); await loadPanel();
    });
  });
  wire('friend-search-form','submit',friendSearch);
  wire('app-friend-search-form','submit',appFriendSearch);
  wire('notif-read','click',() => void markAllRead());
  wire('gif-open','click',openGifPicker);
  wire('gif-search-form','submit',event => {
    event.preventDefault();
    const query = $('gif-search').value.trim();
    if (!query) { status('gif-search-status','Enter a search term.',true); return; }
    void gifSearch(query);
  });
  wire('gif-use','click',useGif);
  wire('app-room-join','submit',appJoinRoom);
  wire('app-notifications','click',() => { $('notif-drawer').hidden = false; void loadNotifications(); });
  wire('close-notif','click',() => $('notif-drawer').hidden = true);
  wire('sign-out','click',async () => {
    try { await api('/auth/logout',{ method:'POST',showWake:true }); } catch { /* go anyway */ }
    loginRedirect();
  });
  compact.addEventListener('change',() => { syncPane(); void refreshInbox(); });
  window.visualViewport?.addEventListener('resize',resizePrivate);
  window.visualViewport?.addEventListener('scroll',resizePrivate);
  document.addEventListener('visibilitychange',() => { if (document.hidden) stopPoll(); else if (room) void poll(room); });
}

async function init() {
  if (!user) { loginRedirect(); return; }
  $('private').hidden = false;
  $('sidebar-name').textContent = `@${user.username}`;
  $('sidebar-role').textContent = user.role === 'Owner' ? 'Owner' : 'Private space';
  $('sidebar-avatar').replaceChildren(avatar(user.username,user.role === 'Owner'));
  wireAll();
  void initGifs();
  syncSocialButtons(); void refreshBadges();
  await loadChats();
  setInterval(() => { if (!document.hidden) { void loadChats(); void refreshBadges(); } },15000);
}
void ready.then(init);
