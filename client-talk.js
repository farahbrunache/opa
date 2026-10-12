import { QUOTE_ACCEPT, QUOTE_TERMS } from '/quote-terms.js';
import { firstSentence } from '/sheet.js';
import { call, showProblem } from '/problem.js';
import { FARAH, day, dayTime, dollars, el } from '/client-ui.js';
import { readFrom } from '/client-source.js';

const ANSWERS = [
  ['agreed', 'Accept', 'cbtn', false],
  ['changes asked', 'Ask for a change', 'cbtn ghost', true],
  ['declined', 'Decline', 'cbtn text', true],
];

const PAST = {
  agreed: 'Accepted',
  paid: 'Paid',
  declined: 'You declined',
  'changes asked': 'You asked for a change',
  withdrawn: 'Withdrawn',
};

function price(amount, small) {
  const node = el('div', null, small ? 'oprice small' : 'oprice');
  node.append(el('span', '$'), dollars(amount));
  return node;
}

function what(scope) {
  const [first, rest] = firstSentence(scope);
  const body = el('div', null, 'obody');
  body.append(el('b', first.trim()));
  if (rest.trim()) body.append(el('p', rest.trim()));
  return body;
}

function pastOffer(quote) {
  const row = el('article', null, 'offer past');
  row.append(price(quote.amount, true));
  const body = what(quote.scope);
  body.querySelector('p')?.remove();
  body.append(el('small', `${PAST[quote.status] || quote.status} ${day(quote.answeredAt || quote.writtenAt)}`));
  if (quote.reason) body.append(el('small', quote.reason));
  if (quote.agreedTerms) body.append(el('small', `You agreed to: ${quote.agreedTerms}`));
  row.append(body);
  return row;
}

function openOffer(quote, reload) {
  const card = el('article', null, 'offer');
  card.append(price(quote.amount, false));
  const body = what(quote.scope);
  body.append(el('small', `Sent ${day(quote.writtenAt)}`));
  card.append(body);

  const tick = el('label', null, 'ctick');
  const box = document.createElement('input');
  box.type = 'checkbox';
  tick.append(box, el('span', QUOTE_ACCEPT));
  card.append(tick);

  const why = el('div', null, 'cfield');
  why.hidden = true;
  const label = el('label', "In a line, what's wrong with it?");
  const input = document.createElement('textarea');
  input.rows = 2;
  input.maxLength = 2000;
  label.htmlFor = input.id = `why-${quote.id}`;
  why.append(label, input);
  card.append(why);

  const said = el('div', null, 'msg');
  said.hidden = true;
  const actions = el('div', null, 'oacts');
  for (const [answer, wording, look, needsReason] of ANSWERS) {
    const button = el('button', wording, look);
    button.type = 'button';
    if (answer === 'agreed') {
      button.disabled = true;
      box.addEventListener('change', () => { button.disabled = !box.checked; });
    }
    button.addEventListener('click', async () => {
      if (needsReason && (why.hidden || !input.value.trim())) {
        why.hidden = false;
        input.focus();
        said.hidden = false;
        said.className = 'msg';
        said.textContent = "Say what's wrong with it, then press this again.";
        return;
      }
      button.disabled = true;
      try {
        await call('/api/client?action=quote-answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: quote.id, answer, reason: input.value, accepted: box.checked }),
        }, 'Answering the offer');
        reload();
      } catch (error) {
        button.disabled = false;
        showProblem(said, error, 'Answering the offer');
      }
    });
    actions.append(button);
  }
  card.append(actions);
  card.append(el('p', QUOTE_TERMS, 'cfine'));
  card.append(said);
  return card;
}

export async function loadOffers(approved, then) {
  const section = document.getElementById('c-offers');
  const list = document.getElementById('offerlist');
  const waiting = document.getElementById('offerwaiting');
  const reload = () => loadOffers(approved, then);
  try {
    const data = await call(readFrom('quotes'), {}, 'Loading your offers');
    if (approved || data.quotes.length) openConversation();
    then(data.quotes.length > 0);
    section.hidden = !data.quotes.length;
    list.textContent = '';
    const open = data.quotes.filter((q) => q.status === 'offered');
    waiting.textContent = open.length ? `${open.length} waiting on you` : '';
    for (const quote of open) list.append(openOffer(quote, reload));
    for (const quote of data.quotes.filter((q) => q.status !== 'offered')) list.append(pastOffer(quote));
  } catch (error) {
    if (approved) openConversation();
    then(true);
    section.hidden = false;
    list.textContent = '';
    const box = el('div', null, null);
    list.append(box);
    showProblem(box, error, 'Loading your offers');
  }
}

function openConversation() {
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
