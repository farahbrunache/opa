import { askModel, el, modelReady, msg, paidButton, weekday } from '/desk-ui.js';
import { askInMessage } from '/desk-thread.js';
import { once, resumeDraft, settled } from '/desk-after.js';

const view = { personId: null, open: new Set(), ticked: new Map(), newest: null };

const tickedIn = (set) => view.ticked.get(set.id) || new Set();

function copyText(text, button) {
  const was = button.textContent;
  navigator.clipboard.writeText(text)
    .then(() => { button.textContent = 'Copied'; })
    .catch(() => { button.textContent = 'Select it and copy'; })
    .finally(() => setTimeout(() => { button.textContent = was; }, 2000));
}

function action(person, set) {
  const row = el('div', null, 'pair');
  const button = el('button', null, person.conversationOpen ? 'btn primary small' : 'btn small');
  button.type = 'button';
  const picked = () => set.questions.filter((_, i) => tickedIn(set).has(i));
  const label = () => {
    const n = picked().length;
    button.disabled = !n;
    button.textContent = person.conversationOpen ? `Ask these in a message (${n})` : `Copy (${n})`;
  };
  label();
  once(button, 'click', () => {
    const chosen = picked();
    if (!chosen.length) return;
    if (person.conversationOpen) askInMessage(chosen.map((q) => ({ body: q.question })));
    else copyText(chosen.map((q) => q.question).join('\n'), button);
  });
  row.append(button);
  return { row, label };
}

function body(person, set) {
  const box = el('div', null, 'cubody gapbody');
  const list = el('ul', null, 'qlist');
  const { row, label } = action(person, set);
  set.questions.forEach((q, i) => {
    const li = el('li');
    const button = el('button', null, 'q');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(tickedIn(set).has(i)));
    button.append(el('span', '✓', 'box2'));
    const text = el('span');
    text.append(el('span', q.question, 'qt'));
    if (q.reason) text.append(el('span', q.reason, 'why'));
    button.append(text);
    once(button, 'click', () => {
      const ticked = new Set(tickedIn(set));
      if (ticked.has(i)) ticked.delete(i);
      else ticked.add(i);
      view.ticked.set(set.id, ticked);
      button.setAttribute('aria-pressed', String(ticked.has(i)));
      label();
    });
    li.append(button);
    list.append(li);
  });
  box.append(list, row, el('span', [set.model, set.seconds === null || set.seconds === undefined
    ? null : `${set.seconds}s`].filter(Boolean).join(' · '), 'faint'));
  return box;
}

function savedRow(person, set) {
  const li = el('li');
  const button = el('button', null, 'curow');
  button.type = 'button';
  button.setAttribute('aria-expanded', String(view.open.has(set.id)));
  button.append(el('time', weekday(set.at)), el('span', set.questions[0]?.question || ''),
    el('span', '›', 'chev'));
  button.lastChild.setAttribute('aria-hidden', 'true');
  const opened = body(person, set);
  opened.hidden = !view.open.has(set.id);
  once(button, 'click', () => {
    if (view.open.has(set.id)) view.open.delete(set.id);
    else view.open.add(set.id);
    button.setAttribute('aria-expanded', String(view.open.has(set.id)));
    opened.hidden = !view.open.has(set.id);
  });
  li.append(button, opened);
  return li;
}

export function renderGaps(person, call) {
  if (view.personId !== person.id) {
    Object.assign(view, { personId: person.id, open: new Set(), ticked: new Map(), newest: null });
  }
  if (view.newest !== null) view.open.add(view.newest);
  view.newest = null;
  const sets = (person.gaps || []).filter((set) => set.callId === call.id);
  const wrap = el('div', null, 'gaps');
  const row = el('div', null, 'pair');
  const button = paidButton('Find the gaps');
  modelReady(button, person);
  const label = button.querySelector('.paidlabel');
  resumeDraft(button, person, `gaps:${call.id}`, () => {});
  once(button, 'click', async () => {
    button.disabled = true;
    label.textContent = 'Reading the call…';
    try {
      const answer = await askModel(button, { id: call.orderId || person.id, call: call.id }, 'call-gaps');
      view.newest = answer.set?.id ?? null;
      await settled('Gaps saved.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      button.disabled = false;
      label.textContent = 'Find the gaps';
    }
  });
  row.append(button);
  wrap.append(row);
  if (sets.length) {
    const list = el('ul', null, 'cu');
    for (const set of sets) list.append(savedRow(person, set));
    wrap.append(list);
  }
  return wrap;
}
