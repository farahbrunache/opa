import { firstSentence, sheetSteps } from '/sheet.js';
import { call, showProblem } from '/problem.js';
import { day, el, linkedText } from '/client-ui.js';
import { loadOffers } from '/client-talk.js';

export function currentSession(data) {
  return data.sessions.find((s) => s.recommendations)
    || data.sessions.find((s) => s.approved)
    || data.sessions[0];
}

function named(name, text) {
  return name ? `${name}, ${text}` : text[0].toUpperCase() + text.slice(1);
}

function stepCard(number, text, done, onTick) {
  const card = el('div', null, onTick ? 'cstep' : 'cstep static');
  if (done) card.classList.add('done');
  card.append(el('span', String(number), 'cn'));
  const words = el('span', null, 'ctx');
  const [first, rest] = firstSentence(text);
  words.append(linkedText(el('b'), first));
  linkedText(words, rest);
  card.append(words);
  if (!onTick) return card;
  const check = el('button', null, 'ccheck');
  check.type = 'button';
  check.setAttribute('aria-pressed', String(done));
  check.setAttribute('aria-label', `Step ${number} done`);
  check.addEventListener('click', (event) => { event.stopPropagation(); onTick(); });
  card.addEventListener('click', (event) => {
    if (event.target.closest('a')) return;
    onTick();
  });
  card.append(check);
  return card;
}

function sheetPanel(panel, session, ticking) {
  const parts = sheetSteps(session.recommendations);
  const list = panel.querySelector('.csteps');
  list.textContent = '';
  panel.querySelector('.cdate').textContent = `Written for you · ${day(session.recommendedAt)}`;
  const intro = panel.querySelector('[data-part="intro"]');
  intro.textContent = '';
  intro.hidden = !parts.intro;
  linkedText(intro, parts.intro);
  const outro = panel.querySelector('[data-part="outro"]');
  outro.textContent = '';
  outro.hidden = !parts.outro;
  linkedText(outro, parts.outro);
  parts.steps.forEach((text, i) => {
    const n = i + 1;
    const done = session.stepsDone.includes(n);
    const li = el('li');
    li.append(stepCard(n, text, done, ticking ? () => ticking(n, !done) : null));
    list.append(li);
  });
  return parts.steps.length;
}

function headline(data, session, count, doneCount) {
  if (data.firstCustomerAt) return named(data.firstName, 'you have your first paying customer.');
  if (!session.recommendations) return named(data.firstName, 'your next steps are being written.');
  if (count && doneCount >= count) return named(data.firstName, 'your next steps are done.');
  return named(data.firstName, 'your plan is underway.');
}

function pathItems(data, session, count, doneCount) {
  const items = [];
  const oldestFirst = [...data.sessions].reverse();
  let first = true;
  const old = (at) => Boolean(data.chapter && at && new Date(at) < new Date(data.chapter.startedAt));
  for (const s of oldestFirst) {
    if (!s.hasTranscript) continue;
    items.push({ kind: 'Call', title: first ? 'Your first call' : 'Your follow-up call', group: 'done', at: s.calledAt, old: old(s.calledAt) });
    first = false;
  }
  if (!session.recommendations) {
    items.push({ kind: 'Next steps', title: 'Your next steps', group: 'now', said: 'Being written' });
  } else if (count && doneCount >= count) {
    items.push({ kind: 'Next steps', title: 'Your next steps', group: 'done', said: `All ${count} ticked`, at: session.recommendedAt });
  } else {
    items.push({ kind: 'Next steps', title: 'Your next steps', group: 'now', said: `${doneCount} of ${count} ticked` });
  }
  for (const intro of data.introductions || []) {
    const done = intro.status === 'Introduced';
    items.push({ kind: 'Introduction', title: intro.name, group: done ? 'done' : 'now', said: intro.status, at: intro.at });
  }
  items.push(...(data.path || []));
  return items;
}

function rowWords(entry) {
  if (entry.group === 'done') {
    return [day(entry.at) || '', entry.said && entry.said !== 'Done' ? entry.said : null];
  }
  if (entry.due) return [`Due ${day(entry.due)}`, entry.said || null];
  if (entry.kind === 'Introduction') return [day(entry.at) || '', entry.said];
  return [entry.said || '', null];
}

function pathRow(entry) {
  const li = el('li', null, entry.goal ? 'goal' : null);
  const words = el('span');
  words.append(el('span', entry.kind, 'k'), el('br'), el('b', entry.title));
  const [right, line] = rowWords(entry);
  li.append(words, el('time', right));
  if (line) li.append(el('small', line));
  return li;
}

function groupsOf(items) {
  const time = (value) => (value ? new Date(value).getTime() : Infinity);
  return [
    ['done', 'Done', items.filter((i) => i.group === 'done').sort((a, b) => time(a.at) - time(b.at))],
    ['now', 'In progress', items.filter((i) => i.group === 'now')],
    ['next', 'Scheduled', items.filter((i) => i.group === 'next').sort((a, b) => time(a.due) - time(b.due))],
  ];
}

