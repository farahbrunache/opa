import { el, link, msg, post, weekday } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';

const GOALS = [['reach', 'Reach past average'], ['smallest', 'Smallest number']];

export function renderPlan(person) {
  const box = document.getElementById('plan');
  box.textContent = '';
  document.getElementById('planset').textContent = person.plan ? `Set ${weekday(person.plan.setAt)}`
    : person.linkedCase ? 'Not set' : 'No account linked';
  for (const [value, label] of GOALS) {
    const on = Boolean(person.plan && person.plan.goal === value);
    const half = el('button', label, 'plain');
    half.type = 'button';
    half.setAttribute('aria-pressed', String(on));
    half.disabled = !person.linkedCase;
    if (!on && person.linkedCase) {
      once(half, 'click', async () => {
        half.disabled = true;
        try {
          const was = person.plan?.goal || null;
          await post('plan', { id: person.id, goal: value });
          await settled(`Goal set to ${label}.`,
            was ? wasBefore('plan', { id: person.id, goal: was }) : null);
        } catch (error) {
          half.disabled = false;
          msg('rmsg', error.message, 'bad');
        }
      });
    }
    box.append(half);
  }
}


const INTRO_OUTCOMES = [['waiting', 'Waiting'], ['worked', 'Worked'], ['went nowhere', 'Went nowhere']];

let shown = null;

const firstOf = (name) => (name ? name.split(/\s+/)[0] : null);

function otherSide(intro) {
  if (intro.them) {
    return link(intro.them.name || intro.them.reference || `Order ${intro.them.id}`,
      `/desk?id=${intro.them.id}`, intro.them.name ? null : 'mono');
  }
  let host = intro.link;
  try {
    host = new URL(intro.link).hostname;
  } catch {
  }
  const out = el('a', `Someone on ${host}`);
  out.href = intro.link;
  out.target = '_blank';
  out.rel = 'noopener';
  return out;
}

function introRow(person, intro) {
  const row = el('div', null, 'introw');
  const head = el('div', null, 'line');
  const who = el('b', null, 'wrapline');
  who.append(`${firstOf(person.name) || 'This one'} ⇄ `, otherSide(intro));
  head.append(who, el('span', weekday(intro.madeAt), 'faint'));
  row.append(head);
  if (intro.reason) row.append(el('span', intro.reason, 'muted'));

  const seg = el('div', null, 'seg three');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'What came of it');
  const note = el('input');
  note.type = 'text';
  note.maxLength = 2000;
  note.autocomplete = 'off';
  note.placeholder = 'What came of it';
  note.value = intro.note || '';
  note.setAttribute('aria-label', 'What came of it');
  const save = async (outcome, said) => {
    try {
      await post('introduction-record', {
        id: person.id, introductionId: intro.id, outcome, note: note.value,
      });
      await settled(said, wasBefore('introduction-record',
        { id: person.id, introductionId: intro.id, outcome: intro.outcome, note: intro.note || '' }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  };
  for (const [value, label] of INTRO_OUTCOMES) {
    const half = el('button', label, 'plain');
    half.type = 'button';
    half.setAttribute('aria-pressed', String(value === intro.outcome));
    if (value !== intro.outcome) once(half, 'click', () => save(value, `Introduction: ${label.toLowerCase()}.`));
    seg.append(half);
  }
  once(note, 'change', () => save(intro.outcome, 'Note saved.'));
  row.append(seg, note);
  return row;
}

export function renderIntroductions(person) {
  shown = person;
  const list = document.getElementById('introlist');
  list.textContent = '';
  const intros = person.introductions || [];
  document.getElementById('introcount').textContent = intros.length ? `${intros.length} on record` : '';
  if (!intros.length) list.append(el('p', 'No introductions yet.', 'empty'));
  for (const intro of intros) list.append(introRow(person, intro));

  once(document.getElementById('introduce'), 'submit', async (event) => {
    event.preventDefault();
    const who = document.getElementById('introwho');
    const value = who.value.trim();
    const isLink = /^https?:\/\//i.test(value);
    try {
      await post('introduce', {
        id: shown.id,
        reference: isLink ? '' : value.toUpperCase(),
        link: isLink ? value : '',
        reason: document.getElementById('introreason').value,
      });
      who.value = '';
      document.getElementById('introreason').value = '';
      await settled('Introduction recorded.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}
