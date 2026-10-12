import { el, link, msg, post, minutes, demoChip, weekday, stamp, asked } from '/desk-ui.js';
import { once } from '/desk-after.js';
import { renderToConfirm, waitingNow } from '/desk-confirm.js';

const STATES = [
  ['waiting', 'New calls'],
  ['replies', 'Wrote to you'],
  ['active', 'Working'],
  ['closed', 'Closed'],
];

export function renderDateline() {
  const said = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  for (const id of ['today', 'todaydate']) {
    const box = document.getElementById(id);
    if (box) box.textContent = said;
  }
}

export function renderPages(box, page, last, go) {
  box.textContent = '';
  box.hidden = last <= 1;
  if (last <= 1) return;
  const button = (label, to, current) => {
    const b = el('button', label, current ? 'on' : null);
    b.type = 'button';
    if (current) b.setAttribute('aria-current', 'page');
    if (to < 1 || to > last) b.disabled = true;
    else b.addEventListener('click', () => go(to));
    return b;
  };
  box.append(button('Prev', page - 1));
  for (let n = 1; n <= last; n += 1) {
    if (n === 1 || n === last || Math.abs(n - page) <= 1) box.append(button(String(n), n, n === page));
    else if (Math.abs(n - page) === 2) box.append(el('span', '…', 'meta'));
  }
  box.append(button('Next', page + 1));
}

function whoBlock(row) {
  const who = el('span', null, 'who');
  who.append(el('span', row.name || 'No name yet', 'name'));
  who.append(el('span', row.reference || `Order ${row.id}`, 'code'));
  return who;
}

function waited(hours) {
  if (hours === null || hours === undefined) return '';
  if (hours < 1) return 'Waiting under an hour';
  if (hours < 48) {
    const n = Math.floor(hours);
    return `Waiting ${n} ${n === 1 ? 'hr' : 'hrs'}`;
  }
  return `Waiting ${Math.floor(hours / 24)} days`;
}

function dueLine(row) {
  if (!row.dueAt) return null;
  const late = Math.floor((row.hoursWaiting || 0) / 24);
  const line = el('span', `Due ${weekday(row.dueAt)}`, late >= 1 ? 'when late' : 'when');
  if (late >= 1) line.textContent += ` · ${late} ${late === 1 ? 'day' : 'days'} late`;
  return line;
}

const PER_PAGE = 15;
let todayPage = 1;
let todayData = null;
let todayFilter = null;

const TODAY_COUNTS = [
  ['toConfirm', 'payment to confirm', 'payments to confirm'],
  ['calls', 'new call', 'new calls'],
  ['pivots', 'new direction', 'new directions'],
  ['followUps', 'follow-up call', 'follow-up calls'],
  ['unread', 'unread message', 'unread messages'],
  ['owing', 'work item past due', 'work items past due', 'red'],
  ['due', 'follow-up due', 'follow-ups due'],
];

const REASONS = [
  ['calls', 'New call', 't-new', () => 'Read the call, then go or no-go.'],
  ['pivots', 'Pivot', 't-pivot', (row) => `New direction: ${row.direction}. `],
  ['followUps', 'Follow-up call', 't-call', () => 'Write next steps.'],
  ['unread', 'Message', 't-msg', () => 'Wrote to you. Waiting on your reply.'],
  ['owing', 'Yours to do', 't-owe', (row) => row.title],
  ['due', 'Follow up', 't-ask', (row) => row.title],
];

function gather(data) {
  const people = new Map();
  for (const [key, label, tone, words] of REASONS) {
    for (const row of data[key] || []) {
      const whose = row.caseId ? `case:${row.caseId}` : `order:${row.id}`;
      if (!people.has(whose)) {
        people.set(whose, { id: row.id, reference: row.reference, name: row.name, isDemo: row.isDemo,
          isMine: row.isMine, hours: null, keys: new Set(), reasons: [],
          check: data.referrals?.[row.id]?.check || null });
      }
      const who = people.get(whose);
      if (row.hoursWaiting !== null && row.hoursWaiting > (who.hours ?? -1)) who.hours = row.hoursWaiting;
      who.keys.add(key);
      const extra = [];
      if (row.wasBlocked) extra.push('Was blocked');
      if (row.cadenceLabel && key === 'due') extra.push(row.cadenceLabel);
      who.reasons.push({ label, tone, said: words(row), extra, due: dueLine(row) });
    }
  }
  return [...people.values()];
}

