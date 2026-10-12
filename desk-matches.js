import { askModel, el, link, modelReady, msg, paidButton, post } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';

const found = { personId: null, said: null, suggestions: null, fresh: false };

function otherSide(s) {
  return s.kind === 'client' ? { order: s.orderId } : { profile: s.profileId };
}

function side(name, role) {
  const box = el('div', null, 'pp');
  box.append(el('b', name), el('span', role));
  return box;
}

function suggestionCard(person, s) {
  const item = el('div', null, 'sugcard');
  const pairRow = el('div', null, 'sugpair');
  const them = s.kind === 'client'
    ? side(s.name || s.reference, ['Client', s.title].filter(Boolean).join(' · '))
    : side(s.name || 'Directory profile', s.claimed ? ['Directory', s.title].filter(Boolean).join(' · ')
      : 'Directory · Unclaimed');
  if (s.kind === 'client') {
    const open = link('Open', `/desk?id=${s.orderId}`, 'faint');
    them.append(open);
  }
  pairRow.append(side(person.name || person.reference, person.trade?.title || 'Client'),
    el('span', '⇄', 'link'), them);
  item.append(pairRow, el('p', s.reason));
  if ((s.sources || []).length) {
    const chips = el('div', null, 'srcs');
    for (const source of s.sources) chips.append(el('span', source, 'src'));
    item.append(chips);
  }
  if (s.isDemo) item.append(el('span', 'Demo', 'tag t-demo'));

  const pair = el('div', null, 'pair');
  const introduce = el('button', 'Introduce', 'btn primary small');
  introduce.type = 'button';
  introduce.disabled = s.kind === 'directory' && !s.link;
  once(introduce, 'click', async () => {
    introduce.disabled = true;
    try {
      await post('introduce', s.kind === 'client'
        ? { id: person.id, reference: s.reference, reason: s.reason }
        : { id: person.id, link: s.link, reason: s.reason });
      found.suggestions = found.suggestions.filter((x) => x !== s);
      found.fresh = false;
      await settled(`Introduced to ${s.name || s.reference || 'the profile'}.`);
    } catch (error) {
      introduce.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  const skip = el('button', 'Skip', 'btn ghost small');
  skip.type = 'button';
  once(skip, 'click', async () => {
    skip.disabled = true;
    const body = { id: person.id, ...otherSide(s) };
    try {
      await post('skip', body);
      const at = found.suggestions.indexOf(s);
      found.suggestions = found.suggestions.filter((x) => x !== s);
      found.fresh = false;
      await settled('Skipped. It won\'t be suggested again.', async () => {
        await post('unskip', body);
        found.suggestions.splice(at, 0, s);
      });
    } catch (error) {
      skip.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  pair.append(introduce, skip);
  item.append(pair);
  return item;
}

function drawFound(person) {
  const box = document.getElementById('found');
  box.textContent = '';
  box.hidden = found.personId !== person.id || !found.suggestions
    || (!found.suggestions.length && !found.fresh);
  if (box.hidden) return;
  box.append(el('span', 'Suggested introductions', 'label'));
  if (found.said) box.append(el('span', found.said, 'faint'));
  if (!found.suggestions.length) box.append(el('p', 'No match worth making.', 'empty'));
  for (const s of found.suggestions) box.append(suggestionCard(person, s));
}

export function renderMatches(person) {
  if (found.personId !== person.id) Object.assign(found, { personId: person.id, said: null, suggestions: null, fresh: false });
  const row = document.getElementById('matchgo');
  for (const old of row.querySelectorAll('.paid')) old.remove();
  if (person.linkedCase) {
    const button = paidButton('Find matches');
    modelReady(button, person);
    const label = button.querySelector('.paidlabel');
    const show = (answer) => {
      Object.assign(found, { said: answer.said, suggestions: answer.suggestions || [], fresh: true });
    };
    resumeDraft(button, person, 'matches', show);
    once(button, 'click', async () => {
      button.disabled = true;
      label.textContent = 'Reading the desk…';
      try {
        show(await askModel(button, { id: person.id }, 'find-matches'));
        drawFound(person);
        document.getElementById('found').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) {
        msg('rmsg', error.message, 'bad');
      } finally {
        button.disabled = false;
        label.textContent = 'Find matches';
      }
    });
    row.append(button);
  }
  drawFound(person);
}
