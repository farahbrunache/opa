import { el, get, link, msg, post, weekday } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';

const STEPS = [['to approach', 'To approach'], ['reached out', 'Reached out'], ['talking', 'Talking']];
const ENDS = [['said no', 'Said no', 'no'], ['paying customer', 'Paying customer', 'paying']];
const NEXT = { 'to approach': ['reached out', 'Mark reached out'], 'reached out': ['talking', 'Mark talking'] };

const opened = { personId: null, ids: new Set() };
let shown = null;

function moveTo(person, contact, status, said) {
  return async () => {
    try {
      await post('contact-move', { id: person.id, contactId: contact.id, status });
      await settled(said,
        wasBefore('contact-move', { id: person.id, contactId: contact.id, status: contact.status }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  };
}

function track(person, contact) {
  const bar = el('div', null, 'track5');
  const at = STEPS.findIndex(([value]) => value === contact.status);
  const ended = ENDS.some(([value]) => value === contact.status);
  STEPS.forEach(([, label], i) => {
    bar.append(el('span', label, ended || i < at ? 'done' : i === at ? 'now' : null));
  });
  const ends = el('span', null, 'ends');
  for (const [value, label, key] of ENDS) {
    const button = el('button', label);
    button.type = 'button';
    button.dataset.e = key;
    button.setAttribute('aria-pressed', String(value === contact.status));
    if (value !== contact.status) once(button, 'click', moveTo(person, contact, value, `Now ${value}.`));
    ends.append(button);
  }
  bar.append(ends);
  return bar;
}

function directoryBox(person, contact, title, head) {
  const box = el('div', null, 'live');
  const label = el('span', null, 'label');
  label.append(el('span', 'From the Directory'), el('span', 'Read live', 'faint'));
  const facts = el('dl');
  box.append(label, facts);
  get(`directory-profile&id=${encodeURIComponent(person.id)}&contact=${contact.id}`).then(({ profile }) => {
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    if (name) title.textContent = name;
    if (profile.claimed === false) head.append(el('span', 'Unclaimed', 'badge-un'));
    const place = [profile.city, profile.state, profile.country].filter(Boolean).join(', ');
    for (const [term, value] of [['Job title', profile.jobTitle || profile.headline],
      ['Skills', (profile.skills || []).join(', ')], ['Location', place]]) {
      if (value) facts.append(el('dt', term), el('dd', value));
    }
    if (profile.profileUrl && /^https?:\/\//i.test(profile.profileUrl)) {
      const away = link('Profile ↗', profile.profileUrl, 'btn ghost small');
      away.rel = 'noopener noreferrer';
      away.target = '_blank';
      box.append(away);
    }
  }).catch((error) => {
    box.append(el('span', error.message, 'bad'));
  });
  return box;
}

function input(id, label) {
  const wrap = el('div', null, 'field');
  const name = el('label', label);
  name.htmlFor = id;
  const box = el('input');
  box.type = 'text';
  box.id = id;
  box.autocomplete = 'off';
  box.maxLength = 2000;
  wrap.append(name, box);
  return [wrap, box];
}

function outreachForm(person, contact) {
  const form = el('form', null, 'stack');
  form.noValidate = true;
  const [channelField, channel] = input(`reachchannel-${contact.id}`, 'Where (DM, phone, in person)');
  const [saidField, said] = input(`reachsaid-${contact.id}`, 'Said');
  const [backField, back] = input(`reachback-${contact.id}`, 'Came back');
  const pair = el('div', null, 'pair');
  const add = el('button', 'Add the row', 'btn small');
  add.type = 'submit';
  const cancel = el('button', 'Cancel', 'btn ghost small');
  cancel.type = 'button';
  once(cancel, 'click', () => {
    opened.ids.delete(contact.id);
    renderContacts(shown);
  });
  pair.append(add, cancel);
  form.append(channelField, saidField, backField, pair);
  once(form, 'submit', async (event) => {
    event.preventDefault();
    add.disabled = true;
    try {
      await post('contact-reach', {
        id: person.id, contactId: contact.id, channel: channel.value, said: said.value, back: back.value,
      });
      opened.ids.delete(contact.id);
      await settled('Outreach row added.');
    } catch (error) {
      add.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return form;
}

function card(person, contact) {
  const item = el('div', null, 'item');
  const head = el('div', null, 'line');
  const left = el('div', null, 'pair tight');
  const title = el('span', contact.name || 'From the Directory', 'title');
  left.append(title);
  head.append(left, el('span', contact.fromDirectory ? '' : 'Typed in', 'faint'));
  item.append(head);
  if (contact.fromDirectory) item.append(directoryBox(person, contact, title, left));
  const about = [contact.why, contact.where].filter(Boolean).join(' · ');
  if (about) item.append(el('span', about, 'muted'));
  item.append(track(person, contact));

  if (contact.reaches.length) {
    const rows = el('ul', null, 'outrows');
    for (const reach of contact.reaches) {
      const row = el('li');
      row.append(el('time', [weekday(reach.at), reach.channel].filter(Boolean).join(' · ')));
      if (reach.said) row.append(el('span', `Said: ${reach.said}`, 'said'));
      row.append(el('span', `Came back: ${reach.back || 'nothing yet.'}`, 'cameback'));
      rows.append(row);
    }
    item.append(rows);
  }

  const pair = el('div', null, 'pair');
  if (NEXT[contact.status]) {
    const [to, label] = NEXT[contact.status];
    const next = el('button', label, 'btn small');
    next.type = 'button';
    once(next, 'click', moveTo(person, contact, to, `Now ${to}.`));
    pair.append(next);
  }
  if (contact.status === 'said no') {
    const again = el('button', 'Approach again', 'btn small');
    again.type = 'button';
    once(again, 'click', moveTo(person, contact, 'to approach', 'Back on the list.'));
    pair.append(again);
  }
  if (!opened.ids.has(contact.id)) {
    const row = el('button', 'Add an outreach row', 'btn ghost small');
    row.type = 'button';
    once(row, 'click', () => {
      opened.ids.add(contact.id);
      renderContacts(shown);
    });
    pair.append(row);
  }
  item.append(pair);
  if (opened.ids.has(contact.id)) item.append(outreachForm(person, contact));
  return item;
}

function wireAdd() {
  once(document.getElementById('addcontact'), 'submit', async (event) => {
    event.preventDefault();
    const who = document.getElementById('contactwho');
    const value = who.value.trim();
    if (!value) return;
    const isLink = shown.directoryRead && /^https?:\/\//i.test(value);
    try {
      await post('contact-add', {
        id: shown.id,
        name: isLink ? '' : value,
        directory: isLink ? value : '',
        where: document.getElementById('contactwhere').value,
        why: document.getElementById('contactwhy').value,
      });
      for (const id of ['contactwho', 'contactwhere', 'contactwhy']) document.getElementById(id).value = '';
      await settled(`${isLink ? 'Directory profile' : value} added.`);
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}

export function renderContacts(person) {
  shown = person;
  if (opened.personId !== person.id) Object.assign(opened, { personId: person.id, ids: new Set() });
  const list = document.getElementById('contacts');
  list.textContent = '';
  wireAdd();
  document.getElementById('addcontact').hidden = !person.linkedCase;
  const who = document.getElementById('contactwholabel');
  who.textContent = person.directoryRead ? 'Directory link or a name' : 'Who';
  if (!person.directoryRead) who.append(' ', el('span', '· Directory not connected', 'faint'));
  const count = document.getElementById('contactcount');
  if (!person.linkedCase) {
    count.textContent = 'No account linked';
    return;
  }
  const contacts = person.contacts || [];
  const talking = contacts.filter((c) => c.status === 'talking').length;
  count.textContent = contacts.length
    ? [String(contacts.length), talking ? `${talking} talking` : null].filter(Boolean).join(' · ') : '';
  if (!contacts.length) list.append(el('p', 'Nobody to approach yet.', 'empty'));
  for (const contact of contacts) list.append(card(person, contact));
}