function renderWho(who, target, first) {
  const card = link('', `/desk?id=${who.id}`, first ? 'card urgent' : 'card');
  const head = el('div', null, 'chead');
  const name = whoBlock(who);
  if (who.isDemo || who.isMine) {
    const chips = el('span', null, 'chips');
    demoChip(who, chips);
    name.append(chips);
  }
  head.append(name);
  head.append(el('span', waited(who.hours), who.hours !== null && who.hours >= target ? 'wait hot' : 'wait'));
  card.append(head);
  const todo = el('ul', null, 'todo');
  if (who.check) {
    const line = el('li');
    line.append(el('span', 'Check', 'tag t-flag'),
      el('span', `Brought by ${who.check}, who you flagged.`, 'flagline'));
    todo.append(line);
  }
  for (const reason of who.reasons) {
    const line = el('li');
    line.append(el('span', reason.label, `tag ${reason.tone}`));
    const said = el('span', reason.said);
    for (const bit of reason.extra) said.append(el('span', bit, 'when'));
    if (reason.due) said.append(reason.due);
    line.append(said);
    todo.append(line);
  }
  card.append(todo);
  const opens = el('div', null, 'opens');
  opens.append(el('span', 'Open'), el('span', '→'));
  card.append(opens);
  return card;
}

function chip(key, n, words, red, extra) {
  const button = el('button', null, `fchip${red ? ' red' : ''}${n ? ' some' : ''}`);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(todayFilter === key));
  button.append(el('span', n.toLocaleString(), 'n'), ` ${words}`);
  if (extra) button.append(el('span', ` · ${extra}`, 'more'));
  button.addEventListener('click', () => {
    todayFilter = todayFilter === key ? null : key;
    todayPage = 1;
    renderFirstScreen(todayData);
  });
  return button;
}

export function renderFirstScreen(data) {
  renderDateline();
  todayData = data;
  const people = gather(data);
  const pastTarget = (who) => who.hours !== null && who.hours >= data.targetHours;
  const late = people.filter(pastTarget).length;

  const counts = document.getElementById('todaycount');
  counts.textContent = '';
  const waiting = waitingNow(data);
  const pastConfirm = waiting.some((order) => order.hoursWaiting > data.confirmTargetHours);
  for (const [key, one, many, red] of TODAY_COUNTS) {
    const confirming = key === 'toConfirm';
    const answered = confirming ? (data.toConfirm || []).length - waiting.length : 0;
    const n = (data.totals?.[key] || 0) - answered;
    const shown = (data[key] || []).length - answered;
    counts.append(chip(key, n, n === 1 ? one : many, confirming ? pastConfirm : red,
      n > shown ? `oldest ${shown} shown` : null));
  }
  counts.append(chip('target', late, `past ${data.targetHours} hours`, false, null));

  const shown = !todayFilter ? people
    : todayFilter === 'target' ? people.filter(pastTarget)
      : people.filter((who) => who.keys.has(todayFilter));
  const last = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  todayPage = Math.min(todayPage, last);
  renderToConfirm(data, !todayFilter || todayFilter === 'toConfirm', () => renderFirstScreen(todayData));
  const box = document.getElementById('todaylist');
  box.textContent = '';
  shown.slice((todayPage - 1) * PER_PAGE, todayPage * PER_PAGE).forEach((who, i) => {
    const item = el('li');
    item.append(renderWho(who, data.targetHours, todayPage === 1 && i === 0));
    box.append(item);
  });
  renderPages(document.getElementById('todaypager'), todayPage, last, (to) => {
    todayPage = to;
    renderFirstScreen(todayData);
    document.getElementById('todayview').scrollIntoView();
  });
  paintOutreach(data.approached);
}

let justTapped = null;

function paintOutreach(state) {
  const total = state?.total;
  const shown = total === null || total === undefined ? '' : String(total);
  document.getElementById('tpool').textContent = shown || '—';
  document.getElementById('tweek').textContent = String(state?.week || 0);
  document.getElementById('tlast').textContent = justTapped
    ? `Logged ${stamp(justTapped.at)}`
    : state?.lastAt ? `Last logged ${stamp(state.lastAt)}` : '';
  document.getElementById('tundo').hidden = !justTapped;
  document.getElementById('tfixsize').value = shown;
}

