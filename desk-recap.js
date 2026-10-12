import { askModel, el, modelReady, msg, weekday } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';

const view = { personId: null, open: new Set(), newest: false, person: null };

function row(recap) {
  const li = el('li');
  const key = String(recap.at);
  const button = el('button', null, 'curow');
  button.type = 'button';
  button.setAttribute('aria-expanded', String(view.open.has(key)));
  button.append(el('time', weekday(recap.at)), el('span', recap.summary), el('span', '›', 'chev'));
  button.lastChild.setAttribute('aria-hidden', 'true');
  const body = el('div', null, 'cubody');
  body.hidden = !view.open.has(key);
  for (const part of String(recap.content).split(/\n\s*\n/)) body.append(el('p', part));
  body.append(el('span', [recap.model, recap.seconds === null || recap.seconds === undefined
    ? null : `${recap.seconds}s`].filter(Boolean).join(' · '), 'faint'));
  once(button, 'click', () => {
    if (view.open.has(key)) view.open.delete(key);
    else view.open.add(key);
    button.setAttribute('aria-expanded', String(view.open.has(key)));
    body.hidden = !view.open.has(key);
  });
  li.append(button, body);
  return li;
}

async function catchUp(button) {
  const label = button.querySelector('.paidlabel');
  const person = view.person;
  button.disabled = true;
  label.textContent = 'Reading the record…';
  try {
    await askModel(button, { id: person.id, of: 'recap' });
    view.newest = true;
    await settled('Catch-up saved.');
    document.getElementById('catchups').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    msg('rmsg', error.message, 'bad');
  } finally {
    button.disabled = false;
    label.textContent = 'Catch me up';
  }
}

export function renderRecap(person) {
  if (view.personId !== person.id) Object.assign(view, { personId: person.id, open: new Set(), newest: false });
  view.person = person;
  const recaps = person.recaps || [];
  if (view.newest && recaps.length) view.open.add(String(recaps[0].at));
  view.newest = false;

  const list = document.getElementById('recaps');
  list.textContent = '';
  document.getElementById('recapcount').textContent = recaps.length ? `${recaps.length} saved` : '';
  if (!recaps.length) list.append(el('li', 'None saved yet.', 'empty'));
  for (const recap of recaps) list.append(row(recap));

  const button = document.getElementById('recapit');
  modelReady(button, person);
  button.querySelector('.paidlabel').textContent = 'Catch me up';
  resumeDraft(button, person, 'recap', () => {});
  once(button, 'click', () => catchUp(button));
}
