import { el, msg, post, weekday } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';
import { renderActions } from '/desk-actions.js';
import { renderRoadmap } from '/desk-roadmap.js';

const STATUSES = [
  ['planned', 'Planned'], ['in progress', 'In progress'], ['worked', 'Worked'],
  ['changed direction', 'Changed direction'], ['stalled', 'Stalled'], ['ghosted', 'Ghosted'],
];
const TONE = { worked: 'good', stalled: 'bad', ghosted: 'bad' };

let shown = null;

function record(person, step, status, outcome, said) {
  return async () => {
    try {
      await post('milestone-record', { id: person.id, milestoneId: step.id, status, outcome });
      await settled(said, wasBefore('milestone-record',
        { id: person.id, milestoneId: step.id, status: step.status, outcome: step.outcome || '' }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  };
}

function card(person, step) {
  const tone = step.status === 'worked' ? ' worked' : step.status === 'in progress' ? ' now' : '';
  const item = el('article', null, `ms${tone}`);
  const head = el('div', null, 'mshead');
  const text = el('div', null, 'stack tight');
  const when = [`Started ${weekday(step.startedAt)}`];
  if (!['planned', 'in progress'].includes(step.status)) when.push(`${step.status} ${weekday(step.updatedAt)}`);
  if (step.shownAt) when.push(`on their page since ${weekday(step.shownAt)}`);
  text.append(el('span', step.title, 'mstitle'), el('span', when.join(' · '), 'faint'));
  head.append(el('span', String(step.position), 'msnum'), text);
  item.append(head);
  if (!step.shownAt) item.classList.add('unseen');
  const show = el('button', step.shownAt ? 'Hide from them' : 'Show on their page', 'btn small');
  show.type = 'button';
  once(show, 'click', async () => {
    show.disabled = true;
    try {
      await post('milestone-show', { id: person.id, milestoneId: step.id, shown: !step.shownAt });
      await settled(step.shownAt ? 'Hidden from them.' : 'On their page.');
    } catch (error) {
      show.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  const showRow = el('div', null, 'pair');
  if (!step.shownAt) showRow.append(el('span', 'Not on their page', 'tag'));
  showRow.append(show);
  item.append(showRow);

  const outcome = el('input');
  outcome.type = 'text';
  outcome.maxLength = 2000;
  outcome.autocomplete = 'off';
  outcome.id = `outcome-${step.id}`;
  outcome.value = step.outcome || '';
  outcome.placeholder = 'What happened';

  const chips = el('div', null, 'st6');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Status');
  for (const [value, label] of STATUSES) {
    const on = value === step.status;
    const chip = el('button', label, on && TONE[value] ? TONE[value] : null);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(on));
    if (!on) once(chip, 'click', () => record(person, step, value, outcome.value, `Milestone: ${label.toLowerCase()}.`)());
    chips.append(chip);
  }
  item.append(chips);

  const field = el('div', null, 'field');
  const name = el('label', 'Outcome');
  name.htmlFor = outcome.id;
  field.append(name, outcome);
  once(outcome, 'change', () => record(person, step, step.status, outcome.value, 'Outcome saved.')());
  item.append(field);

  renderActions(person, step, item);
  return item;
}

export function renderMilestones(person) {
  shown = person;
  const list = document.getElementById('milestonelist');
  const count = document.getElementById('stepcount');
  list.textContent = '';
  document.getElementById('addstep').hidden = !person.plan;
  renderRoadmap(person);
  if (!person.plan) {
    count.textContent = '';
    list.append(el('p', person.linkedCase ? 'No goal set.' : 'No account linked.', 'empty'));
    return;
  }
  const steps = person.milestones;
  const worked = steps.filter((s) => s.status === 'worked').length;
  const seen = steps.filter((s) => s.shownAt).length;
  count.textContent = steps.length ? `${steps.length} · ${worked} worked · ${seen} on their page` : '';
  if (!steps.length) list.append(el('p', 'No milestones yet.', 'empty'));
  for (const step of steps) list.append(card(person, step));

  const box = document.getElementById('steptitle');
  const fit = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight}px`; };
  once(box, 'input', fit);
  once(box, 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.getElementById('addstep').requestSubmit();
    }
  });
  once(document.getElementById('addstep'), 'submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('steptitle');
    if (!input.value.trim()) return;
    try {
      await post('milestone-add', { id: shown.id, title: input.value });
      input.value = '';
      fit();
      await settled('Milestone added.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}
