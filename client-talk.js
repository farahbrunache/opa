import { call, showProblem } from '/problem.js';
import { FARAH, day, dayTime, el } from '/client-ui.js';
import { readFrom } from '/client-source.js';

export function openConversation() {
  const talk = document.getElementById('c-talk');
  if (!talk.hidden) return;
  talk.hidden = false;
  document.querySelectorAll('[data-talk]').forEach((node) => { node.hidden = false; });
  loadThread(new URLSearchParams(window.location.search).get('page'));
}

function renderPager(data) {
  const box = document.getElementById('threadpager');
  box.textContent = '';
  const last = Math.max(1, Math.ceil(data.total / data.perPage));
  box.hidden = data.total <= data.perPage;
  if (box.hidden) return;
  const first = (data.page - 1) * data.perPage + 1;
  const upTo = Math.min(data.page * data.perPage, data.total);
  const older = el('button', 'Older', 'cbtn ghost');
  older.type = 'button';
  older.disabled = data.page <= 1;
  older.addEventListener('click', () => goToPage(data.page - 1));
  const newer = el('button', 'Newer', 'cbtn ghost');
  newer.type = 'button';
  newer.disabled = data.page >= last;
  newer.addEventListener('click', () => goToPage(data.page + 1));
  box.append(older, el('span', `${first}–${upTo} of ${data.total}`, 'cfine'), newer);
}

function goToPage(page) {
  const url = new URL(window.location.href);
  url.searchParams.set('page', String(page));
  window.history.pushState({}, '', url);
  loadThread(String(page));
}

function directionLine(direction) {
  return el('div', `New direction from ${day(direction.at)}: ${direction.name}`, 'cnote');
}

function renderThread(data) {
  const { messages } = data;
  const directions = data.directions || [];
  const last = data.page >= Math.ceil((data.total || 0) / (data.perPage || 1));
  const list = document.getElementById('thread');
  list.textContent = '';
  document.getElementById('sendform').hidden = Boolean(data.readOnly);
  document.getElementById('talksignin').hidden = !data.readOnly;
  if (!messages.length) {
    list.append(el('p', data.readOnly ? 'Nothing from Farah yet.' : 'Nothing said yet. You can go first.', 'cnote'));
    return;
  }
  const first = new Date(messages[0].at);
  let shown = 0;
  for (const message of messages) {
    while (shown < directions.length && new Date(directions[shown].at) <= new Date(message.at)) {
      if (new Date(directions[shown].at) >= first) list.append(directionLine(directions[shown]));
      shown += 1;
    }
    if (message.author === 'auto') {
      list.append(el('div', `${message.body} · ${day(message.at)}`, 'cnote'));
      continue;
    }
    const mine = message.author === 'client';
    const line = el('div', null, mine ? 'cm you' : 'cm farah');
    if (!mine) line.append(el('span', message.author === 'opening' ? 'To start with' : FARAH, 'by'));
    line.append(el('p', message.body));
    line.append(el('time', dayTime(message.at)));
    list.append(line);
  }
  if (last) for (; shown < directions.length; shown += 1) list.append(directionLine(directions[shown]));
  list.scrollTop = list.scrollHeight;
}

async function loadThread(page) {
  try {
    const at = page ? `&page=${encodeURIComponent(page)}` : '';
    const data = await call(readFrom('thread', at), {}, 'Loading the conversation');
    renderThread(data);
    renderPager(data);
  } catch (error) {
    const list = document.getElementById('thread');
    list.textContent = '';
    const box = el('div', null, null);
    list.append(box);
    showProblem(box, error, 'Loading the conversation');
  }
}

document.getElementById('sendform').addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = document.getElementById('body');
  const box = document.getElementById('sendmsg');
  const send = event.submitter || document.getElementById('send');
  box.hidden = true;
  send.disabled = true;
  try {
    const data = await call('/api/client?action=send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: field.value }),
    }, 'Sending your message');
    field.value = '';
    const url = new URL(window.location.href);
    url.searchParams.delete('page');
    window.history.replaceState({}, '', url);
    renderThread(data);
    renderPager(data);
  } catch (error) {
    showProblem(box, error, 'Sending your message');
  } finally {
    send.disabled = false;
  }
});
