import { askModel, el, modelReady, msg, paidButton, post, weekday } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';
import { sendInMessage } from '/desk-thread.js';

const VERB = {
  'add-milestone': 'New milestone',
  'add-action': 'New action',
  'show-milestone': 'Show on their page',
  'send-action': 'Send next',
  'drop-action': 'Take off',
};

function decide(person, draft, index, change, title) {
  return async (accept) => {
    try {
      const out = await post('roadmap-decide', {
        id: person.id, draft: draft.id, index, decision: accept ? 'accept' : 'skip',
        title: title ? title.value : undefined,
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
  if (change.state !== 'open') head.append(el('span', change.state === 'accepted' ? 'Accepted' : 'Skipped', 'faint'));
  li.append(head);
  let title = null;
  if (change.state === 'open' && change.op.startsWith('add-')) {
    title = el('input');
    title.type = 'text';
    title.maxLength = 300;
    title.value = change.title;
    title.setAttribute('aria-label', 'Change the words');
    li.append(title);
  } else {
    li.append(el('span', change.title, 'atext'));
  }
  if (change.under) li.append(el('span', `Under ${change.under}`, 'faint'));
  if (change.reason) li.append(el('span', change.reason, 'why'));
  if (change.state === 'open') {
    const act = decide(person, draft, index, change, title);
    const pair = el('div', null, 'pair');
    const yes = el('button', change.op === 'send-action' ? 'Accept and write it' : 'Accept', 'btn primary small');
    yes.type = 'button';
    once(yes, 'click', () => act(true));
    const no = el('button', 'Skip', 'btn ghost small');
    no.type = 'button';
    once(no, 'click', () => act(false));
    pair.append(yes, no);
    li.append(pair);
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
