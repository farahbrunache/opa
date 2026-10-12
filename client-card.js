import { call, showProblem } from '/problem.js';
import { day, dollars, el } from '/client-ui.js';
import { PREVIEW, readFrom } from '/client-source.js';

function money(amount) {
  return `$${dollars(amount)}`;
}

function holes(held) {
  const row = el('div', null, 'choles');
  const used = held.filter((h) => h.usedAt).length;
  row.setAttribute('aria-label', `${used} of ${held.length} used`);
  for (const session of held) row.append(el('span', session.usedAt ? '✓' : '', session.usedAt ? 'chole used' : 'chole'));
  return row;
}

function card(data) {
  const box = el('div', null, 'ccard');
  const head = el('div', null, 'chead');
  const used = data.held.filter((h) => h.usedAt);
  head.append(el('b', 'Your card', 'ccardname'), el('small', `${used.length} of ${data.held.length} used`));
  box.append(head, holes(data.held));
  if (used.length) {
    box.append(el('p', `Used for: ${used.map((h) => `${h.usedFor || 'a session'} (${day(h.usedAt)})`).join(', ')}.`, 'cfine'));
  }
  return box;
}

function rate(name, price, lines, button) {
  const box = el('div', null, 'crate');
  const head = el('div', null, 'chead');
  head.append(el('b', name), el('b', money(price), 'cprice'));
  box.append(head);
  for (const line of lines) box.append(el('small', line));
  if (button) box.append(button);
  return box;
}

function go(label, href, ghost) {
  const a = el('a', label, ghost ? 'cbtn ghost' : 'cbtn');
  a.href = href;
  return a;
}

export async function loadCard() {
  const panel = document.getElementById('c-sessions');
  const where = document.getElementById('sessioncard');
  const rates = document.getElementById('rates');
  const said = document.getElementById('sessionmsg');
  const fine = document.getElementById('sessionsfine');
  panel.hidden = false;
  where.textContent = '';
  rates.textContent = '';
  said.hidden = true;
  let data;
  try {
    data = await call(readFrom('sessions'), {}, 'Loading your sessions');
  } catch (error) {
    showProblem(said, error, 'Loading your sessions');
    return;
  }
  const left = data.held.filter((h) => !h.usedAt).length;
  document.getElementById('sessionsleft').textContent = data.held.length ? `${left} of ${data.held.length} left` : '';
  if (data.held.length) where.append(card(data));
  else where.append(el('p', 'No sessions on your card yet.', 'ctext'));
  for (const pending of data.pending) {
    where.append(el('p', `${pending.rateLabel} session · ${money(pending.amount)} · reference ${pending.reference} · paid, being confirmed.`, 'cfine'));
  }
  document.getElementById('anotherhead').hidden = !data.rates;
  fine.textContent = '';
  if (!data.rates) return;

  const access = data.access;
  const lines = [`A limited number each month. ${access.left} left in ${access.monthName}.`,
    `Request one. If none are left, join the ${access.nextMonthName} list or buy at the standard rate.`];
  let accessButton;
  if (data.request && data.request.toPay) {
    lines.push(`Yours for ${data.request.monthName}. Pay for it to put it on your card.`);
    accessButton = go('Pay for it', '/buy?session=access');
  } else if (data.request && !data.request.granted) {
    lines.push(`You're on the ${data.request.monthName} list, from ${day(data.request.requestedAt)}. It's given in the order requests came in.`);
    accessButton = null;
  } else if (data.request) {
    lines.push('Your last one is paid and on your card.');
    accessButton = requestButton(said);
  } else {
    accessButton = requestButton(said);
  }
  rates.append(rate('Access rate', data.rates.access, lines, accessButton));
  rates.append(rate('Standard rate', data.rates.standard, ['Any time.'], go('Buy a session', '/buy?session=standard', true)));
  fine.textContent = 'Same session at either rate. The rate changes the price, not the help. Nobody is asked why.';
}

function requestButton(said) {
  const button = el('button', 'Request one', 'cbtn');
  button.type = 'button';
  if (PREVIEW) return button;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await call('/api/client?action=access-request', { method: 'POST' }, 'Requesting a session');
      await loadCard();
    } catch (error) {
      button.disabled = false;
      showProblem(said, error, 'Requesting a session');
    }
  });
  return button;
}
