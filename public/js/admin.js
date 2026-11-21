'use strict';
function cell(row, label, value) {
  const td = element('td'); td.dataset.label = label;
  if (typeof value === 'string') td.textContent = value; else td.append(value);
  row.append(td);
}
let panelLoadId = 0;
async function loadPanel() {
  const load = ++panelLoadId;
  try {
    const [codes,users,roles] = await Promise.all(['/codes','/users','/roles'].map(path => readWithBackoff(path)));
    if (load !== panelLoadId || !panelAllowed) return;
    const codeRows = $('code-rows'), userRows = $('user-rows'), roleList = $('role-list');
    codeRows.replaceChildren(); userRows.replaceChildren(); roleList.replaceChildren();
    for (const entry of codes.codes) {
      const row = element('tr'), actions = element('div','actions');
      const base = `/codes/${encodeURIComponent(entry.code)}`;
      for (const [label,active] of [['Validate',true],['Invalidate',false]]) {
        const action = button(label,() => panelAction(action,async () => {
          await api(`${base}/${label.toLowerCase()}`,{ method:'POST', showWake:true });
          status('owner-status',`${entry.code} is now ${active ? 'active' : 'invalid'}.`);
          await loadPanel();
        }));
        actions.append(action);
      }
      const remove = button('Delete',() => {
        if (!confirm(`Delete ${entry.room} and its messages?`)) return;
        void panelAction(remove,async () => {
          await api(base,{ method:'DELETE', showWake:true }); status('owner-status',`${entry.code} deleted.`); await loadPanel();
        });
      },'danger');
      const open = button('Open',() => panelAction(open,() => openRoom(entry.code)));
      actions.append(remove,open);
      cell(row,'Code',entry.code); cell(row,'Room Name',entry.room); cell(row,'Status',entry.active ? 'Active' : 'Invalid'); cell(row,'Actions',actions); codeRows.append(row);
    }
    for (const account of users.users) {
      const row = element('tr'); cell(row,'Username',account.username); cell(row,'Role',account.role);
      if (account.role === 'Owner') cell(row,'Assign role','Protected');
      else {
        const form = element('form','inline'), select = element('select'), assign = element('button','quiet','Assign');
        select.setAttribute('aria-label',`Role for ${account.username}`);
        for (const role of roles.roles.filter(role => role.name !== 'Owner')) {
          const option = element('option',null,role.name); option.value = role.name; option.selected = account.role === role.name; select.append(option);
        }
        form.append(select,assign); cell(row,'Assign role',form);
        form.addEventListener('submit',event => {
          event.preventDefault(); void panelAction(assign,async () => {
            await api(`/users/${account.id}/role`,{ method:'POST', body:{ role:select.value }, showWake:true });
            status('owner-status',`Role updated for ${account.username}.`); await loadPanel();
          });
        });
      }
      userRows.append(row);
    }
    for (const role of roles.roles) roleList.append(badgeFor(role.name,role.color));
  } catch (error) { if (load === panelLoadId && panelAllowed) status('owner-status',error.message,true); }
}
async function panelAction(control, fn) {
  control.disabled = true;
  try { await fn(); } catch (error) { status('owner-status',error.message,true); }
  finally { control.disabled = false; }
}
