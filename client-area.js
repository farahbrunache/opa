import { firstSentence, sheetSteps } from '/sheet.js';
import { call, showProblem } from '/problem.js';
import { day, el, linkedText } from '/client-ui.js';
import { openConversation } from '/client-talk.js';
import { loadCard } from '/client-card.js';

export function currentSession(data) {
  return data.sessions.find((s) => s.recommendations)
    || data.sessions.find((s) => s.approved)
    || data.sessions[0];
}

function named(name, text) {
  return name ? `${name}, ${text}` : text[0].toUpperCase() + text.slice(1);
}

function stepCard(number, text) {
  const card = el('div', null, 'cstep static');
  card.append(el('span', String(number), 'cn'));
  const words = el('span', null, 'ctx');
  const [first, rest] = firstSentence(text);
  words.append(linkedText(el('b'), first));
  linkedText(words, rest);
  card.append(words);
  return card;
}

function letterPanel(panel, session, withSteps) {
  const parts = sheetSteps(session.recommendations);
  const list = panel.querySelector('.csteps');
  list.textContent = '';
  list.hidden = !withSteps;
  panel.querySelector('.cdate').textContent = `Written for you · ${day(session.recommendedAt)}`;
  const intro = panel.querySelector('[data-part="intro"]');
  intro.textContent = '';
  intro.hidden = !parts.intro;
  linkedText(intro, parts.intro);
  const outro = panel.querySelector('[data-part="outro"]');
  outro.textContent = '';
  outro.hidden = !parts.outro;
  linkedText(outro, parts.outro);
  if (withSteps) {
    parts.steps.forEach((text, i) => {
      const li = el('li');
      li.append(stepCard(i + 1, text));
      list.append(li);
    });
  }
  return parts.steps.length;
}

function headline(data, items) {
  if (data.firstCustomerAt) return named(data.firstName, 'you have your first paying customer.');
  const session = data.chapter ? { recommendations: data.steps?.text } : currentSession(data);
  if (!session.recommendations) return named(data.firstName, 'your plan is being written.');
  const todo = items.filter((i) => i.group === 'todo').length;
  if (items.length && !todo) return named(data.firstName, 'your roadmap is done.');
  return named(data.firstName, 'your plan is underway.');
}

function callRows(data) {
  const rows = [];
  const oldestFirst = [...data.sessions].reverse();
  let first = true;
  const old = (at) => Boolean(data.chapter && at && new Date(at) < new Date(data.chapter.startedAt));
  for (const s of oldestFirst) {
    if (!s.hasTranscript) continue;
    rows.push({ title: first ? 'Your first call' : 'Your follow-up call', group: 'done', at: s.calledAt, old: old(s.calledAt), fixed: true });
    first = false;
  }
  return rows;
}

function words(entry) {
  if (entry.group === 'done') return [entry.at ? day(entry.at) : entry.fromCall ? 'From your call' : '', null];
  if (entry.due) return [`Due ${day(entry.due)}`, entry.yours ? 'Farah is working on her part of this' : null];
  if (entry.fromCall) return ['From your call', entry.yours ? 'Farah is working on her part of this' : null];
  return [entry.since ? `Since ${day(entry.since)}` : entry.said || '', entry.yours ? 'Farah is working on her part of this' : null];
}

function row(entry, tick) {
  const li = el('li', null, entry.goal ? 'goal' : null);
  const text = el('span');
  text.append(el('b', entry.title));
  const [right, line] = words(entry);
  li.append(text, el('time', right));
  if (line) li.append(el('small', line));
  if (tick && entry.id) {
    const check = el('button', null, entry.group === 'done' ? 'ccheck on' : 'ccheck');
    check.type = 'button';
    check.setAttribute('aria-pressed', String(entry.group === 'done'));
    check.setAttribute('aria-label', `${entry.title} done`);
    check.addEventListener('click', () => tick(entry.id, entry.group !== 'done'));
    li.append(check);
  }
  return li;
}

function groups(items) {
  const time = (value) => (value ? new Date(value).getTime() : Infinity);
  return [
    ['now', 'To do', items.filter((i) => i.group === 'todo').sort((a, b) => time(a.due) - time(b.due))],
    ['done', 'Done', items.filter((i) => i.group === 'done').sort((a, b) => time(a.at) - time(b.at))],
  ];
}

function drawGroups(box, these, tick) {
  box.textContent = '';
  let total = 0;
  for (const [tone, label, items] of these) {
    if (!items.length) continue;
    total += items.length;
    const group = el('div', null, `tlg ${tone}`);
    const head = el('h3');
    head.append(el('span', label), el('span', String(items.length)));
    const list = el('ol');
    for (const entry of items) list.append(row(entry, entry.fixed ? null : tick));
    group.append(head, list);
    box.append(group);
  }
  return total;
}

