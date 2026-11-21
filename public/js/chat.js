'use strict';
function roomItem(entry, target) {
  const row = element('li');
  const control = button('',() => void runCommand({ name:'join', code:entry.code },target),'inbox-item');
  control.append(avatar(entry.room),element('span','inbox-name',entry.room));
  if (room?.code === entry.code) control.setAttribute('aria-current','true');
  row.append(control);
  return row;
}
async function refreshInbox() {
  const request = ++inboxRequestId;
  const currentUser = user;
  const nodes = $('inbox-rooms');
  if (compact.matches || $('private').hidden || !currentUser || !$('owner-pane').hidden) return;
  nodes.replaceChildren(element('li','inbox-note','Loading rooms…'));
  try {
    const { rooms } = await readWithBackoff('/rooms');
    if (request !== inboxRequestId || user !== currentUser) return;
    nodes.replaceChildren(...(rooms.length ? rooms.map(entry => roomItem(entry,$('chat-status'))) : [element('li','inbox-note','No rooms joined yet.')]));
  } catch {
    if (request === inboxRequestId) nodes.replaceChildren(element('li','inbox-note','Could not load rooms. Use + to try again.'));
  }
}
function renderAccount() {
  if (!user) return;
  $('my-profile').replaceChildren(avatar(user.username,user.role === 'Owner'));
  const control = button('',() => showProfile(user),'inbox-item');
  const details = element('div','inbox-name');
  details.append(element('strong',null,`@${user.username}`),element('p','chat-context',user.role === 'Owner' ? 'Owner profile' : 'Your profile'));
  control.append(avatar(user.username,user.role === 'Owner'),details);
  $('inbox-account').replaceChildren(control);
}
async function openRooms() {
  const request = ++roomsRequestId;
  const nodes = $('room-items'); nodes.replaceChildren();
  status('rooms-status','Loading your rooms…');
  if (!roomsDialog.open) roomsDialog.showModal();
  try {
    const { rooms } = await readWithBackoff('/rooms');
    if (request !== roomsRequestId || !roomsDialog.open) return;
    for (const entry of rooms) nodes.append(roomItem(entry,$('rooms-status')));
    status('rooms-status',rooms.length ? '' : 'No rooms joined yet. Enter a code to join.');
  } catch (error) {
    if (error.status === 401) throw error;
    if (request === roomsRequestId && roomsDialog.open) status('rooms-status',error.message,true);
  }
}
function resizePrivate() {
  const vp = window.visualViewport;
  if (!vp || $('private').hidden) return;
  $('private').style.setProperty('--vp-height',`${vp.height}px`);
  $('private').style.setProperty('--vp-top',`${vp.offsetTop}px`);
}
function syncPane() {
  const overlay = compact.matches && !$('owner-pane').hidden;
  $('chat').inert = overlay;
  $('show-panel').hidden = !panelAllowed || !$('owner-pane').hidden;
}
function showPrivate() {
  $('blog').inert = true; document.body.classList.add('private'); $('private').hidden = false;
  resizePrivate(); syncPane();
}
function setPanel(visible) { $('owner-pane').hidden = !visible; $('workspace').classList.toggle('panel-open',visible); syncPane(); }
function stopPoll() {
  clearTimeout(pollTimer); pollTimer = undefined;
  pollRequest?.abort(); pollRequest = undefined;
  pollWaiting = false; syncWake();
}
function leavePrivate() {
  ++roomRequestId; ++inboxRequestId; stopPoll(); room = null; panelAllowed = false; setPanel(false);
  $('private').hidden = true; $('blog').inert = false; document.body.classList.remove('private');
  $('chat-input').value = ''; selectedGif = null; renderGifPreview();
  list.replaceChildren(); $('inbox-rooms').replaceChildren(); $('inbox-account').replaceChildren();
  if (profileDialog.open) profileDialog.close();
  const selected = $('navigation').querySelector('[aria-current=page]');
  (selected && selected.getClientRects().length ? selected : document.querySelector('.logo')).focus({ preventScroll:true });
}
function enterChat(entry, allowPanel = false) {
  stopPoll();
  room = entry ? { ...entry, lastId:null, ids:new Map(), pending:new Map() } : null;
  panelAllowed = allowPanel; setPanel(allowPanel);
  $('chat-title').textContent = entry?.room || 'Admin Chat';
  $('room-avatar').textContent = avatar(entry?.room || 'Admin Chat').textContent;
  $('chat-input').value = ''; $('chat-form').hidden = !entry;
  list.replaceChildren(dayDivider); dayDivider.hidden = true; list.classList.remove('has-messages');
  list.dataset.state = entry ? 'Loading messages…' : 'This room is unavailable.'; status('chat-status');
  if (roomsDialog.open) roomsDialog.close();
  showPrivate(); renderAccount(); void refreshInbox();
  (allowPanel ? $('close-panel') : $('back')).focus({ preventScroll:true });
  if (room) void poll(room);
}
function roomPath(code) { return `/rooms/${encodeURIComponent(code)}/messages`; }
async function openRoom(code) {
  if (!/^[A-Z0-9]{1,12}$/.test(code)) throw new Error(code ? 'This code is invalid / expired. Ask admin to Validate it.' : 'Enter a room code, for example /join CODE.');
  const request = ++roomRequestId;
  const result = await readWithBackoff(`/codes/${encodeURIComponent(code)}/join`, 5, { method:'POST' });
  if (request !== roomRequestId || !user) return;
  if (room?.code === code) {
    if (roomsDialog.open) roomsDialog.close();
    if (!$('owner-pane').hidden) { setPanel(false); $('back').focus({ preventScroll:true }); void refreshInbox(); }
  } else enterChat(result.room);
}
async function openAdmin() {
  const request = ++roomRequestId;
  let entry, failure;
  try { entry = (await readWithBackoff('/codes/ADMIN/join', 5, { method:'POST' })).room; }
  catch (error) { if (error.status === 401) throw error; failure = error; }
  if (request !== roomRequestId || !user) return;
  enterChat(entry,true);
  if (failure) status('chat-status',failure.message,true);
  await loadPanel();
}
function atEnd() { return list.scrollHeight - list.scrollTop - list.clientHeight <= 80; }
function catchUp(shouldScroll) { if (shouldScroll) list.scrollTop = list.scrollHeight; }
const REACTION_EMOJIS = ['👍','❤️','😂','🎉','👀','🔥'];
const dayDivider = $('day-divider');
function reactionControls(message, current) {
  const bar = element('div','reactions');
  for (const reaction of message.reactions || []) {
    const chip = button(`${reaction.emoji} ${reaction.count}`,() => void toggleReaction(current,message,reaction.emoji,reaction.mine),'reaction');
    chip.setAttribute('aria-pressed',String(reaction.mine));
    chip.setAttribute('aria-label',`${reaction.emoji} — ${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`);
    bar.append(chip);
  }
  const add = button('+',() => {
    const open = bar.querySelector('.reaction-picker');
    if (open) { open.remove(); return; }
    const picker = element('div','reaction-picker');
    for (const emoji of REACTION_EMOJIS) {
      picker.append(button(emoji,() => {
        const existing = (message.reactions || []).find(item => item.emoji === emoji);
        void toggleReaction(current,message,emoji,Boolean(existing?.mine));
        picker.remove();
      }));
    }
    bar.append(picker);
  },'reaction-add');
  add.setAttribute('aria-label','Add a reaction');
  bar.append(add);
  return bar;
}
async function toggleReaction(current, message, emoji, mine) {
  if (room !== current) return;
  const path = `/rooms/${encodeURIComponent(current.code)}/messages/${message.id}/reactions`;
  try {
    if (mine) await api(`${path}/${encodeURIComponent(emoji)}`,{ method:'DELETE' });
    else await api(path,{ method:'POST',body:{ emoji } });
    const list = message.reactions || [];
    const found = list.find(item => item.emoji === emoji);
    if (mine) {
      if (found) {
        found.count--;
        if (found.count <= 0) message.reactions = list.filter(item => item !== found);
      }
    } else if (found) { found.count++; found.mine = true; }
    else list.push({ emoji, count:1, mine:true });
    updateReactions(current.ids.get(message.id),message,current);
  } catch (error) { toast(error.message,true); }
}
function updateReactions(node, message, current) {
  if (!node || node.dataset.pending === 'true') return;
  const fresh = reactionControls(message,current);
  const existing = node.querySelector('.reactions');
  if (existing) existing.replaceWith(fresh); else node.append(fresh);
}
function messageNode(message, own, pending = false, current = room) {
  const node = element('article','message');
  node.dataset.author = message.username;
  if (pending) node.dataset.pending = 'true';
  node.classList.toggle('own',own); node.classList.toggle('owner',message.role === 'Owner');
  if (['Admin','Mod','VIP','Member'].includes(message.role)) node.classList.add(`role-${message.role.toLowerCase()}`);
  const meta = element('div','message-meta');
  const time = element('time',null,msgTime.format(new Date(message.created_at)));
  time.dateTime = message.created_at;
  const author = button('',() => showProfile(message),'message-author');
  author.setAttribute('aria-label',`Profile: ${message.username}`);
  author.append(avatar(message.username,message.role === 'Owner'),element('strong',null,`${message.role === 'Owner' ? '👑 ' : ''}${message.username}`));
  meta.append(author,badgeFor(message.role,message.color),time);
  if (message.role === 'Owner') {
    const sparkle = element('span','sparkle','✨'); sparkle.setAttribute('aria-hidden','true'); meta.append(sparkle);
  }
  node.append(meta);
  if (isGifMediaUrl(message.gif_url)) {
    const image = element('img','message-gif');
    image.src = message.gif_url; image.alt = message.title || 'GIF'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
    node.append(image);
  }
  if (message.text) node.append(element('p',null,message.text));
  if (!pending) node.append(reactionControls(message,current));
  if (pending) node.append(element('span','notice','Sending…'));
  return node;
}
function applyGrouping(node) {
  if (!node?.classList.contains('message')) return;
  const prev = node.previousElementSibling;
  node.classList.toggle('grouped',Boolean(prev?.classList.contains('message') && prev.dataset.id && prev.dataset.author === node.dataset.author));
  const next = node.nextElementSibling;
  if (next?.classList.contains('message')) applyGrouping(next);
}
function syncMessageChrome() {
  const has = Boolean(list.querySelector('.message'));
  list.classList.toggle('has-messages',has);
  dayDivider.hidden = !has;
}
function addSaved(current, message) {
  let wasPending = false;
  if (message.username === user?.username && current.pending.has(message.client_id)) {
    current.pending.get(message.client_id).node.remove();
    current.pending.delete(message.client_id);
    wasPending = true;
  }
  if (current.ids.has(message.id)) {
    updateReactions(current.ids.get(message.id),message,current);
    return { added:false, wasPending };
  }
  const node = messageNode(message,message.username === user?.username,false,current);
  current.ids.set(message.id,node);
  // Keep saved messages sorted by id, always ahead of pending (optimistic)
  // sends, which have no data-id until their save is confirmed.
  const next = [...list.querySelectorAll('.message')].find(child => !child.dataset.id || Number(child.dataset.id) > message.id);
  node.dataset.id = message.id;
  list.insertBefore(node,next || null);
  applyGrouping(node);
  syncMessageChrome();
  return { added:true, wasPending };
}
async function poll(current) {
  if (document.hidden || room !== current || pollRequest) return;
  const controller = new AbortController(); pollRequest = controller;
  let wait = 2000;
  try {
    const suffix = current.lastId === null ? '' : `?after=${current.lastId}`;
    const { messages } = await api(roomPath(current.code) + suffix,{ signal:controller.signal, showWake:true });
    if (room !== current || controller.signal.aborted) return;
    const near = atEnd();
    let added = false, own = false;
    for (const message of messages) {
      const result = addSaved(current,message);
      added ||= result.added;
      own ||= result.wasPending || (result.added && current.lastId !== null && message.username === user?.username);
    }
    if (messages.length) current.lastId = messages[messages.length - 1].id;
    else if (current.lastId === null) current.lastId = 0;
    catchUp(own || (added && near));
    syncMessageChrome();
    list.dataset.state = 'No messages yet. Say hello!';
    pollWaiting = false; syncWake();
    status('chat-status');
  } catch (error) {
    if (room !== current || controller.signal.aborted) return;
    wait = 10000;
    list.dataset.state = error.status >= 500 ? 'Reconnecting…' : 'Messages are unavailable.';
    pollWaiting = error.status >= 500; syncWake();
    status('chat-status',pollWaiting ? '' : error.message,true);
  } finally {
    if (pollRequest === controller) {
      pollRequest = undefined;
      if (room === current && !document.hidden) pollTimer = setTimeout(() => void poll(current),wait);
    }
  }
}
async function send(current, pending) {
  if (room !== current || !current.pending.has(pending.id) || pending.sending) return;
  pending.sending = true;
  pending.node.lastChild.replaceWith(element('span','notice','Sending…'));
  try {
    const { message } = await api(roomPath(current.code),{ method:'POST',
      body:{ text:pending.text, client_id:pending.id, ...(pending.gif ? { gif_url:pending.gif.url } : {}) } });
    if (room !== current) return;
    if (pending.gif && selectedGif === pending.gif) { selectedGif = null; renderGifPreview(); }
    const { added, wasPending } = addSaved(current,message);
    catchUp(added || wasPending);
  } catch (error) {
    if (room !== current || !current.pending.has(pending.id)) return;
    pending.node.lastChild.replaceWith(button('Failed - tap to retry',() => void send(current,pending),'danger'));
    status('chat-status',error.message,true);
  } finally { pending.sending = false; }
}
