import { el } from '/desk-ui.js';
import { exact } from '/money-costs.js';

const GROUPS_A_PAGE = 30;
const KIND_WORDS = { call: 'call', drafting: 'drafting', month: 'monthly bill' };

let charges = { items: [] };
let kind = 'all';
let query = '';
let each = false;
let page = 1;

const dayOf = (at) => new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const whoseOf = (item) => (item.reference ? `${item.reference}${item.project ? ' · yours' : ''}` : 'the project');
const isZero = (item) => item.amount !== null && Math.round(item.amount * 1000) === 0;
const totalOf = (items) => items.reduce((sum, item) => sum + (item.amount ?? 0), 0);

function row(item) {
  const line = el('li', null, 'item');
  const head = el('div', null, 'line');
  head.append(el('span', item.what, 'title'), el('b', item.amount === null ? 'not counted' : exact(item.amount)));
  line.append(head, el('span', `${item.at ? dayOf(item.at) : 'every month'} · ${whoseOf(item)}`, 'muted'),
    el('span', item.how, 'faint'));
  return line;
}

function duration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes ? `${minutes} min ${rest} s` : `${rest} s`;
}

function folded(items, days) {
  const line = el('li', null, 'item fold');
  const seconds = items.reduce((sum, item) => sum + (item.seconds || 0), 0);
  const said = [`${items.length} at $0.000`, [...new Set(items.map((item) => KIND_WORDS[item.kind]))].join(', ')];
  if (seconds) said.push(`${duration(seconds)} in all`);
  if (days > 1) said.push(`${days} days with nothing to pay`);
  line.append(el('span', said.join(' · '), 'title'),
    el('span', [...new Set(items.map(whoseOf))].join(' · '), 'muted'));
  return line;
}

function matches(item) {
  if (kind === 'yours' && !(item.project && item.reference)) return false;
  if (kind !== 'all' && kind !== 'yours' && item.kind !== kind) return false;
  if (!query) return true;
  return [item.reference, whoseOf(item), item.at ? dayOf(item.at) : 'every month', item.what, KIND_WORDS[item.kind]]
    .join(' ').toLowerCase().includes(query);
}

function groupsOf(items) {
  const days = [];
  for (const item of items.filter((i) => i.at)) {
    const day = dayOf(item.at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }
  const groups = [];
  for (const { day, items: lines } of days) {
    const quiet = !each && lines.every(isZero);
    const last = groups[groups.length - 1];
    if (quiet && last?.quiet) {
      last.to = day;
      last.items.push(...lines);
      last.days += 1;
    } else {
      groups.push({ from: day, to: day, items: [...lines], quiet, days: 1 });
    }
  }
  const monthly = items.filter((i) => !i.at);
  if (monthly.length) groups.push({ from: 'Every month', to: 'Every month', items: monthly, quiet: false, days: 0 });
  return groups;
}

function group(box, g) {
  const head = el('div', null, 'cday');
  head.append(el('span', g.from === g.to ? g.from : `${g.from} – ${g.to}`), el('b', exact(totalOf(g.items))));
  const list = el('ul', null, 'list');
  const zero = each || !g.days ? [] : g.items.filter(isZero);
  for (const item of g.items) if (!zero.includes(item)) list.append(row(item));
  if (zero.length) list.append(folded(zero, g.days));
  box.append(head, list);
}

function render() {
  const box = document.getElementById('charges');
  const counter = document.getElementById('chargecount');
  const pager = document.getElementById('chargepager');
  box.textContent = '';
  for (const chip of document.querySelectorAll('#chargekinds .fchip')) {
    const on = chip.dataset.kind === kind;
    chip.setAttribute('aria-pressed', String(on));
    chip.classList.toggle('choice', on);
  }
  const shown = charges.items.filter(matches);
  if (!charges.items.length) {
    box.append(el('p', 'Nothing charged in the last 30 days.', 'empty'));
    counter.textContent = '';
    pager.hidden = true;
    return;
  }
  if (!shown.length) {
    box.append(el('p', 'Nothing matches.', 'empty'));
    counter.textContent = `0 of ${charges.items.length} lines`;
    pager.hidden = true;
    return;
  }
  const groups = groupsOf(shown);
  const pages = Math.ceil(groups.length / GROUPS_A_PAGE);
  page = Math.min(page, pages);
  for (const g of groups.slice((page - 1) * GROUPS_A_PAGE, page * GROUPS_A_PAGE)) group(box, g);
  counter.textContent = shown.length === charges.items.length
    ? `${shown.length} lines, newest first` : `${shown.length} of ${charges.items.length} lines`;
  pager.hidden = pages <= 1;
  document.getElementById('chargeprev').disabled = page <= 1;
  document.getElementById('chargenext').disabled = page >= pages;
}

export function renderCharges(data) {
  charges = data;
  document.getElementById('chargetotal').textContent = `Total ${exact(data.total)}`;
  render();
}

function again() {
  page = 1;
  render();
}

document.getElementById('chargeq').addEventListener('input', (event) => {
  query = event.target.value.trim().toLowerCase();
  again();
});
document.getElementById('chargekinds').addEventListener('click', (event) => {
  const chip = event.target.closest('.fchip');
  if (!chip || chip.dataset.kind === kind) return;
  kind = chip.dataset.kind;
  again();
});
document.getElementById('chargeeach').addEventListener('change', (event) => {
  each = event.target.checked;
  again();
});
document.getElementById('chargeprev').addEventListener('click', () => {
  page -= 1;
  render();
});
document.getElementById('chargenext').addEventListener('click', () => {
  page += 1;
  render();
});