function drawGroups(box, groups) {
  box.textContent = '';
  let total = 0;
  for (const [tone, label, these] of groups) {
    if (!these.length) continue;
    total += these.length;
    const group = el('div', null, `tlg ${tone}`);
    const head = el('h3');
    head.append(el('span', label), el('span', String(these.length)));
    const list = el('ol');
    for (const entry of these) list.append(pathRow(entry));
    group.append(head, list);
    box.append(group);
  }
  return total;
}

function drawEarlier(data, items) {
  const button = document.getElementById('earlierbtn');
  const box = document.getElementById('earlierpath');
  const earlier = [...items.filter((i) => i.old), ...(data.earlier || [])];
  if (data.chapter) {
    const before = currentSession(data);
    if (before?.recommendations) {
      const count = sheetSteps(before.recommendations).steps.length;
      const ticked = before.stepsDone.filter((n) => n <= count).length;
      earlier.push({ kind: 'Next steps', title: 'Your earlier next steps', group: 'done', said: `${ticked} of ${count} ticked`, at: before.recommendedAt });
    }
  }
  button.hidden = !data.chapter || !earlier.length;
  box.hidden = true;
  if (button.hidden) return;
  const n = drawGroups(box, groupsOf(earlier));
  const closed = `Your earlier direction · ${n} item${n === 1 ? '' : 's'}`;
  button.textContent = closed;
  button.onclick = () => {
    box.hidden = !box.hidden;
    button.textContent = box.hidden ? closed : 'Hide your earlier direction';
  };
}

function drawPath(data, session, count, doneCount) {
  const items = pathItems(data, session, count, doneCount);
  const groups = groupsOf(items.filter((i) => !i.old));
  const goal = { kind: 'The goal', title: 'Your first paying customer', goal: true };
  if (data.firstCustomerAt) groups[0][2].push({ ...goal, group: 'done', at: data.firstCustomerAt });
  else groups[2][2].push({ ...goal, group: 'next', said: 'Not yet' });
  drawEarlier(data, items);

  const total = drawGroups(document.getElementById('path'), groups);
  document.getElementById('pathcount').textContent = `${total} item${total === 1 ? '' : 's'}`;
}

function drawIntroductions(intros) {
  const panel = document.getElementById('c-intros');
  const list = document.getElementById('introlist');
  list.textContent = '';
  panel.hidden = !intros.length;
  for (const intro of intros) {
    const row = el('div', null, 'intro');
    row.append(el('span', intro.initial, 'avatar alt'));
    const who = el('div');
    who.append(el('b', intro.name));
    who.append(el('small', [intro.jobTitle, intro.status].filter(Boolean).join(' · ')));
    if (intro.reason) who.append(el('p', intro.reason));
    row.append(who);
    list.append(row);
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

function chapterSession(data) {
  return {
    chapter: data.chapter.number,
    recommendations: data.steps?.text || null,
    recommendedAt: data.steps?.at || null,
    stepsDone: data.steps?.done || [],
  };
}

function drawApproved(data) {
  const session = data.chapter ? chapterSession(data) : currentSession(data);
  const panel = document.getElementById('c-plan');
  const progress = document.getElementById('stepprogress');
  const said = document.getElementById('stepmsg');

  const draw = () => {
    let count = 0;
    if (session.recommendations) {
      count = sheetPanel(panel, session, tick);
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
    const doneCount = session.stepsDone.filter((n) => n <= count).length;
    progress.textContent = doneCount
      ? `${doneCount} of ${count} done. Farah sees this right away.`
      : "Tap a step when it's done. Farah sees it right away.";
    document.getElementById('heroline').textContent = headline(data, session, count, doneCount);
    drawPath(data, session, count, doneCount);
  };

  let busy = false;
  async function tick(step, done) {
    if (busy) return;
    busy = true;
    said.hidden = true;
    try {
      const back = await call('/api/client?action=step', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(session.chapter ? { chapter: session.chapter, step, done }
          : { reference: session.reference, step, done }),
      }, done ? 'Marking that step done' : 'Unmarking that step');
      session.stepsDone = back.stepsDone;
      draw();
    } catch (error) {
      showProblem(said, error, done ? 'Marking that step done' : 'Unmarking that step');
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
  loadOffers(true, () => {});
}

function drawFinished(data) {
  const session = currentSession(data);
  const panel = document.getElementById('c-plan');
  panel.querySelector('.clabel').textContent = 'Your recommendation';
  sheetPanel(panel, session, null);
  panel.hidden = false;
  document.getElementById('stepprogress').hidden = true;
  document.getElementById('eyebrow').textContent = 'One Percent · Your session';
  document.getElementById('heroline').textContent = data.firstName
    ? `Your session is complete, ${data.firstName}.`
    : 'Your session is complete.';
  document.getElementById('herolede').textContent =
    'Here is the recommendation written for you from your call.';
  loadOffers(false, (quoted) => {
    document.querySelectorAll('[data-again]').forEach((node) => { node.hidden = quoted; });
  });
}

export function renderPage(data) {
  document.getElementById('page').hidden = false;
  if (data.approved) drawApproved(data);
  else drawFinished(data);
}
