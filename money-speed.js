import { el, demoChip } from '/desk-ui.js';
import { took } from '/desk-confirm.js';

function tile(value, label, tone) {
  const box = el('div', null, 'stat');
  box.append(el('b', value, tone), el('span', label));
  return box;
}

function bar(row, target) {
  const item = el('li');
  const ref = el('span', null, 'sref');
  ref.append(el('span', row.reference));
  demoChip(row, ref);
  const over = row.seconds > target * 3600;
  const tone = row.waiting ? 'open' : over ? 'over' : null;
  const track = el('span', null, tone ? `sbarw ${tone}` : 'sbarw');
  const fill = el('i');
  fill.style.width = `${Math.min(100, (row.seconds / (target * 7200)) * 100)}%`;
  track.append(fill);
  const time = row.waiting ? `${Math.floor(row.seconds / 3600)} h…` : took(row.seconds);
  item.append(ref, track, el('b', time, tone));
  return item;
}

function week(w) {
  const tr = el('tr');
  const when = el('th', w.ago === 0 ? 'This week' : `${w.ago} wk ago`);
  when.scope = 'row';
  tr.append(when, el('td', String(w.decided)), el('td', took(w.median)),
    el('td', String(w.past), w.past ? 'bad' : null));
  return tr;
}

export function renderSpeed(speed) {
  const target = speed.targetHours;
  for (const said of document.querySelectorAll('.speedtarget')) said.textContent = `Your target: ${target} hrs`;
  document.getElementById('speedmid').textContent = `${target} hrs`;
  document.getElementById('speedend').textContent = String(target * 2);
  document.getElementById('speedpast').textContent = `Past ${target} hrs`;

  const tiles = document.getElementById('speedtiles');
  tiles.textContent = '';
  const none = !speed.decided;
  tiles.append(
    tile(none ? '—' : took(speed.median), 'Typical (median)'),
    tile(none ? '—' : `${speed.within} of ${speed.decided}`, `Within ${target} hrs`),
    tile(none ? '—' : took(speed.slowest), 'Slowest', !none && speed.slowest > target * 3600 ? 'bad' : null),
  );

  const rows = document.getElementById('speedrows');
  rows.textContent = '';
  for (const row of speed.rows) rows.append(bar(row, target));
  document.getElementById('speedbox').hidden = !speed.rows.length;

  const weeks = document.getElementById('speedweeks');
  weeks.textContent = '';
  for (const w of speed.weeks) weeks.append(week(w));
  document.getElementById('speedweekswrap').hidden = !speed.weeks.length;
}
