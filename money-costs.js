import { el, msg, call, money, offWhen } from '/desk-ui.js';

function post(action, body) {
  return call(`/api/costs?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function exact(value) {
  return `$${Number(value).toFixed(3)}`;
}

function signed(value, format = money) {
  return value >= 0 ? `+${format(value)}` : `−${format(-value)}`;
}

function ledgerLine(box, label, value, note) {
  const line = el('div');
  const name = el('span', label);
  if (note) name.append(el('span', ` · ${note}`, 'faint'));
  line.append(name, el('b', value));
  box.append(line);
}

function renderAnswer(data) {
  const v = data.verdict;
  const head = document.getElementById('verdict30');
  head.className = v.left >= 0 ? 'headline good' : 'headline behind';
  head.querySelector('b').textContent = signed(v.left);
  head.querySelector('span').textContent = `${v.left >= 0 ? 'ahead' : 'behind'} over ${v.days} days`;
  const ledger = document.getElementById('ledger');
  ledger.textContent = '';
  ledgerLine(ledger, 'Came in', money(v.tookIn));
  ledgerLine(ledger, 'Serving clients', `−${exact(v.servingClients)}`);
  ledgerLine(ledger, 'Running the project', `−${exact(v.runningTheProject)}`);
  const fromSessions = v.sessions * data.sessionPrice;
  document.getElementById('camefrom').textContent = `Came in: ${money(fromSessions)} from `
    + `${v.sessions} call${v.sessions === 1 ? '' : 's'}, ${money(v.tookIn - fromSessions)} from sessions bought.`;
}

function renderWeeks(data) {
  const weeks = data.weeks || [];
  const short = weeks.filter((week) => week.left < 0).length;
  const pattern = document.getElementById('pattern');
  pattern.textContent = !weeks.length ? '' : short === 0
    ? `Ahead all ${weeks.length} weeks` : `Short ${short} of ${weeks.length} weeks`;
  pattern.className = short ? 'count bad' : 'count ok';
  const rows = document.getElementById('weeks');
  rows.textContent = '';
  for (const week of weeks) {
    const row = el('tr');
    const ago = Math.round(week.endedDaysAgo / 7);
    const when = el('th', ago === 0 ? 'This week' : `${ago} wk ago`);
    when.scope = 'row';
    row.append(when, el('td', money(week.tookIn)), el('td', money(week.spent)),
      el('td', signed(week.left), week.left >= 0 ? 'ok' : 'bad'));
    rows.append(row);
  }
}

function renderGap(data) {
  const panel = document.getElementById('gappanel');
  const gap = document.getElementById('gap');
  gap.textContent = '';
  panel.hidden = !data.closes;
  if (!data.closes) return;
  const c = data.closes;
  const say = (what, how) => {
    const item = el('li', null, 'item');
    item.append(el('span', what, 'title'), el('span', how, 'muted'));
    gap.append(item);
  };
  if (c.sessions !== null) {
    say(`${c.sessions} more session${c.sessions === 1 ? '' : 's'}`,
      `At ${money(c.perSessionLeft)} left over each, across the same ${data.verdict.days} days`);
  }
  if (c.perMonth !== null) say(`${money(c.perMonth)} a month less going out`, 'Spending less');
}

function renderSeven(data) {
  const w = data.lastSeven;
  const said = document.getElementById('window');
  said.textContent = `${signed(w.left)} over ${w.days} days`;
  said.className = w.left >= 0 ? 'count ok' : 'count bad';
  const rows = document.getElementById('windowrows');
  rows.textContent = '';
  ledgerLine(rows, 'Came in', money(w.tookIn), `${w.sessions} call${w.sessions === 1 ? '' : 's'} and sessions bought`);
  ledgerLine(rows, 'Serving clients', exact(w.servingClients), w.billRead
    ? `${exact(w.clientCalls)} of calls`
    : `${exact(w.clientCalls)} of calls, ${exact(w.clientDrafts)} of drafting over ${w.clientSeconds}s`);
  ledgerLine(rows, 'Running the project', exact(w.runningTheProject),
    `${exact(w.projectCalls)} of calls, ${exact(w.drafting)} of drafting`
    + (w.billRead ? ' off the bill' : ` from ${w.projectSeconds}s at the rate`)
    + `, ${w.fixedShare === null ? 'no monthly bills listed' : `${exact(w.fixedShare)} of monthly bills`}`);
  if (w.demoSessions) ledgerLine(rows, 'Demo sessions', String(w.demoSessions), 'counted against the project');
}

function renderCharges(charges) {
  const box = document.getElementById('charges');
  box.textContent = '';
  document.getElementById('chargetotal').textContent = `Total ${exact(charges.total)}`;
  if (!charges.items.length) {
    box.append(el('li', 'Nothing charged in the last 30 days.', 'empty'));
    return;
  }
  for (const item of charges.items) {
    const row = el('li', null, 'item');
    const whose = item.reference ? `${item.reference}${item.project ? ' · yours' : ''}` : 'the project';
    const when = item.at
      ? new Date(item.at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : 'every month';
    const head = el('div', null, 'line');
    head.append(el('span', item.what, 'title'), el('b', item.amount === null ? 'not counted' : exact(item.amount)));
    row.append(head, el('span', `${when} · ${whose}`, 'muted'), el('span', item.how, 'faint'));
    box.append(row);
  }
}

let editing = null;
function editLine(line) {
  editing = line.id;
  document.getElementById('linename').value = line.name;
  document.getElementById('lineamount').value = String(line.amount);
  document.getElementById('lineshare').value = String(line.sharePercent);
  document.getElementById('lineref').value = line.forReference || '';
  document.getElementById('lineevery').value = line.every;
  document.getElementById('lineformtitle').textContent = `Edit ${line.name}`;
  document.getElementById('linesave').textContent = 'Save changes';
  document.getElementById('linecancel').hidden = false;
  document.getElementById('linename').focus();
}

function renderLines(data) {
  document.getElementById('monthly').textContent =
    data.monthlyFixed === null ? 'Nothing listed' : `${money(data.monthlyFixed)} a month`;
  const lines = document.getElementById('lines');
  lines.textContent = '';
  if (!data.lines.length) lines.append(el('li', 'Nothing listed.', 'empty'));
  for (const line of data.lines) {
    const item = el('li', null, 'item');
    const head = el('div', null, 'line');
    head.append(el('span', line.name, 'title'), el('b', line.every === 'month'
      ? `${money(line.amount)} / month` : `$${line.amount} / second of drafting`));
    item.append(head);
    const foot = el('div', null, 'line');
    const whose = el('div', null, 'pair');
    whose.append(el('span', line.forReference ? `For ${line.forReference}` : 'The whole product', 'tag t-demo'));
    if (line.sharePercent !== 100) {
      whose.append(el('span', `${line.sharePercent}% · ${money(line.costs)} here`, 'tag t-demo'));
    }
    const actions = el('div', null, 'pair');
    const edit = el('button', 'Edit', 'btn ghost small');
    edit.type = 'button';
    edit.addEventListener('click', () => editLine(line));
    const drop = el('button', 'Remove', 'btn danger small');
    drop.type = 'button';
    drop.addEventListener('click', async () => {
      if (!window.confirm(`Remove ${line.name}?`)) return;
      drop.disabled = true;
      try {
        await post('line-remove', { id: line.id });
        window.location.reload();
      } catch (error) {
        drop.disabled = false;
        msg('msg', error.message, 'bad');
      }
    });
    actions.append(edit, drop);
    foot.append(whose, actions);
    item.append(foot);
    if (line.note) item.append(el('span', line.note, 'muted'));
    lines.append(item);
  }
  offWhen(document.getElementById('pullbill'), !data.billReader, 'Bill reader not set up');
  document.getElementById('billsays').textContent = data.lastSeven.billRead
    ? `${exact(data.lastSeven.drafting)} over the last ${data.lastSeven.days} days, off the bill.`
    : 'Not read yet. Priced at the per-second rate.';
}

function stat(box, label, value) {
  const tile = el('div', null, 'stat');
  tile.append(el('b', value), el('span', label));
  box.append(tile);
}

function renderSessions(data) {
  const said = document.getElementById('verdict');
  const why = document.getElementById('verdictwhy');
  if (!data.sessions) {
    said.textContent = 'Cost to serve: not enough data yet';
    why.textContent = 'Nothing sold yet.';
  } else {
    const left = data.sessionPrice - data.perSession;
    said.textContent = `Cost to serve: ${exact(data.perSession)}`;
    why.textContent = (left >= 0
      ? `${exact(left)} of the ${money(data.sessionPrice)} is left after serving them`
      : `${exact(-left)} more than the ${money(data.sessionPrice)}, before anything the project costs`)
      + `, across ${data.sessions} session${data.sessions === 1 ? '' : 's'}.`;
  }

  const figures = document.getElementById('figures');
  figures.textContent = '';
  stat(figures, `Sessions sold · ${money(data.sessionsIn)}`, String(data.sessions));
  stat(figures, `Sessions bought · ${money(data.boughtIn)}`, String(data.bought));
  stat(figures, 'Came in', money(data.tookIn));
  stat(figures, 'Went out, calls and drafting', exact(data.spent));
  if (data.monthlyFixed !== null) stat(figures, 'Servers a month, typed in', money(data.monthlyFixed));

  const orders = document.getElementById('orders');
  orders.textContent = '';
  if (!data.orders.length) orders.append(el('li', 'No sessions yet.', 'empty'));
  for (const order of data.orders) {
    const item = el('li', null, 'item');
    const head = el('div', null, 'line');
    const tags = el('div', null, 'pair');
    if (order.isDemo) tags.append(el('span', 'Demo', 'tag t-demo'));
    if (order.isMine) tags.append(el('span', 'Yours', 'tag t-demo'));
    if (!order.paid) tags.append(el('span', 'Not paid for', 'tag t-demo'));
    if (order.paid && !order.isDemo && !order.isMine) {
      tags.append(el('span', order.left >= 0 ? `${exact(order.left)} left` : `${exact(-order.left)} short`,
        order.left >= 0 ? 'tag t-ask' : 'tag t-owe'));
    }
    head.append(el('span', order.reference || `Order ${order.id}`, 'mono'), tags);
    const ledger = el('div', null, 'ledger small');
    for (const [label, value] of [['In', money(order.tookIn)], ['Call', exact(order.calls)],
      ['Drafting', exact(order.drafts)]]) {
      const cell = el('div');
      cell.append(el('span', label), el('b', value));
      ledger.append(cell);
    }
    item.append(head, ledger);
    if (order.isDemo || order.isMine) item.append(el('span', 'Not counted in the totals.', 'faint'));
    if (order.draftedSeconds) item.append(el('span', `Drafted for ${order.draftedSeconds}s`, 'faint'));
    if (order.unknown.length) item.append(el('span', `Not counted: ${order.unknown.join('; ')}`, 'faint'));
    orders.append(item);
  }

  const unknown = document.getElementById('unknown');
  unknown.textContent = '';
  if (!data.unknown.length) unknown.append(el('li', 'Nothing.', 'empty'));
  for (const line of data.unknown) unknown.append(el('li', line, 'item'));
}

export function renderCosts(data) {
  renderAnswer(data);
  renderWeeks(data);
  renderGap(data);
  renderSeven(data);
  renderCharges(data.charges);
  renderLines(data);
  renderSessions(data);
}

const pull = document.getElementById('pullbill');
pull.addEventListener('click', async () => {
  const said = pull.textContent;
  pull.disabled = true;
  pull.textContent = 'Reading the bill';
  try {
    await post('pull-bill', {});
    window.location.reload();
  } catch (error) {
    pull.disabled = false;
    pull.textContent = said;
    msg('msg', error.message, 'bad');
  }
});

document.getElementById('linecancel').addEventListener('click', () => {
  editing = null;
  document.getElementById('addline').reset();
  document.getElementById('lineformtitle').textContent = 'Add a cost';
  document.getElementById('linesave').textContent = 'Add it';
  document.getElementById('linecancel').hidden = true;
});

document.getElementById('addline').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('linesave');
  button.disabled = true;
  try {
    await post(editing ? 'line-edit' : 'line-add', {
      id: editing,
      name: document.getElementById('linename').value,
      amount: document.getElementById('lineamount').value,
      share: document.getElementById('lineshare').value,
      reference: document.getElementById('lineref').value,
      every: document.getElementById('lineevery').value,
    });
    window.location.reload();
  } catch (error) {
    msg('msg', error.message, 'bad');
    button.disabled = false;
  }
});