once(document.getElementById('taddone'), 'click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const out = await post('funnel-pool', { add: 1 });
    justTapped = out.tap;
    paintOutreach(out);
  } catch (error) {
    msg('tmsg', error.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

once(document.getElementById('tundo'), 'click', async (event) => {
  const button = event.currentTarget;
  if (!justTapped) return;
  button.disabled = true;
  try {
    const out = await post('funnel-pool', { undo: justTapped.id });
    justTapped = null;
    paintOutreach(out);
    document.getElementById('tlast').textContent = 'Last one taken back';
  } catch (error) {
    msg('tmsg', error.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

once(document.getElementById('tfix'), 'click', () => {
  const form = document.getElementById('tfixform');
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById('tfixsize').focus();
});

once(document.getElementById('tfixform'), 'submit', async (event) => {
  event.preventDefault();
  try {
    const out = await post('funnel-pool', { pool: document.getElementById('tfixsize').value });
    justTapped = null;
    document.getElementById('tfixform').hidden = true;
    paintOutreach(out);
  } catch (error) {
    msg('tmsg', error.message, 'bad');
  }
});

function renderTabs(active, counts) {
  const tabs = document.getElementById('tabs');
  tabs.textContent = '';
  for (const [value, label] of STATES) {
    const a = link('', `/desk?state=${value}`, 'stat');
    a.append(el('b', String(counts?.[value] ?? 0)), el('span', label));
    if (!asked && value === active) a.setAttribute('aria-current', 'page');
    tabs.append(a);
  }
}

const DECISION = { go: 'Go', 'no-go': 'No-go' };

function hoursSince(at) {
  return at ? (Date.now() - new Date(at).getTime()) / 3_600_000 : null;
}

function late(at) {
  const days = Math.floor(hoursSince(at) / 24);
  return days >= 1 ? `${days} ${days === 1 ? 'day' : 'days'} late` : 'late';
}

function rowFacts(person, group) {
  const code = person.reference || `Order ${person.id}`;
  const decided = DECISION[person.decision] || 'Not read yet';
  if (group === 'waiting') {
    return [code, person.calledAt ? `Called ${weekday(person.calledAt)}` : 'No call yet', minutes(person.seconds)];
  }
  if (group === 'replies') return [code, `Wrote ${stamp(person.wroteAt)}`];
  if (group === 'active') {
    const facts = [code, decided];
    if (person.activities) facts.push(`${person.activitiesDone} of ${person.activities} activities done`);
    if (person.sessionsLeft) facts.push(`${person.sessionsLeft} session${person.sessionsLeft === 1 ? '' : 's'} on the card`);
    return facts;
  }
  return [code, decided, `Closed ${weekday(person.closedAt)}`];
}

function rowNext(person, group) {
  if (group === 'waiting') {
    const said = person.callRead ? 'Next: decide go or no-go' : 'Next: read the call, then write next steps';
    return [person.linked ? said : `${said} · No account linked`, ''];
  }
  if (group === 'replies') return [`Next: reply · ${waited(hoursSince(person.wroteAt)).toLowerCase()}`, ''];
  if (group === 'active') {
    if (person.followUp && !person.recommendedAt) return ['Next: write next steps · follow-up call', ''];
    if (person.workDueAt) return [`your work ${late(person.workDueAt)}`, 'late'];
    if (person.reminderAt) return [`Next: reminder due ${weekday(person.reminderAt)}`, ''];
    if (person.introWaiting) {
      return [person.introWith ? `Introduction to ${person.introWith} waiting` : 'Introduction waiting', ''];
    }
    return [person.lastContactAt ? `Nothing due · last contact ${weekday(person.lastContactAt)}` : 'Nothing due', 'none'];
  }
  return person.recommendedAt
    ? ['Recommendation sent · nothing more to do', 'none']
    : ['Next: write their next steps', ''];
}

export function renderQueue(data) {
  renderDateline();
  renderTabs(data.state, data.counts);
  for (const id of ['qfind', 'tfind']) document.getElementById(id).value = asked;
  const approached = data.approached === null || data.approached === undefined ? '—' : data.approached;
  document.getElementById('qfigures').textContent = `${approached} approached · ${data.paid} paid`;
  const first = (data.page - 1) * data.perPage + 1;
  const last = first + data.people.length - 1;
  document.getElementById('qcount').textContent = asked
    ? (data.total
      ? `${data.total} ${data.total === 1 ? 'match' : 'matches'} for "${asked}" across all four`
        + (data.total > data.perPage ? ` · ${first}–${last}` : '')
      : `Nobody matches "${asked}". Search looks at names and codes.`)
    : data.total
      ? `${first}–${last} of ${data.total}`
      : 'Nothing in this one.';

  const list = document.getElementById('people');
  list.textContent = '';
  for (const person of data.people) {
    const row = link('', `/desk?id=${person.id}`, 'prow');
    const group = asked ? person.group : data.state;
    const who = whoBlock(person);
    const [code, ...facts] = rowFacts(person, group);
    const brought = data.referrals?.[person.id];
    if (brought?.via) facts.push(`via ${brought.via}`);
    who.lastChild.textContent = code;
    who.lastChild.append(el('span', ` · ${facts.join(' · ')}`, 'said'));
    if (person.isDemo || person.isMine) {
      const chips = el('span', null, 'chips');
      demoChip(person, chips);
      who.append(chips);
    }
    const [said, tone] = rowNext(person, group);
    row.append(who, el('span', said, tone ? `next ${tone}` : 'next'));
    if (data.pivots?.[person.id]) {
      row.append(el('span', `New direction: ${data.pivots[person.id]}.`, 'next pivot'));
    }
    if (brought?.check) row.append(el('span', `Brought by ${brought.check}, who you flagged`, 'next late'));
    row.append(el('span', '→', 'chev'));
    const item = el('li');
    item.append(row);
    list.append(item);
  }
  const lastPage = Math.max(1, Math.ceil(data.total / data.perPage));
  renderPages(document.getElementById('pager'), data.page, lastPage, (to) => {
    location.href = asked
      ? `/desk?q=${encodeURIComponent(asked)}&page=${to}`
      : `/desk?state=${data.state}&page=${to}`;
  });
}
