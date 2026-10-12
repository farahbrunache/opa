import { el, get, link, msg, post, weekday } from '/desk-ui.js';
import { once, settled } from '/desk-after.js';
import { renderPages } from '/desk-lists.js';

const STATUS_TONE = {
  Go: 't-quote', 'No-go': 't-owe', Wrote: 't-msg', 'New call': 't-new', Closed: 't-demo', Paid: 't-demo', Flagged: 't-flag',
};

const latest = { person: null };

const firstName = (row) => (row.name ? row.name.split(/\s+/)[0] : row.reference);
const shown = (row) => row.name || 'No name yet';

function personRow(row, facts) {
  const item = link('', `/desk?id=${row.id}`, 'brow');
  const who = el('span', null, 'who');
  who.append(el('b', shown(row)), el('small', [row.reference, ...facts].filter(Boolean).join(' · ')));
  item.append(who);
  if (row.status) item.append(el('span', row.status, `tag ${STATUS_TONE[row.status] || 't-demo'}`));
  return item;
}

export function flaggedTag(person) {
  return person.broughtBy?.flaggedAt ? el('span', 'Flagged', 'tag t-flag') : null;
}

export function renderBroughtBy(person) {
  const box = document.getElementById('brought');
  const data = person.broughtBy;
  latest.person = person;
  box.hidden = !data;
  if (!data) return;
  const them = firstName({ name: person.name, reference: person.reference || `Order ${person.id}` });

  const by = document.getElementById('bby');
  by.textContent = '';
  if (data.by) {
    by.append(personRow(data.by, [data.how === 'link' ? 'through their link' : 'set by you',
      data.by.paidAt ? `paid ${weekday(data.by.paidAt)}` : null]));
  } else {
    by.append(el('p', data.how === 'unknown' ? "Don't know" : 'Your outreach', 'said'));
  }
  if (data.check) {
    by.append(el('p', `Brought by ${data.check.name}, who you flagged.`, 'flagline'));
  }

  const form = document.getElementById('bform');
  const field = document.getElementById('breffield');
  const pick = (how) => {
    for (const half of document.querySelectorAll('#bhow button')) {
      half.setAttribute('aria-pressed', String(half.dataset.how === how));
    }
    field.hidden = how !== 'person';
  };
  form.hidden = true;
  once(document.getElementById('bchange'), 'click', () => {
    const now = latest.person.broughtBy;
    pick(now.by ? 'person' : now.how === 'unknown' ? 'unknown' : 'outreach');
    document.getElementById('bref').value = now.by?.reference || '';
    form.hidden = false;
  });
  for (const half of document.querySelectorAll('#bhow button')) once(half, 'click', () => pick(half.dataset.how));
  once(document.getElementById('bcancel'), 'click', () => {
    form.hidden = true;
  });
  once(form, 'submit', async (event) => {
    event.preventDefault();
    const how = document.querySelector('#bhow [aria-pressed="true"]')?.dataset.how;
    try {
      await post('brought-by', { id: latest.person.id, how,
        reference: document.getElementById('bref').value });
      await settled('Brought by changed.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });

  const head = document.getElementById('bbroughthead');
  const list = document.getElementById('bbrought');
  list.textContent = '';
  head.hidden = !data.broughtTotal;
  document.getElementById('bbroughtlabel').textContent = `${them} brought · ${data.broughtTotal}`;
  for (const row of data.brought) {
    list.append(personRow(row, [row.paidAt ? `paid ${weekday(row.paidAt)}` : null]));
  }
  renderPages(document.getElementById('bbroughtpager'), data.broughtPage, data.broughtLast, (to) => {
    const url = new URL(location.href);
    url.searchParams.set('bpage', String(to));
    location.href = url.pathname + url.search + '#brought';
  });

  const said = document.getElementById('flagsaid');
  const open = document.getElementById('flagopen');
  const flagForm = document.getElementById('flagform');
  const unflag = document.getElementById('unflag');
  const flagged = Boolean(data.flaggedAt);
  said.hidden = !flagged;
  said.textContent = flagged
    ? [`Flagged ${weekday(data.flaggedAt)}.`, data.under ? `${data.under} down their chain marked to check.` : null,
      data.why ? `Why: ${data.why}` : null].filter(Boolean).join(' ')
    : '';
  open.hidden = flagged;
  unflag.hidden = !flagged;
  flagForm.hidden = true;
  document.getElementById('flagyes').textContent = `Flag ${them}`;
  once(open, 'click', () => {
    flagForm.hidden = false;
    open.hidden = true;
    document.getElementById('flagwhy').focus();
  });
  once(document.getElementById('flagno'), 'click', () => {
    flagForm.hidden = true;
    open.hidden = false;
  });
  once(flagForm, 'submit', async (event) => {
    event.preventDefault();
    const id = latest.person.id;
    try {
      const done = await post('flag', { id, why: document.getElementById('flagwhy').value });
      document.getElementById('flagwhy').value = '';
      await settled(done.under ? `Flagged. ${done.under} down their chain marked to check.` : 'Flagged.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
  once(unflag, 'click', async () => {
    unflag.disabled = true;
    try {
      await post('unflag', { id: latest.person.id });
      await settled('Flag removed.');
    } catch (error) {
      unflag.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
}

function node(row) {
  const item = el('li');
  const tone = row.flagged ? 'tnode flagged' : row.underFlag ? 'tnode tflag' : 'tnode';
  const open = link('', `/desk?id=${row.id}`, tone);
  open.append(el('b', shown(row)));
  open.append(el('small', [row.reference, row.brought ? `brought ${row.brought}` : null,
    row.unknown ? "don't know who brought them" : null].filter(Boolean).join(' · ')));
  open.append(el('span', row.status, `tag ${STATUS_TONE[row.status] || 't-demo'}`));
  if (row.isDemo) open.append(el('span', 'Demo', 'tag t-demo'));
  if (row.underFlag && !row.flagged) open.append(el('span', 'Brought by someone you flagged', 'why'));
  item.append(open);
  if (row.children.length) {
    const under = el('ul');
    for (const child of row.children) under.append(node(child));
    if (row.more) {
      const rest = el('li');
      rest.append(link(`and ${row.more} more`, `/desk?id=${row.id}`, 'tmore'));
      under.append(rest);
    }
    item.append(under);
  }
  return item;
}

export async function renderWhoBrought() {
  const tiles = document.getElementById('whotiles');
  const tree = document.getElementById('whotree');
  const asked = new URLSearchParams(location.search).get('wpage') || '1';
  try {
    const data = await get(`referrals&page=${encodeURIComponent(asked)}`);
    document.getElementById('whocount').textContent = `${data.chains} ${data.chains === 1 ? 'chain' : 'chains'}`;
    tiles.textContent = '';
    for (const [n, words, bad] of [[data.outreach, 'From your outreach'], [data.brought, 'Brought by someone'],
      [data.flagged, 'Flagged', true]]) {
      const tile = el('div', null, 'stat');
      tile.append(el('b', n.toLocaleString(), bad && n ? 'bad' : null), el('span', words));
      tiles.append(tile);
    }
    tree.textContent = '';
    if (!data.tree.length) {
      tree.append(el('li', 'Nobody has brought anybody yet.', 'empty'));
    } else {
      const root = el('li');
      root.append(el('span', 'Your outreach', 'troot'));
      const under = el('ul');
      for (const row of data.tree) under.append(node(row));
      root.append(under);
      tree.append(root);
    }
    renderPages(document.getElementById('whopager'), data.page, data.last, (to) => {
      const url = new URL(location.href);
      url.searchParams.set('wpage', String(to));
      location.href = url.pathname + url.search + '#whobrought';
    });
  } catch (error) {
    msg('qmsg', error.message, 'bad');
  }
}
