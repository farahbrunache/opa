import { el, msg, post, weekday } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';

const STATES = [['to do', 'To do'], ['doing', 'Doing'], ['delivered', 'Delivered'], ['dropped', 'Dropped']];

let shown = null;

const dollars = (value) => `$${Number(value) % 1 ? Number(value).toFixed(2) : Number(value)}`;

function when(work) {
  if (work.deliveredAt) return `Delivered ${weekday(work.deliveredAt)}`;
  if (work.state === 'dropped') return `Dropped ${weekday(work.movedAt)}`;
  if (work.dueAt) return `${work.late ? 'Was due' : 'Due'} ${weekday(work.dueAt)}`;
  return 'No date';
}

function fromQuote(person, work) {
  const quote = (person.quotes || []).find((q) => q.id === work.quoteId);
  if (!quote) return 'No quote';
  const agreed = quote.answeredAt && ['agreed', 'paid'].includes(quote.status)
    ? ` · accepted ${weekday(quote.answeredAt)}` : ` · ${quote.status}`;
  return `From quote ${dollars(quote.amount)}${agreed}`;
}

function move(person, work, state, note, said) {
  return async () => {
    try {
      await post('work-move', { id: person.id, projectId: work.id, state, note });
      await settled(said, wasBefore('work-move',
        { id: person.id, projectId: work.id, state: work.state, note: work.note || '' }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  };
}

function card(person, work) {
  const item = el('div', null, work.late ? 'item late' : 'item');
  const head = el('div', null, 'line');
  head.append(el('span', work.title, 'title'), el('span', when(work), work.late ? 'bad' : 'faint'));
  item.append(head);

  const note = el('input');
  note.type = 'text';
  note.maxLength = 2000;
  note.autocomplete = 'off';
  note.placeholder = 'Note';
  note.setAttribute('aria-label', 'Note');
  note.value = work.note || '';

  const seg = el('div', null, 'seg four');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Where it got to');
  for (const [value, label] of STATES) {
    const half = el('button', label, 'plain');
    half.type = 'button';
    half.setAttribute('aria-pressed', String(value === work.state));
    if (value !== work.state) once(half, 'click', () => move(person, work, value, note.value, `Now ${value}.`)());
    seg.append(half);
  }
  once(note, 'change', () => move(person, work, work.state, note.value, 'Note saved.')());

  const due = el('input');
  due.type = 'date';
  due.setAttribute('aria-label', 'Due');
  if (work.dueAt) due.value = String(work.dueAt).slice(0, 10);
  once(due, 'change', async () => {
    try {
      const was = work.dueAt ? String(work.dueAt).slice(0, 10) : '';
      await post('work-due', { id: person.id, projectId: work.id, dueAt: due.value });
      await settled(due.value ? `Due ${weekday(`${due.value}T12:00`)}.` : 'No date on it now.',
        wasBefore('work-due', { id: person.id, projectId: work.id, dueAt: was }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
  const dueRow = el('div', null, 'line');
  dueRow.append(el('span', 'Due', 'label'), due);
  item.append(seg, note, dueRow, el('span', fromQuote(person, work), 'faint'));
  return item;
}

function wireAdd(person) {
  const form = document.getElementById('addwork');
  const pick = document.getElementById('workquote');
  const was = pick.value;
  pick.textContent = '';
  const none = el('option', 'No quote');
  none.value = '';
  pick.append(none);
  for (const quote of person.quotes || []) {
    const option = el('option', `${dollars(quote.amount)} · ${quote.scope.slice(0, 50)}`);
    option.value = String(quote.id);
    pick.append(option);
  }
  pick.value = [...pick.options].some((o) => o.value === was) ? was : '';

  once(form, 'submit', async (event) => {
    event.preventDefault();
    const title = document.getElementById('worktitle');
    if (!title.value.trim()) return;
    try {
      await post('work-take', {
        id: shown.id,
        title: title.value,
        quoteId: pick.value || undefined,
        dueAt: document.getElementById('workdue').value,
      });
      title.value = '';
      document.getElementById('workdue').value = '';
      await settled('Added to what you owe them.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}

export function renderWork(person) {
  shown = person;
  const list = document.getElementById('worklist');
  const count = document.getElementById('workcount');
  list.textContent = '';
  document.getElementById('addwork').hidden = !person.linkedCase;
  if (!person.linkedCase) {
    count.textContent = 'No account linked';
    return;
  }
  wireAdd(person);

  const items = person.projects || [];
  const open = items.filter((w) => !w.deliveredAt && w.state !== 'dropped').length;
  const delivered = items.filter((w) => w.deliveredAt).length;
  count.textContent = items.length
    ? [`${open} open`, delivered ? `${delivered} delivered` : null].filter(Boolean).join(' · ') : '';
  if (!items.length) list.append(el('p', 'Nothing owed yet.', 'empty'));
  for (const work of items) list.append(card(person, work));
}
