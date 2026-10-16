import { askModel, el, modelReady, msg, paidButton, post, weekday } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';
import { sendInMessage } from '/desk-thread.js';

const VERB = {
  add: 'New activity · Drafted',
  move: 'Move to To do',
  drop: 'Drop',
};

function decide(person, draft, index, title) {
  return async (accept, reason) => {
    try {
      const out = await post('roadmap-decide', {
        id: person.id, draft: draft.id, index, decision: accept ? 'accept' : 'skip',
        title: title ? title.value : undefined, reason: reason || undefined,
      });
      if (out.send) sendInMessage([out.send]);
      await settled(accept ? 'Change made.' : 'Skipped.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  };
}

function changeRow(person, draft, change, index) {
  const li = el('li', null, change.state === 'open' ? 'rmchange' : 'rmchange done');
  const head = el('div', null, 'line');
  head.append(el('span', VERB[change.op] || change.op, 'tag t-new'));
  if (change.state !== 'open') {
    const said = change.state === 'accepted' ? 'Accepted' : `Skipped${change.skipReason
      ? ` · ${(person.skipReasons || []).find((r) => r.value === change.skipReason)?.label || change.skipReason}` : ''}`;
    head.append(el('span', said, 'faint'));
  }
  li.append(head);
  let title = null;
  if (change.state === 'open' && change.op === 'add') {
    title = el('textarea');
    title.rows = 1;
    title.maxLength = 300;
    title.value = change.title;
    title.setAttribute('aria-label', 'Change the words');
    const fit = () => {
      title.style.height = 'auto';
      title.style.height = `${title.scrollHeight + 2}px`;
    };
    title.addEventListener('input', fit);
    li.append(title);
    setTimeout(fit);
  } else {
    li.append(el('span', change.title, 'atext'));
  }
  if (change.reason) li.append(el('span', change.reason, 'why'));
  if (change.state === 'open') {
    const act = decide(person, draft, index, title);
    const pair = el('div', null, 'pair');
    const yes = el('button', change.op === 'move' ? 'Accept and write it' : 'Accept', 'btn primary small');
    yes.type = 'button';
    once(yes, 'click', () => act(true));
    const no = el('button', 'Skip', 'btn ghost small');
    no.type = 'button';
    pair.append(yes, no);
    li.append(pair);
    const reasons = el('div', null, 'reasons');
    reasons.setAttribute('role', 'group');
    reasons.setAttribute('aria-label', 'Skipping? Say why');
    reasons.append(el('span', 'Skipping? Say why:', 'faint'));
    let picked = null;
    for (const { value, label } of person.skipReasons || []) {
      const button = el('button', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      once(button, 'click', () => {
        picked = picked === value ? null : value;
        for (const other of reasons.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(picked !== null && other === button));
        }
      });
      reasons.append(button);
    }
    once(no, 'click', () => act(false, picked));
    li.append(reasons);
  }
  return li;
}

export function renderRoadmap(person) {
  const box = document.getElementById('roadmap');
  box.textContent = '';
  if (!person.plan || !person.roadmap) return;
  const row = el('div', null, 'pair');
  const button = paidButton('Redraw the roadmap');
  modelReady(button, person);
  const label = button.querySelector('.paidlabel');
  resumeDraft(button, person, 'roadmap', () => {});
  once(button, 'click', async () => {
    button.disabled = true;
    label.textContent = 'Reading the record…';
    try {
      await askModel(button, { id: person.id }, 'roadmap-draft');
      await settled('Roadmap drafted.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      button.disabled = false;
      label.textContent = 'Redraw the roadmap';
    }
  });
  row.append(button);
  box.append(row);

  const draft = person.roadmap.draft;
  if (!draft) return;
  const ai = el('div', null, 'aibox');
  ai.append(el('span', `Drafted ${weekday(draft.createdAt)}${draft.model ? ` · ${draft.model}` : ''}`, 'label'));
  if (draft.summary) ai.append(el('p', draft.summary));
  const list = el('ul', null, 'rmlist');
  draft.changes.forEach((change, index) => list.append(changeRow(person, draft, change, index)));
  if (!draft.changes.length) list.append(el('li', 'No changes proposed.', 'empty'));
  ai.append(list);
  box.append(ai);
}
