'use strict';
// Keep in sync with MAX_POST_ID in server.js.
const posts = [
  [1,'Study Tips','How to Focus for Exams','Pick one concrete task before you sit down, such as solving three past-paper questions. Put your phone somewhere you cannot reach from your chair and work for 25 minutes. When the timer ends, take a short break and write down exactly where to start next.'],
  [2,'Notes','Best Notes Method','Divide a page into cues on the left, notes on the right, and a short summary at the bottom. After class, turn the main ideas into questions in the cue column. Cover your notes a day later and answer those questions from memory before checking.'],
  [3,'Notes','Maths Revision Plan','Start the week with a timed set of mixed questions to find the topics that cost you marks. Put each mistake in a log with the step you missed, not just the correct answer. Redo a few of those problems without looking on Thursday, then try a fresh mixed set at the weekend.'],
  [4,'Notes','Writing in public, gently','Write a three-sentence explanation of one concept you learned this week. Share it with a study partner and ask them which part was hardest to follow. Revise one sentence based on their answer; you do not need a polished essay to practise explaining clearly.'],
  [5,'Study Tips','What makes a room feel alive?','Give a study group one small job to do before meeting, such as bringing a question they got wrong. Let everyone try each question quietly before discussing it. End by choosing a problem to revisit next time so there is a clear reason to come back.'],
  [6,'Study Tips','Slow progress is still progress','Track what you can now recall without notes rather than how many hours you spent at the desk. If a task feels too large, slice off something you can finish in ten minutes. At the end of the week, compare that small win with what felt difficult on Monday.']
];
const blogCards = new Map();
function viewBlog() {
  const route = location.hash.slice(1).toLowerCase();
  const selected = ['home','notes','study-tips','about'].includes(route) ? route : 'home';
  const views = {
    home:['The study desk','Make room to learn.','Practical notes, better study habits, and small ways to make hard subjects feel a little more manageable.','Latest entries'],
    notes:['The notebook','Notes that stick.','Find practical ways to capture what you learn and recall it when it matters.','Notes'],
    'study-tips':['Better habits','Study a little smarter.','Small, repeatable routines for the next time you sit down to study.','Study tips'],
    about:['About the blog','A quiet study desk.','ShadowBlog is a small collection of study notes and habits you can try today. Start with one idea that fits the way you learn.','']
  };
  const [label,title,copy,section] = views[selected];
  $('hero-label').textContent = label; $('hero-title').textContent = title; $('hero-text').textContent = copy;
  $('view-title').textContent = section; $('reading').hidden = selected === 'about';
  let count = 0;
  for (const card of blogCards.values()) {
    card.node.hidden = !(selected === 'home' || (selected === 'notes' && card.category === 'Notes') || (selected === 'study-tips' && card.category === 'Study Tips'));
    if (!card.node.hidden) count++;
  }
  $('post-count').textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
  for (const link of $('navigation').querySelectorAll('a')) {
    if (link.hash === `#${selected}`) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  }
  $('navigation').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded','false');
}
function appendComment(card, comment) {
  if (card.ids.has(comment.id)) return;
  card.ids.add(comment.id);
  const item = element('div','comment');
  item.dataset.id = comment.id;
  const time = element('time',null,msgTime.format(new Date(comment.created_at)));
  time.dateTime = comment.created_at;
  item.append(element('strong',null,comment.username),time,element('p',null,comment.text));
  const next = [...card.list.children].find(node => Number(node.dataset.id) > comment.id);
  card.list.insertBefore(item,next || null);
  if (card.list.children.length > 200) {
    const oldest = card.list.firstElementChild;
    card.ids.delete(Number(oldest.dataset.id)); oldest.remove();
  }
}
function textInput(id, max, placeholder) {
  const input = element('input');
  input.id = id; input.maxLength = max; input.placeholder = placeholder;
  for (const [name,value] of Object.entries({ autocomplete:'off', autocorrect:'off', autocapitalize:'off', spellcheck:'false', enterkeyhint:'send' })) input.setAttribute(name,value);
  return input;
}
function renderPosts() {
  for (const [id,category,title,copy] of posts) {
    const node = element('article','card'), meta = element('div','post-meta');
    meta.append(element('span','tag',category),element('span',null,'1 min read'));
    const area = element('div','comment-area'), details = element('details'), summary = element('summary',null,'Comments');
    const commentList = element('div','comments'), note = element('p','status');
    note.setAttribute('role','status');
    const form = element('form','inline'), input = textInput(`comment-post-${id}`,500,'Write a comment…');
    const label = element('label','sr',`Comment on ${title}`); label.htmlFor = input.id;
    const submit = element('button','quiet','Post');
    form.append(label,input,submit); details.append(summary,commentList); area.append(details,form,note);
    node.append(meta,element('h3',null,title),element('p',null,copy),area); $('posts').append(node);
    const card = { node, category, list:commentList, ids:new Set() };
    blogCards.set(id,card);
    details.addEventListener('toggle',async () => {
      if (!details.open) return;
      await ready;
      try {
        const data = await readWithBackoff(`/posts/${id}/comments`);
        for (const comment of data.comments) appendComment(card,comment);
        if (!card.ids.size) status(note,'No comments yet.');
      } catch (error) { status(note,error.message,true); }
    });
    form.addEventListener('submit',async event => {
      event.preventDefault();
      const raw = input.value, text = raw.trim();
      const command = parseCommand(text);
      if (command) { input.value = ''; await runCommand(command,note); return; }
      if (!text) { status(note,'Write a comment before posting.',true); return; }
      submit.disabled = true;
      try {
        await ready;
        const { comment } = await api(`/posts/${id}/comments`,{ method:'POST', body:{ text }, showWake:true });
        if (input.value === raw) input.value = '';
        appendComment(card,comment); details.open = true; status(note,'Comment posted.');
      } catch (error) { status(note,error.message,true); }
      finally { submit.disabled = false; }
    });
  }
}
