'use strict';
// User search, friend requests, direct messages, and notifications.
const friendsDialog = $('friends-dialog'), notificationsDialog = $('notifications-dialog');
let friendsTab = 'friends', friendsRequestId = 0, searchRequestId = 0, notifRequestId = 0, lastNotifId = null;

function setCount(id, count) {
  const node = $(id);
  if (!node) return;
  node.textContent = String(count);
  node.hidden = count <= 0;
}
function syncSocialButtons() {
  for (const id of ['friends-open','notifications-open','chat-friends','chat-notifications']) {
    const node = $(id);
    if (node) node.hidden = !user;
  }
  if (!user) {
    for (const id of ['friend-badge','notif-badge','chat-friend-badge','chat-notif-badge']) setCount(id, 0);
    lastNotifId = null;
  }
}
async function refreshBadges(announce = false) {
  if (!user) { syncSocialButtons(); return; }
  syncSocialButtons();
  try {
    const [friends, notes] = await Promise.all([api('/friends'), api('/notifications')]);
    const incoming = friends.incoming.length;
    const unread = notes.notifications.filter(item => !item.read).length;
    for (const id of ['friend-badge','chat-friend-badge']) setCount(id, incoming);
    for (const id of ['notif-badge','chat-notif-badge']) setCount(id, unread);
    const newest = notes.notifications[0]?.id || 0;
    if (announce && lastNotifId !== null && newest > lastNotifId) {
      for (const item of notes.notifications.filter(item => item.id > lastNotifId).reverse()) {
        const action = item.type === 'friend_request' ? 'sent you a friend request' : 'accepted your friend request';
        toast(`${item.actor_username || 'Someone'} ${action}.`);
      }
    }
    lastNotifId = newest;
  } catch { /* keep the previous badge state; these are non-critical polls */ }
}
function friendRow(person, actions) {
  const row = element('li','social-item');
  row.append(avatar(person.username));
  const grow = element('div','grow');
  grow.append(element('strong',null,`@${person.username}`),element('small',null,person.role || 'Member'));
  row.append(grow);
  const controls = element('div','row-actions');
  controls.append(...actions);
  row.append(controls);
  return row;
}
function renderFriendData(data) {
  const friendsList = $('friends-list'), incomingList = $('incoming-list'), outgoingList = $('outgoing-list');
  friendsList.replaceChildren(); incomingList.replaceChildren(); outgoingList.replaceChildren();
  $('friends-empty').hidden = data.friends.length > 0;
  $('friends-empty').textContent = data.friends.length ? '' : 'No friends yet. Use Add friend to find someone.';
  for (const friend of data.friends) {
    const actions = [];
    if (friend.dm_code) actions.push(button('Chat',() => {
      if (friendsDialog.open) friendsDialog.close();
      enterChat({ code:friend.dm_code, room:friend.dm_room || dmLabel(user.username,friend.username) });
    },'primary'));
    actions.push(button('Remove',control => void unfriend(control,friend.id,friend.username),'danger'));
    friendsList.append(friendRow(friend,actions));
  }
  for (const person of data.incoming) {
    const accept = button('Accept',control => void friendAction(control,person.id,'accept'));
    const decline = button('Decline',control => void friendAction(control,person.id,'decline'),'danger');
    incomingList.append(friendRow(person,[accept,decline]));
  }
  if (!data.incoming.length) incomingList.append(element('li','inbox-note','No incoming requests.'));
  for (const person of data.outgoing) {
    outgoingList.append(friendRow(person,[button('Cancel',control => void friendAction(control,person.id,'cancel'),'danger')]));
  }
  if (!data.outgoing.length) outgoingList.append(element('li','inbox-note','No outgoing requests.'));
}
function openFriends(tab = 'friends') {
  if (!user) { openAuth({ name:'friends' },$('announcement')); return; }
  if (!friendsDialog.open) friendsDialog.showModal();
  void loadFriends(tab);
}
async function loadFriends(tab = friendsTab) {
  friendsTab = tab;
  for (const control of document.querySelectorAll('#friends-dialog .tab')) control.setAttribute('aria-selected',String(control.dataset.tab === tab));
  for (const name of ['friends','requests','add']) $(`tab-${name}`).hidden = name !== tab;
  if (tab === 'add') return;
  const request = ++friendsRequestId;
  try {
    const data = await api('/friends');
    if (request !== friendsRequestId) return;
    renderFriendData(data);
    for (const id of ['friend-badge','chat-friend-badge']) setCount(id,data.incoming.length);
  } catch (error) { toast(error.message,true); }
}
async function friendAction(control, id, action) {
  control.disabled = true;
  try {
    const data = await api(`/friends/${id}/${action}`,{ method:'POST',body:{},showWake:true });
    if (action === 'accept' && data.room) toast(`You are now friends with @${data.friend.username}. Your direct chat is ready.`);
    else toast(action === 'decline' ? 'Request declined.' : 'Request cancelled.');
    // /app renders friends in its own panel; the blog uses the dialog.
    if (typeof loadFriendsPanel === 'function') void loadFriendsPanel();
    void loadFriends(action === 'accept' ? 'friends' : 'requests');
    void refreshBadges();
  } catch (error) { toast(error.message,true); }
  finally { control.disabled = false; }
}
async function unfriend(control, id, username) {
  if (!confirm(`Remove @${username} as a friend? This also deletes your direct chat history.`)) return;
  control.disabled = true;
  try {
    await api(`/friends/${id}`,{ method:'DELETE',showWake:true });
    toast('Friend removed.');
    if (typeof loadFriendsPanel === 'function') void loadFriendsPanel();
    void loadFriends('friends');
    if (typeof loadChats === 'function') void loadChats();
    void refreshBadges();
  } catch (error) { toast(error.message,true); }
  finally { control.disabled = false; }
}
async function friendSearch(event) {
  event.preventDefault();
  const query = $('friend-search').value.trim();
  if (query.length < 2) { status('friend-search-status','Enter at least 2 characters.',true); return; }
  const request = ++searchRequestId;
  status('friend-search-status','Searching…');
  try {
    const { users } = await api(`/users/search?q=${encodeURIComponent(query)}`);
    if (request !== searchRequestId) return;
    const results = $('friend-results'); results.replaceChildren();
    status('friend-search-status',users.length ? '' : 'No users found.');
    for (const person of users) {
      const add = button('Add friend',async () => {
        add.disabled = true;
        try {
          await api('/friends/request',{ method:'POST',body:{ username:person.username },showWake:true });
          toast(`Request sent to @${person.username}.`);
          add.textContent = 'Requested'; void refreshBadges();
        } catch (error) { toast(error.message,true); add.disabled = false; }
      },'primary');
      results.append(friendRow(person,[add]));
    }
  } catch (error) { if (request === searchRequestId) status('friend-search-status',error.message,true); }
}
function openNotifications() {
  if (!user) { openAuth({ name:'notifications' },$('announcement')); return; }
  if (!notificationsDialog.open) notificationsDialog.showModal();
  void loadNotifications();
}
async function loadNotifications() {
  const request = ++notifRequestId;
  try {
    const { notifications } = await api('/notifications');
    if (request !== notifRequestId) return;
    const nodes = $('notifications-list'); nodes.replaceChildren();
    if (!notifications.length) { nodes.append(element('li','inbox-note','No notifications yet.')); return; }
    for (const item of notifications) {
      const row = element('li',`social-item${item.read ? '' : ' unread'}`);
      row.append(avatar(item.actor_username || '?'));
      const grow = element('div','grow');
      grow.append(element('strong',null,item.type === 'friend_request' ? 'Friend request' : 'Friend accepted'),
        element('small',null,`${item.actor_username || 'Someone'} · ${new Date(item.created_at).toLocaleString()}`));
      row.append(grow);
      nodes.append(row);
    }
  } catch (error) { toast(error.message,true); }
}
async function markAllRead() {
  try {
    await api('/notifications/read',{ method:'POST',body:{},showWake:true });
    void loadNotifications(); void refreshBadges();
  } catch (error) { toast(error.message,true); }
}
