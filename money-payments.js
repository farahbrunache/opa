import { el, call, weekday, money } from '/desk-ui.js';
import { renderSpeed } from '/money-speed.js';

function renderCounts(map) {
  const counts = document.getElementById('counts');
  counts.textContent = '';
  for (const [label, count, tone] of [
    ['Confirmed', map.confirmed || 0, 'ok'],
    ['Declined', map.rejected || 0, null],
    ['Waiting', map.pending || 0, 'bad'],
  ]) {
    const tile = el('div', null, 'stat');
    tile.append(el('b', String(count), count ? tone : null), el('span', label));
    counts.append(tile);
  }
  const waiting = map.pending || 0;
  document.getElementById('waitingcount').textContent = `${waiting} waiting on you`;
  const onToday = document.getElementById('ontoday');
  onToday.textContent = `${waiting} waiting · confirm on Today →`;
  onToday.hidden = !waiting;
}

function statusOf(order) {
  if (order.status === 'confirmed') {
    return [order.decided ? `Confirmed ${weekday(order.decided)}` : 'Confirmed', 'Confirmed', 't-ask'];
  }
  if (order.status === 'rejected') {
    const why = order.rejectReason || 'no reason recorded';
    return [order.decided ? `Declined ${weekday(order.decided)} · ${why}` : `Declined · ${why}`, 'Declined', 't-owe'];
  }
  return ['Waiting on you', 'Waiting', 't-new'];
}

function sessionOf(order) {
  if (order.sessionStarts > 0) {
    const times = order.sessionStarts === 1 ? 'once' : `${order.sessionStarts} times`;
    return `Session started ${times}, first ${weekday(order.firstStarted)}`;
  }
  return order.status === 'confirmed' ? 'Session not started' : `Sent ${weekday(order.submitted)}`;
}

function renderHistoryRow(order) {
  const item = el('li', null, 'item');
  const [said, tag, tone] = statusOf(order);
  const head = el('div', null, 'line');
  head.append(el('span', `${money(order.amount)} · ${order.label}`, 'title'), el('span', tag, `tag ${tone}`));
  item.append(head);
  const codeLine = el('div', null, 'line');
  codeLine.append(el('span', order.reference, 'mono muted'), el('span', sessionOf(order), 'muted'));
  item.append(codeLine);
  item.append(el('span', said, 'faint'));
  if (order.isDemo || order.isMine) {
    const chips = el('div', null, 'pair');
    if (order.isDemo) chips.append(el('span', 'Demo', 'tag t-demo'));
    if (order.isMine) chips.append(el('span', 'Yours', 'tag t-demo'));
    item.append(chips);
  }

  const actions = el('div', null, 'pair');
  if (order.hasTranscript) {
    const open = el('a', 'Open on the Desk', 'btn ghost');
    open.href = `/desk?id=${order.id}`;
    actions.append(open);
  }
  if (order.status === 'confirmed' && !order.isDemo && !order.isMine) {
    const mine = el('button', 'This one is mine', 'btn ghost');
    mine.type = 'button';
    mine.addEventListener('click', async () => {
      if (!window.confirm(`Mark ${order.reference} as your own test? The ${money(order.amount)} `
        + "stops counting as revenue, and this can't be undone.")) return;
      mine.disabled = true;
      try {
        await call('/api/desk?action=mine', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: order.id }),
        });
        await loadHistory();
      } catch (error) {
        item.append(el('span', error.message, 'bad'));
        mine.disabled = false;
      }
    });
    actions.append(mine);
  }
  if (actions.childElementCount) item.append(actions);
  return item;
}

let hpage = 1;
let hquery = '';

async function loadHistory() {
  const history = document.getElementById('history');
  const pager = document.getElementById('pager');
  const counter = document.getElementById('hcount');
  const params = new URLSearchParams({ action: 'history', page: String(hpage) });
  if (hquery) params.set('q', hquery);
  try {
    const data = await call(`/api/payments?${params.toString()}`);
    history.textContent = '';
    const first = (data.page - 1) * data.perPage + 1;
    const last = Math.min(data.page * data.perPage, data.total);
    if (!data.total) {
      counter.textContent = data.searched
        ? `Nothing with the reference ${data.searched}.`
        : 'Nothing has come through yet.';
      pager.hidden = true;
      return;
    }
    counter.textContent = data.searched
      ? `${data.total} with the reference ${data.searched}`
      : `${first}–${last} of ${data.total}, newest first`;
    for (const order of data.orders) history.append(renderHistoryRow(order));
    pager.hidden = data.total <= data.perPage;
    document.getElementById('prev').disabled = data.page <= 1;
    document.getElementById('next').disabled = last >= data.total;
  } catch (error) {
    history.textContent = '';
    counter.textContent = error.message;
    pager.hidden = true;
  }
}

export async function loadPayments() {
  const data = await call('/api/payments?action=list');
  renderSpeed(data.speed);
  renderCounts(data.counts || {});
  await loadHistory();
}

document.getElementById('search').addEventListener('submit', (event) => {
  event.preventDefault();
  hquery = document.getElementById('q').value.trim();
  hpage = 1;
  loadHistory();
});
document.getElementById('clear').addEventListener('click', () => {
  document.getElementById('q').value = '';
  hquery = '';
  hpage = 1;
  loadHistory();
});
document.getElementById('prev').addEventListener('click', () => {
  if (hpage > 1) { hpage -= 1; loadHistory(); }
});
document.getElementById('next').addEventListener('click', () => {
  hpage += 1;
  loadHistory();
});
