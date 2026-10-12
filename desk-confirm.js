import { el, link, call, money, stamp, demoChip } from '/desk-ui.js';

const REASONS = {
  wise: [['not_received', 'Not received'], ['short', 'Short'], ['duplicate', 'Duplicate']],
  amazon: [['empty', 'Empty'], ['used', 'Already used'], ['invalid', 'Invalid'], ['duplicate', 'Duplicate']],
};

const REDEEM_AT = 'https://www.amazon.com/gc/redeem';

const done = new Map();

export function waitingNow(data) {
  return (data.toConfirm || []).filter((order) => !done.has(order.id));
}

function hoursWord(n) {
  return `${n} ${n === 1 ? 'hr' : 'hrs'}`;
}

export function took(seconds) {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')} m` : `${m} m`;
}

function waitWords(hours) {
  if (hours < 1) return 'Waiting under an hour';
  if (hours < 48) return `Waiting ${hoursWord(Math.floor(hours))}`;
  return `Waiting ${Math.floor(hours / 24)} days`;
}

function copyButton(text) {
  const b = el('button', 'Copy', 'iconbtn');
  b.type = 'button';
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select it and copy';
    }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  return b;
}

function targetBar(order, target) {
  const over = order.hoursWaiting > target;
  const box = el('div', null, 'tgt');
  const bar = el('div', null, over ? 'tgtbar over' : 'tgtbar');
  const fill = el('i');
  fill.style.width = `${Math.min(100, (order.hoursWaiting / (target * 2)) * 100)}%`;
  bar.append(fill);
  const under = el('small');
  const gap = Math.floor(Math.abs(target - order.hoursWaiting));
  under.append(el('span', `Paid ${stamp(order.paidAt)}`),
    el('span', over ? `${hoursWord(gap)} past your ${target}` : `${hoursWord(gap)} left of your ${target}`,
      over ? 'bad' : null));
  box.append(bar, under);
  return box;
}

function nameOf(order) {
  return order.name || 'Returning client';
}

function finished(order, verdict, target) {
  const item = el('li');
  const card = el('div', null, 'card');
  const seconds = Math.max(0, (new Date(verdict.decidedAt) - new Date(verdict.paidAt)) / 1000);
  const over = seconds > target * 3600;
  const line = el('p', null, 'donepay');
  const whose = order.linked ? `${nameOf(order)} · Order ${order.reference}` : `Order ${order.reference}`;
  line.append(el('b', `${whose} ${verdict.status === 'confirmed' ? 'matched' : 'rejected'}`),
    ` in ${took(seconds)} · `, el('span', over ? `past your ${target}` : `within your ${target}`, over ? 'bad' : null),
    '.');
  card.append(line);
  if (verdict.status === 'confirmed') card.append(link('Open →', `/desk?id=${order.id}`, 'olink'));
  item.append(card);
  return item;
}

async function decide(order, body) {
  return call('/api/payments?action=decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: order.id, ...body }),
  });
}

function renderCard(order, target, redraw) {
  if (done.has(order.id)) return finished(order, done.get(order.id), target);
  const over = order.hoursWaiting > target;
  const item = el('li');
  const card = el('div', null, over ? 'card late' : 'card');

  const head = el('div', null, 'chead');
  const who = el('span', null, 'who');
  if (order.linked) who.append(el('span', nameOf(order), 'name'), el('span', `Order ${order.reference}`, 'code'));
  else who.append(el('span', `Order ${order.reference}`, 'name'), el('span', 'No name · nothing saved about them', 'code'));
  if (order.isDemo || order.repeat) {
    const chips = el('span', null, 'chips');
    if (order.repeat) chips.append(el('div', order.repeat, 'badge open'));
    demoChip(order, chips);
    who.append(chips);
  }
  head.append(who, el('span', waitWords(order.hoursWaiting), over ? 'wait over' : 'wait'));

  const todo = el('ul', null, 'todo');
  const what = el('li');
  const what_ = order.kind === 'session' ? `${order.rateLabel} session · ` : '';
  const check = order.method === 'amazon'
    ? `${what_}${order.label} · ${money(order.amount)}. Redeem the code; it's destroyed once checked.`
    : `${what_}${order.label} · ${money(order.amount)}. Look in Wise for ${money(order.amount)} with this reference in the note.`;
  what.append(el('span', 'Confirm pay', 'tag t-pay'), el('span', check));
  todo.append(what);

  const shown = order.method === 'amazon' && order.code ? order.code : order.reference;
  const code = el('div', null, 'paycode');
  code.append(el('b', shown), copyButton(shown));

  const said = el('span', null, 'bad');
  const acts = el('div', null, 'pair');
  const matched = el('button', order.kind === 'session' ? 'Matched, onto their card' : 'Matched, open the session', 'btn go');
  matched.type = 'button';
  const reject = el('button', 'Reject', 'btn ghost');
  reject.type = 'button';
  acts.append(matched, reject);
  if (order.method === 'amazon') {
    const redeem = link('Redeem on Amazon ↗', REDEEM_AT, 'btn ghost');
    redeem.target = '_blank';
    redeem.rel = 'noopener noreferrer';
    acts.append(redeem);
  }

  const why = el('div', null, 'rejwhy');
  why.hidden = true;
  const picks = el('div', null, 'st6');
  picks.setAttribute('role', 'group');
  picks.setAttribute('aria-label', 'Why');
  let reason = (REASONS[order.method] || REASONS.wise)[0][0];
  for (const [value, label] of REASONS[order.method] || REASONS.wise) {
    const b = el('button', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === reason));
    b.addEventListener('click', () => {
      reason = value;
      for (const other of picks.children) other.setAttribute('aria-pressed', String(other === b));
    });
    picks.append(b);
  }
  const sure = el('div', null, 'pair');
  const rejectNow = el('button', 'Reject with this reason', 'btn primary');
  rejectNow.type = 'button';
  const cancel = el('button', 'Cancel', 'btn ghost');
  cancel.type = 'button';
  sure.append(rejectNow, cancel);
  why.append(el('span', 'Why', 'label'), picks, sure);

  const press = async (button, body) => {
    button.disabled = true;
    said.textContent = '';
    try {
      done.set(order.id, await decide(order, body));
      redraw();
    } catch (error) {
      said.textContent = error.message;
      button.disabled = false;
    }
  };
  matched.addEventListener('click', () => press(matched, { decision: 'confirm' }));
  rejectNow.addEventListener('click', () => press(rejectNow, { decision: 'reject', reason }));
  reject.addEventListener('click', () => { acts.hidden = true; why.hidden = false; });
  cancel.addEventListener('click', () => { acts.hidden = false; why.hidden = true; });

  card.append(head, todo, code, targetBar(order, target), acts, why, said);
  item.append(card);
  return item;
}

export function renderToConfirm(data, shown, redraw) {
  const box = document.getElementById('confirmlist');
  box.textContent = '';
  box.hidden = !shown || !(data.toConfirm || []).length;
  if (box.hidden) return;
  for (const order of data.toConfirm) box.append(renderCard(order, data.confirmTargetHours, redraw));
}
