import { el, msg, post, weekday } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';
import { renderRoadmap } from '/desk-roadmap.js';
import { sendInMessage } from '/desk-thread.js';

const WORK_STATES = [['to do', 'To do'], ['doing', 'Doing'], ['done', 'Done']];

let shown = null;
const dropping = { personId: null, activityId: null };

function metaLine(activity) {
  if (activity.state === 'done') return `Done ${weekday(activity.closedAt)}`;
  if (activity.state === 'drafted') {
    return `Drafted ${weekday(activity.addedAt)} · ${activity.source === 'redraw' ? 'from a redraw ($)' : 'by you'}`;
  }
  const parts = [`On their page since ${weekday(activity.shownAt)}`];
  if (activity.fromSteps) parts.push('from your call');
  if (activity.cadence !== 'none') parts.push(`remind ${activity.cadenceLabel.charAt(0).toLowerCase()}${activity.cadenceLabel.slice(1)}`);
  if (activity.nextAt) parts.push(`${activity.due ? 'due' : 'next'} ${weekday(activity.nextAt)}`);
  if (activity.askedAt) parts.push(`asked ${weekday(activity.askedAt)}, still going`);
  return parts.join(' · ');
}

function cadencePicker(person, activity) {
  const pick = el('select');
  pick.setAttribute('aria-label', 'Reminder');
  const choices = [...(person.cadenceChoices || [])];
  if (!choices.some((c) => c.value === activity.cadence)) {
    choices.push({ value: activity.cadence, label: activity.cadenceLabel });
  }
  for (const { value, label } of choices) {
    const option = el('option', label);
    option.value = value;
    option.selected = value === activity.cadence;
    pick.append(option);
  }
  once(pick, 'change', async () => {
    try {
      await post('activity-cadence', { id: person.id, activityId: activity.id, cadence: pick.value });
      await settled('Reminder changed.',
        wasBefore('activity-cadence', { id: person.id, activityId: activity.id, cadence: activity.cadence }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
  return pick;
}

function small(label, className, onClick) {
  const button = el('button', label, className || 'btn small');
  button.type = 'button';
  once(button, 'click', async () => {
    button.disabled = true;
    try {
      await onClick();
    } catch (error) {
      button.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return button;
}

function doneBox(person, activity) {
  const box = el('div', null, 'why done');
  box.append(el('span', 'What happened', 'label'));
  const outcome = el('input');
  outcome.type = 'text';
  outcome.maxLength = 2000;
  outcome.autocomplete = 'off';
  outcome.placeholder = 'In a line, what happened';
  outcome.setAttribute('aria-label', 'What happened');
  const pair = el('div', null, 'pair');
  pair.append(small('Done', 'btn primary small', async () => {
    await post('activity-done', { id: person.id, activityId: activity.id, outcome: outcome.value });
    await settled('Activity done.');
  }), small('Cancel', 'btn ghost small', async () => {
    dropping.activityId = null;
    renderActivities(shown);
  }));
  box.append(outcome, pair);
  return box;
}

function dropBox(person, activity) {
  const box = el('div', null, 'why');
  box.append(el('span', 'Why drop it · the roadmap reads this', 'label'));
  const reasons = el('div', null, 'reasons');
  reasons.setAttribute('role', 'group');
  reasons.setAttribute('aria-label', 'Why');
  let reason = null;
  for (const { value, label } of person.dropReasons || []) {
    const button = el('button', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    once(button, 'click', () => {
      reason = value;
      for (const other of reasons.children) other.setAttribute('aria-pressed', String(other === button));
    });
    reasons.append(button);
  }
  const outcome = el('input');
  outcome.type = 'text';
  outcome.maxLength = 2000;
  outcome.autocomplete = 'off';
  outcome.placeholder = 'In a line, what happened (optional)';
  outcome.setAttribute('aria-label', 'What happened');
  const pair = el('div', null, 'pair');
  pair.append(small('Drop it', 'btn small', async () => {
    if (!reason) {
      msg('rmsg', 'Pick why before dropping it.', 'bad');
      return;
    }
    await post('activity-drop', { id: person.id, activityId: activity.id, reason, outcome: outcome.value });
    await settled('Activity dropped.');
  }), small('Cancel', 'btn ghost small', async () => {
    dropping.activityId = null;
    renderActivities(shown);
  }));
  box.append(reasons, outcome, pair);
  return box;
}

function workRow(person, work) {
  const row = el('div', null, work.late ? 'yrow late' : 'yrow');
  const head = el('div', null, 'line');
  head.append(el('b', work.title));
  const seg = el('span', null, 'mini');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Where it got to');
  const note = el('input');
  note.type = 'text';
  note.maxLength = 2000;
  note.autocomplete = 'off';
  note.placeholder = 'Note';
  note.setAttribute('aria-label', 'Note');
  note.value = work.note || '';
  const states = work.state === 'dropped' ? [...WORK_STATES, ['dropped', 'Dropped']] : WORK_STATES;
  for (const [value, label] of states) {
    const half = el('button', label);
    half.type = 'button';
    half.setAttribute('aria-pressed', String(value === work.state));
    if (value !== work.state && value !== 'dropped') {
      once(half, 'click', async () => {
        half.disabled = true;
        try {
          await post('work-move', { id: person.id, workId: work.id, state: value, note: note.value });
          await settled(`Yours: ${label.toLowerCase()}.`, work.state === 'dropped' ? null
            : wasBefore('work-move', { id: person.id, workId: work.id, state: work.state, note: work.note || '' }));
        } catch (error) {
          half.disabled = false;
          msg('rmsg', error.message, 'bad');
        }
      });
    }
    seg.append(half);
  }
  head.append(seg);
  row.append(head);
  const when = work.doneAt ? `Done ${weekday(work.doneAt)}`
    : work.state === 'dropped' ? `Dropped ${weekday(work.movedAt)}`
      : work.dueAt ? `${work.late ? 'Was due' : 'Due'} ${weekday(work.dueAt)}` : 'No date';
  row.append(el('span', when, work.late ? 'ameta bad' : 'ameta'));
  once(note, 'change', async () => {
    try {
      await post('work-move', { id: person.id, workId: work.id, state: work.state === 'dropped' ? 'to do' : work.state, note: note.value });
      await settled('Note saved.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
  const due = el('input');
  due.type = 'date';
  due.setAttribute('aria-label', 'Due');
  if (work.dueAt) due.value = String(work.dueAt).slice(0, 10);
  once(due, 'change', async () => {
    try {
      const was = work.dueAt ? String(work.dueAt).slice(0, 10) : '';
      await post('work-due', { id: person.id, workId: work.id, dueAt: due.value });
      await settled(due.value ? `Due ${weekday(`${due.value}T12:00`)}.` : 'No date on it now.',
        wasBefore('work-due', { id: person.id, workId: work.id, dueAt: was }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
  const grid = el('div', null, 'grid2');
  grid.append(note, due);
  row.append(grid);
  return row;
}

function addWorkForm(person, activity) {
  const form = el('form', null, 'searchrow');
  form.noValidate = true;
  const input = el('input');
  input.type = 'text';
  input.maxLength = 300;
  input.autocomplete = 'off';
  input.placeholder = "Something you'll do for this";
  input.setAttribute('aria-label', "Something you'll do for this");
  const add = el('button', 'Add', 'btn');
  add.type = 'submit';
  form.append(input, add);
  once(form, 'submit', async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    add.disabled = true;
    try {
      await post('work-take', { id: person.id, title: input.value, activityId: activity ? activity.id : undefined });
      await settled('Added to what is yours to do.');
    } catch (error) {
      add.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return form;
}

function yours(person, activity, work) {
  const box = el('div', null, 'yours');
  box.append(el('span', `Yours to do · ${work.length}`, 'label'));
  for (const row of work) box.append(workRow(person, row));
  box.append(addWorkForm(person, activity));
  return box;
}

function card(person, activity, work) {
  const item = el('article', null, `ms acard ${activity.state}${activity.due ? ' late' : ''}`);
  const head = el('div', null, 'mshead');
  const text = el('div', null, 'stack tight');
  text.append(el('span', activity.title, 'mstitle'));
  const meta = [metaLine(activity)];
  if (activity.state === 'done') {
    for (const w of work) meta.push(`yours: ${w.title}, ${w.doneAt ? `done ${weekday(w.doneAt)}` : w.state}`);
    if (activity.sessionsUsed) meta.push(`used ${activity.sessionsUsed} session${activity.sessionsUsed === 1 ? '' : 's'}`);
  }
  text.append(el('span', meta.join(' · '), activity.due ? 'faint bad' : 'faint'));
  const mark = { todo: '→', drafted: '·', done: '✓' }[activity.state] || '·';
  head.append(el('span', mark, 'msnum'), text);
  item.append(head);

  const opening = dropping.personId === person.id && dropping.activityId === activity.id ? dropping.what : null;
  const buttons = el('div', null, 'abtns');
  if (activity.state === 'todo') {
    buttons.append(small('Done', 'btn small', async () => {
      Object.assign(dropping, { personId: person.id, activityId: activity.id, what: 'done' });
      renderActivities(shown);
    }));
    buttons.append(small('Drop', 'btn small', async () => {
      Object.assign(dropping, { personId: person.id, activityId: activity.id, what: 'drop' });
      renderActivities(shown);
    }));
    buttons.append(small('Asked, still going', 'btn small', async () => {
      await post('activity-push', { id: person.id, activityId: activity.id });
      await settled('Asked, still going.');
    }));
    buttons.append(cadencePicker(person, activity));
    item.append(buttons);
    if (opening === 'done') item.append(doneBox(person, activity));
    if (opening === 'drop') item.append(dropBox(person, activity));
    item.append(yours(person, activity, work));
  } else if (activity.state === 'drafted') {
    buttons.append(small('Move to To do', 'btn primary small', async () => {
      const out = await post('activity-move', { id: person.id, activityId: activity.id });
      sendInMessage([out.activity]);
      await settled('On their page. A message is drafted for you to send.');
    }));
    buttons.append(small('Drop', 'btn small', async () => {
      Object.assign(dropping, { personId: person.id, activityId: activity.id, what: 'drop' });
      renderActivities(shown);
    }));
    item.append(buttons);
    if (opening === 'drop') item.append(dropBox(person, activity));
  } else {
    const field = el('div', null, 'field');
    const outcome = el('input');
    outcome.type = 'text';
    outcome.maxLength = 2000;
    outcome.autocomplete = 'off';
    outcome.id = `outcome-${activity.id}`;
    outcome.value = activity.outcome || '';
    outcome.placeholder = 'What happened';
    const name = el('label', 'What happened');
    name.htmlFor = outcome.id;
    field.append(name, outcome);
    once(outcome, 'change', async () => {
      try {
        await post('activity-outcome', { id: person.id, activityId: activity.id, outcome: outcome.value });
        await settled('Outcome saved.');
      } catch (error) {
        msg('rmsg', error.message, 'bad');
      }
    });
    item.append(field);
    buttons.append(small('Back to To do', 'btn ghost small', async () => {
      await post('activity-reopen', { id: person.id, activityId: activity.id });
      await settled('Back on their page.');
    }));
    item.append(buttons);
  }
  return item;
}

function group(title, said, tone, items) {
  const head = el('h3', null, tone ? `rmgroup ${tone}` : 'rmgroup');
  head.append(document.createTextNode(`${title} `), el('span', said));
  const list = el('div', null, 'stack');
  for (const item of items) list.append(item);
  return [head, list];
}

export function renderActivities(person) {
  shown = person;
  if (dropping.personId !== person.id) Object.assign(dropping, { personId: person.id, activityId: null, what: null });
  const list = document.getElementById('activitylist');
  const count = document.getElementById('activitycount');
  list.textContent = '';
  document.getElementById('addactivity').hidden = !person.linkedCase;
  renderRoadmap(person);
  if (!person.linkedCase) {
    count.textContent = 'No account linked';
    return;
  }
  const items = person.activities || [];
  const work = person.work || [];
  const of = (state) => items.filter((a) => a.state === state);
  const n = (state) => of(state).length;
  count.textContent = items.length
    ? `${items.length} activities · ${n('done')} done · ${n('todo')} to do · ${n('drafted')} drafted` : '';
  if (!items.length) list.append(el('p', 'No activities yet.', 'empty'));

  const workFor = (activity) => work.filter((w) => w.activityId === activity.id);
  const loose = work.filter((w) => w.activityId === null || !items.some((a) => a.id === w.activityId));
  const todo = of('todo').map((a) => card(person, a, workFor(a)));
  if (loose.length || todo.length) {
    const [head, body] = group('To do', `${todo.length} · on their page`, 'todo', todo);
    list.append(head);
    if (loose.length) {
      const box = el('article', null, 'ms acard');
      box.append(el('span', 'Not tied to an activity', 'mstitle'));
      box.append(yours(person, null, loose));
      list.append(box);
    }
    list.append(body);
  }
  if (n('drafted')) list.append(...group('Drafted', `${n('drafted')} · only you see these`, 'draft', of('drafted').map((a) => card(person, a, []))));
  if (n('done')) list.append(...group('Done', String(n('done')), null, of('done').map((a) => card(person, a, workFor(a)))));
  if (n('dropped')) {
    const rows = of('dropped').map((a) => {
      const p = el('p', null, 'drow');
      p.append(el('b', a.title), ` · dropped ${weekday(a.closedAt)} · ${a.dropReasonLabel}${a.outcome ? `: "${a.outcome}"` : ''}`);
      return p;
    });
    const [head] = group('Dropped', `${n('dropped')} · only you see these`, null, []);
    const box = el('div', null, 'dropped');
    for (const row of rows) box.append(row);
    list.append(head, box);
  }

  const box = document.getElementById('activitytitle');
  const fit = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight}px`; };
  once(box, 'input', fit);
  once(box, 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.getElementById('addactivity').requestSubmit();
    }
  });
  once(document.getElementById('addactivity'), 'submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('activitytitle');
    if (!input.value.trim()) return;
    try {
      await post('activity-add', { id: shown.id, title: input.value });
      input.value = '';
      fit();
      await settled('Activity drafted.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}