function drawEarlier(data, calls) {
  const button = document.getElementById('earlierbtn');
  const box = document.getElementById('earlierpath');
  const earlier = [...calls.filter((i) => i.old), ...(data.earlier || [])];
  button.hidden = !data.chapter || !earlier.length;
  box.hidden = true;
  if (button.hidden) return;
  const n = drawGroups(box, groups(earlier), null);
  const closed = `Your earlier direction · ${n} item${n === 1 ? '' : 's'}`;
  button.textContent = closed;
  button.onclick = () => {
    box.hidden = !box.hidden;
    button.textContent = box.hidden ? closed : 'Hide your earlier direction';
  };
}

function drawRoadmap(data, tick) {
  const calls = callRows(data);
  const items = [...(data.roadmap || []), ...calls.filter((i) => !i.old)];
  const these = groups(items);
  const goal = { title: 'Your first paying customer', goal: true, fixed: true };
  if (data.firstCustomerAt) these[1][2].push({ ...goal, group: 'done', at: data.firstCustomerAt });
  else these[0][2].push({ ...goal, group: 'todo', said: 'Not yet' });
  drawEarlier(data, calls);
  drawGroups(document.getElementById('path'), these, tick);
  const todo = these[0][2].length;
  const done = these[1][2].length;
  document.getElementById('pathcount').textContent = `${todo} to do · ${done} done`;
}

function drawIntroductions(intros) {
  const panel = document.getElementById('c-intros');
  const list = document.getElementById('introlist');
  list.textContent = '';
  panel.hidden = !intros.length;
  for (const intro of intros) {
    const row_ = el('div', null, 'intro');
    row_.append(el('span', intro.initial, 'avatar alt'));
    const who = el('div');
    who.append(el('b', intro.name));
    who.append(el('small', [intro.jobTitle, intro.status].filter(Boolean).join(' · ')));
    if (intro.reason) who.append(el('p', intro.reason));
    row_.append(who);
    list.append(row_);
  }
}

function drawBring(bring) {
  const panel = document.getElementById('c-bring');
  panel.hidden = !bring;
  if (!bring) return;
  document.getElementById('broughtcount').textContent = bring.brought ? `You've brought ${bring.brought}` : '';
  document.getElementById('bringlink').textContent = bring.link.replace(/^https:\/\//, '');
  const copy = document.getElementById('bringcopy');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(bring.link);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Press and hold the link to copy it';
    }
  };
}

function letterOf(data) {
  if (data.chapter) {
    return data.steps ? { recommendations: data.steps.text, recommendedAt: data.steps.at } : null;
  }
  const session = currentSession(data);
  return session.recommendations ? session : null;
}

function drawApproved(data) {
  const panel = document.getElementById('c-plan');
  const progress = document.getElementById('stepprogress');
  const said = document.getElementById('stepmsg');

  const draw = () => {
    const letter = letterOf(data);
    panel.hidden = !letter;
    if (letter) letterPanel(panel, letter, false);
    const steps = (data.roadmap || []).filter((i) => i.fromCall);
    const done = steps.filter((i) => i.group === 'done').length;
    const n = steps.length;
    progress.textContent = n
      ? `${n === 1 ? 'Its one step is' : `Its ${n} steps are`} on your roadmap above: ${done} done, ${n - done} to do. Tap a circle when one is done. Farah sees it right away.`
      : 'What it says to do is on your roadmap above.';
    document.getElementById('heroline').textContent = headline(data, data.roadmap || []);
    drawRoadmap(data, tick);
  };

  let busy = false;
  async function tick(activity, done) {
    if (busy) return;
    busy = true;
    said.hidden = true;
    try {
      const back = await call('/api/client?action=activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activity, done }),
      }, done ? 'Marking that done' : 'Putting that back');
      data.roadmap = back.roadmap;
      draw();
    } catch (error) {
      showProblem(said, error, done ? 'Marking that done' : 'Putting that back');
    } finally {
      busy = false;
    }
  }

  document.getElementById('eyebrow').textContent = 'One Percent · Member';
  document.getElementById('herolede').textContent = "You don't search alone here. Your organizer "
    + 'finds the people, the customers and the next move, and brings them to you.';
  draw();
  drawIntroductions(data.introductions || []);
  drawBring(data.bring);
  document.querySelectorAll('[data-go]').forEach((node) => { node.hidden = false; });
  openConversation();
  loadCard();
}

function drawFinished(data) {
  const session = currentSession(data);
  const panel = document.getElementById('c-plan');
  panel.querySelector('.clabel').textContent = 'Your recommendation';
  letterPanel(panel, session, true);
  panel.hidden = false;
  document.getElementById('stepprogress').hidden = true;
  document.getElementById('eyebrow').textContent = 'One Percent · Your session';
  document.getElementById('heroline').textContent = data.firstName
    ? `Your session is complete, ${data.firstName}.`
    : 'Your session is complete.';
  document.getElementById('herolede').textContent =
    'Here is the recommendation written for you from your call.';
  document.querySelectorAll('[data-again]').forEach((node) => { node.hidden = false; });
}

export function renderPage(data) {
  document.getElementById('page').hidden = false;
  if (data.approved) drawApproved(data);
  else drawFinished(data);
}
