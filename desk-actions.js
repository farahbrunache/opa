import { el, msg, post, weekday } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';
import { sendInMessage } from '/desk-thread.js';

const STATUSES = [['open', 'Open'], ['done', 'Done'], ['dropped', 'Dropped']];

function metaLine(action) {
  if (action.status !== 'open') {
    return `${action.status === 'done' ? 'Done' : 'Dropped'} ${weekday(action.closedAt)}`;
  }
  if (!action.shownAt) return 'Not sent yet';
  const parts = [`Sent ${weekday(action.shownAt)}`, action.cadence === 'none' ? 'No reminder'
    : `Remind ${action.cadenceLabel.charAt(0).toLowerCase()}${action.cadenceLabel.slice(1)}`];
  if (action.nextAt) parts.push(`${action.due ? 'due' : 'next'} ${weekday(action.nextAt)}`);
  if (action.askedAt) parts.push(`asked ${weekday(action.askedAt)}, still going`);
  return parts.join(' · ');
}

function cadencePicker(person, action) {
  const pick = el('select');
  pick.setAttribute('aria-label', 'Reminder');
  const choices = [...(person.cadenceChoices || [])];
  if (!choices.some((c) => c.value === action.cadence)) {
    choices.push({ value: action.cadence, label: action.cadenceLabel });
  }
  for (const { value, label } of choices) {
    const option = el('option', value === 'none' ? 'No reminder' : label);
    option.value = value;
    option.selected = value === action.cadence;
    pick.append(option);
  }
  once(pick, 'change', async () => {
    try {
      await post('action-cadence', { id: person.id, actionId: action.id, cadence: pick.value });
      await settled('Reminder changed.',
        wasBefore('action-cadence', { id: person.id, actionId: action.id, cadence: action.cadence }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
  return pick;
}

function statusSwitch(person, action) {
  const seg = el('span', null, 'mini');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Where it got to');
  for (const [value, label] of STATUSES) {
    const half = el('button', label);
    half.type = 'button';
    half.setAttribute('aria-pressed', String(value === action.status));
    if (value !== action.status) {
      once(half, 'click', async () => {
        half.disabled = true;
        try {
          await post('action-record', {
            id: person.id, actionId: action.id, status: value, outcome: action.outcome || '',
          });
          await settled(`Action: ${label.toLowerCase()}.`, wasBefore('action-record',
            { id: person.id, actionId: action.id, status: action.status, outcome: action.outcome || '' }));
        } catch (error) {
          half.disabled = false;
          msg('rmsg', error.message, 'bad');
        }
      });
    }
    seg.append(half);
  }
  return seg;
}

function outcomeField(person, action) {
  const input = el('input');
  input.type = 'text';
  input.maxLength = 2000;
  input.autocomplete = 'off';
  input.placeholder = 'What happened';
  input.setAttribute('aria-label', 'What happened');
  input.value = action.outcome || '';
  once(input, 'change', async () => {
    try {
      await post('action-record', {
        id: person.id, actionId: action.id, status: action.status, outcome: input.value,
      });
      await settled('Saved.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
  return input;
}

function actionRow(person, action) {
  const row = el('li', null, action.due ? 'act late' : 'act');
  const head = el('div', null, 'line');
  head.append(el('span', action.title, 'atext'), statusSwitch(person, action));
  row.append(head, el('span', metaLine(action), action.due ? 'ameta bad' : 'ameta'));
  if (action.status === 'open' && !action.shownAt) {
    row.classList.add('unseen');
    const pair = el('div', null, 'pair');
    const send = el('button', 'Send in a message', 'btn small');
    send.type = 'button';
    once(send, 'click', () => sendInMessage([{ id: action.id, title: action.title }]));
    pair.append(send, cadencePicker(person, action));
    row.append(pair);
  } else if (action.status === 'open') {
    const pair = el('div', null, 'pair');
    const asked = el('button', 'Asked, still going', 'btn small');
    asked.type = 'button';
    once(asked, 'click', async () => {
      asked.disabled = true;
      try {
        await post('action-push', { id: person.id, actionId: action.id });
        await settled('Asked, still going.');
      } catch (error) {
        asked.disabled = false;
        msg('rmsg', error.message, 'bad');
      }
    });
    pair.append(asked, cadencePicker(person, action));
    row.append(pair);
  } else {
    row.append(outcomeField(person, action));
  }
  return row;
}

function addForm(person, step) {
  const form = el('form', null, 'searchrow');
  form.noValidate = true;
  const input = el('input');
  input.type = 'text';
  input.maxLength = 300;
  input.autocomplete = 'off';
  input.placeholder = 'Add an action';
  input.setAttribute('aria-label', 'Add an action');
  const add = el('button', 'Add', 'btn');
  add.type = 'submit';
  form.append(input, add);
  once(form, 'submit', async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    add.disabled = true;
    try {
      await post('action-add', { id: person.id, milestoneId: step.id, title: input.value, cadence: 'none' });
      await settled('Action added.');
    } catch (error) {
      add.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return form;
}

export function renderActions(person, step, into) {
  const items = step.actions || [];
  if (items.length) {
    into.append(el('span', 'Actions', 'label'));
    const list = el('ul', null, 'acts');
    for (const action of items) list.append(actionRow(person, action));
    into.append(list);
  }
  into.append(addForm(person, step));
}
