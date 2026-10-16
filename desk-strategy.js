import { askModel, el, modelReady, msg, post, weekday } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';
import { renderPages } from '/desk-lists.js';

const view = { personId: null, version: null, open: new Set(), person: null };

const bullets = (list) => (list || []).map((t) => `- ${t}`).join('\n');

function fill(strategy) {
  document.getElementById('strategybody').value = strategy ? strategy.body : '';
  document.getElementById('strategytakeaways').value = strategy ? bullets(strategy.takeaways) : '';
  document.getElementById('strategychanged').value = '';
}

function row(version) {
  const li = el('li');
  const key = String(version.version);
  const button = el('button', null, 'curow');
  button.type = 'button';
  button.setAttribute('aria-expanded', String(view.open.has(key)));
  button.append(el('time', weekday(version.at)),
    el('span', `Version ${version.version}${version.changed ? ` · ${version.changed}` : ''}`),
    el('span', '›', 'chev'));
  button.lastChild.setAttribute('aria-hidden', 'true');
  const body = el('div', null, 'cubody');
  body.hidden = !view.open.has(key);
  for (const part of String(version.body).split(/\n\s*\n/)) body.append(el('p', part));
  if (version.takeaways.length) {
    body.append(el('span', 'Key takeaways', 'label'));
    const list = el('ul');
    for (const item of version.takeaways) list.append(el('li', item));
    body.append(list);
  }
  once(button, 'click', () => {
    if (view.open.has(key)) view.open.delete(key);
    else view.open.add(key);
    button.setAttribute('aria-expanded', String(view.open.has(key)));
    body.hidden = !view.open.has(key);
  });
  li.append(button, body);
  return li;
}

function renderHistory(strategy) {
  const list = document.getElementById('strategyhist');
  list.textContent = '';
  const earlier = Math.max(0, strategy.count - 1);
  document.getElementById('strategyhisthead').hidden = !earlier;
  document.getElementById('strategyhistcount').textContent = earlier ? String(earlier) : '';
  for (const version of strategy.versions) list.append(row(version));
  renderPages(document.getElementById('strategypager'), strategy.page, strategy.last, (to) => {
    const url = new URL(location.href);
    url.searchParams.set('spage', String(to));
    location.href = url.pathname + url.search + '#strategy';
  });
}

function renderDraft(person) {
  const button = document.getElementById('strategydraft');
  const label = button.querySelector('.paidlabel');
  const note = document.getElementById('strategynote');
  modelReady(button, person);
  const show = (written) => {
    document.getElementById('strategybody').value = written.body;
    document.getElementById('strategytakeaways').value = bullets(written.takeaways);
    document.getElementById('strategychanged').value = written.changed || '';
    note.textContent = [written.model, written.seconds ? `${written.seconds}s` : null,
      'not saved'].filter(Boolean).join(' · ');
  };
  label.textContent = 'Draft the strategy';
  resumeDraft(button, person, 'strategy', show);
  once(button, 'click', async () => {
    button.disabled = true;
    note.textContent = '';
    label.textContent = 'Drafting…';
    try {
      show(await askModel(button, { id: view.person.id }, 'strategy-draft'));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      button.disabled = false;
      label.textContent = 'Draft the strategy';
    }
  });
}

export function renderStrategy(person) {
  const strategy = person.strategy || { live: null, versions: [], count: 0, page: 1, last: 1 };
  const live = strategy.live;
  const version = live ? live.version : 0;
  if (view.personId !== person.id || view.version !== version) {
    Object.assign(view, { personId: person.id, version, open: new Set() });
    fill(live);
    document.getElementById('strategynote').textContent = '';
  }
  view.person = person;
  document.getElementById('strategystate').textContent = live
    ? `Version ${live.version} · ${weekday(live.at)}` : 'Not written';

  once(document.getElementById('strategyform'), 'submit', async (event) => {
    event.preventDefault();
    try {
      const out = await post('strategy', {
        id: view.person.id,
        body: document.getElementById('strategybody').value,
        takeaways: document.getElementById('strategytakeaways').value,
        changed: document.getElementById('strategychanged').value,
        after: view.version,
      });
      await settled(`Saved as version ${out.version}.`);
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });

  renderHistory(strategy);
  renderDraft(person);
}
