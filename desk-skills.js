import { el, get, msg, post } from '/desk-ui.js';
import { once, settled } from '/desk-after.js';

const MAX = 10;

const SHOWN = 24;

let list = null;
const view = { search: '', sector: '' };

export function forgetSkillList() {
  list = null;
}

function loadList() {
  if (!list) {
    list = get('skills-list').then((data) => data.skills);
    list.catch(() => { list = null; });
  }
  return list;
}

function byName(skills) {
  const entries = new Map();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!entries.has(key)) entries.set(key, { key, name: skill.name, ids: [], tradeIds: new Set(), sectors: new Set() });
    const entry = entries.get(key);
    entry.ids.push(skill.id);
    entry.tradeIds.add(skill.tradeId);
    entry.sectors.add(skill.sector);
  }
  return [...entries.values()];
}

async function save(person, ids, said) {
  try {
    const out = await post('skills', { id: person.id, skills: ids });
    await settled(out.trade ? `${said} Job title: ${out.trade.title}.` : said);
  } catch (error) {
    msg('rmsg', error.message, 'bad');
  }
}

function chip(text, on, onTap) {
  const button = el('button', text, on ? 'chip skill on' : 'chip skill');
  button.type = 'button';
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  once(button, 'click', () => {
    button.disabled = true;
    onTap().finally(() => { button.disabled = false; });
  });
  return button;
}

function option(text, value, selected = false) {
  const item = el('option', text);
  item.value = value;
  item.selected = selected;
  return item;
}

function field(labelText, control) {
  const wrap = el('div', null, 'field');
  const label = el('label', labelText);
  label.htmlFor = control.id;
  wrap.append(label, control);
  return wrap;
}

export function renderSkills(person, box, copyList) {
  const picked = person.skills || [];
  const pickedNames = new Set(picked.map((s) => s.name.toLowerCase()));

  const toggle = (entry) => {
    if (pickedNames.has(entry.key)) {
      const left = picked.filter((s) => s.name.toLowerCase() !== entry.key).map((s) => s.id);
      return save(person, left, `Removed ${entry.name}.`);
    }
    if (picked.length >= MAX) {
      msg('rmsg', `${MAX} skills at most. Remove one before adding another.`, 'bad');
      return Promise.resolve();
    }
    return save(person, [...picked.map((s) => s.id), entry.ids[0]], `Added ${entry.name}.`);
  };
  const entryChip = (entry) => chip(entry.name, pickedNames.has(entry.key), () => toggle(entry));

  const mine = el('div', null, 'chips');
  if (!picked.length) mine.append(el('p', 'No skills yet.', 'faint'));
  for (const skill of picked) {
    const entry = { key: skill.name.toLowerCase(), name: skill.name, ids: [skill.id] };
    mine.append(chip(`${skill.name} ×`, true, () => toggle(entry)));
  }
  box.append(mine);
  box.append(el('p', `${picked.length} of ${MAX}`, 'faint'));

  box.append(el('p', person.trade
    ? `Job title: ${person.trade.title} · ${person.trade.sector}`
    : 'No job title yet.', 'status-line'));
  const others = (person.roles || []).filter((r) => !person.trade || r.id !== person.trade.id);
  if (others.length) {
    box.append(el('h3', 'Also under', 'groupname'));
    const row = el('div', null, 'chips');
    for (const role of others) {
      row.append(chip(role.title, false, async () => {
        try {
          const out = await post('trade', { id: person.id, trade: role.id });
          await settled(`Job title set: ${out.title}.`);
        } catch (error) {
          msg('rmsg', error.message, 'bad');
        }
      }));
    }
    box.append(row);
  }

  const pickers = el('div');
  box.append(pickers);
  loadList().then((skills) => {
    if (!skills.length) {
      pickers.append(copyList('No skills copied yet.'));
      return;
    }
    const entries = byName(skills);

    const whole = el('select');
    whole.id = 'skillsfortitle';
    whole.append(option('Pick a job title', ''));
    let group = null;
    for (const trade of person.trades) {
      if (!group || group.label !== trade.sector) {
        group = document.createElement('optgroup');
        group.label = trade.sector;
        whole.append(group);
      }
      group.append(option(trade.title, trade.id));
    }
    once(whole, 'change', () => {
      const title = person.trades.find((t) => t.id === whole.value);
      if (!title) return;
      const ids = picked.map((s) => s.id);
      const names = new Set(pickedNames);
      for (const entry of entries.filter((e) => e.tradeIds.has(title.id))) {
        if (ids.length >= MAX) break;
        if (names.has(entry.key)) continue;
        ids.push(entry.ids[0]);
        names.add(entry.key);
      }
      whole.disabled = true;
      save(person, ids, `Added the skills ${title.title} lists.`).finally(() => { whole.disabled = false; });
    });
    pickers.append(field("Add a job title's skills", whole));

    const search = el('input');
    search.id = 'skillsearch';
    search.type = 'search';
    search.autocomplete = 'off';
    search.value = view.search;
    const found = el('div', null, 'chips');
    const showFound = () => {
      found.textContent = '';
      const words = view.search.trim().toLowerCase();
      if (!words) return;
      const hits = entries.filter((e) => e.key.includes(words));
      for (const entry of hits.slice(0, SHOWN)) found.append(entryChip(entry));
      if (!hits.length) found.append(el('p', 'No skill by that name.', 'faint'));
      if (hits.length > SHOWN) found.append(el('p', `${SHOWN} of ${hits.length}`, 'faint'));
    };
    search.addEventListener('input', () => { view.search = search.value; showFound(); });
    pickers.append(field('Search skills', search), found);
    showFound();

    const sector = el('select');
    sector.id = 'skillsector';
    sector.append(option('Pick a sector', ''));
    for (const name of [...new Set(skills.map((s) => s.sector))]) {
      sector.append(option(name, name, name === view.sector));
    }
    const inSector = el('div', null, 'chips');
    const showSector = () => {
      inSector.textContent = '';
      for (const entry of entries.filter((e) => e.sectors.has(view.sector))) inSector.append(entryChip(entry));
    };
    sector.addEventListener('change', () => { view.sector = sector.value; showSector(); });
    pickers.append(field('Browse a sector', sector), inSector);
    showSector();
  }).catch((error) => {
    pickers.append(el('p', error.message, 'nothing'));
  });
}
