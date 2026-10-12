import { el, msg, post, money, weekday } from '/desk-ui.js';
import { once, settled } from '/desk-after.js';

function holes(held) {
  const row = el('div', null, 'holes');
  const used = held.filter((h) => h.usedAt).length;
  row.setAttribute('aria-label', `${used} of ${held.length} used`);
  for (const session of held) {
    const hole = el('i', session.usedAt ? '✓' : '', session.usedAt ? 'used' : null);
    hole.title = `${session.rateLabel}${session.usedAt ? ` · used ${weekday(session.usedAt)}` : ''}`;
    row.append(hole);
  }
  return row;
}

function minutesOf(h, sessions) {
  return sessions.cap ? `${h.minutes} of ${sessions.cap} min` : `${h.minutes} min`;
}

const ENDED = { delivered: 'delivered', cap: 'time cap', closed: 'closed' };

function costOf(h, hourRates) {
  if (!hourRates) return null;
  const at = (rate) => (h.minutes / 60) * rate + h.ai;
  return { low: at(hourRates.low), high: at(hourRates.high) };
}

function useLine(h, sessions) {
  const li = el('li');
  const state = h.closedAt ? `${ENDED[h.closedWhy] || 'closed'} ${weekday(h.closedAt)}` : 'open';
  li.append(`${weekday(h.usedAt)} · `, el('b', h.usedFor || 'no activity named'),
    ` · ${h.rateLabel.toLowerCase()} · ${minutesOf(h, sessions)} · ${state}`);
  const cost = costOf(h, sessions.hourRates);
  if (cost && h.paid !== null) {
    const over = cost.high > h.paid;
    li.append(' · ', el('span', `cost ${money(cost.low)}–${money(cost.high)} of ${money(h.paid)}`, over ? 'bad' : null));
  }
  return li;
}

function card(person, sessions) {
  const box = el('div', null, 'punch');
  const used = sessions.held.filter((h) => h.usedAt);
  const who = person.name ? `${person.name.split(/\s+/)[0]}'s card` : 'Their card';
  const head = el('div', null, 'line');
  head.append(el('b', `${who} · ${sessions.held.length} session${sessions.held.length === 1 ? '' : 's'}`),
    el('span', `${used.length} used`, 'faint'));
  box.append(head, holes(sessions.held));
  if (used.length) {
    const list = el('ul', null, 'uses');
    for (const h of used) list.append(useLine(h, sessions));
    box.append(list);
  }
  return box;
}

function closeButton(person, label, why) {
  const button = el('button', label, 'btn small');
  button.type = 'button';
  once(button, 'click', async () => {
    button.disabled = true;
    try {
      await post('session-close', { id: person.id, why });
      await settled(`Session closed · ${label.toLowerCase()}.`);
    } catch (error) {
      button.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return button;
}

function useRow(person, sessions) {
  const row = document.getElementById('sessionuse');
  row.textContent = '';
  if (sessions.held.some((h) => h.usedAt && !h.closedAt)) {
    row.append(closeButton(person, 'Delivered', 'delivered'), closeButton(person, 'Close', 'closed'));
    return;
  }
  const left = sessions.held.filter((h) => !h.usedAt).length;
  const open = (person.activities || []).filter((a) => a.state === 'todo');
  if (!left || !open.length) return;
  const pick = el('select');
  pick.setAttribute('aria-label', 'For which activity');
  for (const a of open) {
    const option = el('option', `For ${a.title}`);
    option.value = String(a.id);
    pick.append(option);
  }
  const use = el('button', 'Open a session', 'btn small');
  use.type = 'button';
  once(use, 'click', async () => {
    use.disabled = true;
    try {
      const out = await post('session-use', { id: person.id, activityId: Number(pick.value) });
      await settled(`Session open for ${out.activity}.`);
    } catch (error) {
      use.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  row.append(use, pick);
}

function accessLines(person, sessions) {
  const box = document.getElementById('accessbox');
  const access = sessions.access;
  box.hidden = !access;
  if (!access) return;
  document.getElementById('accesshead').textContent = `Access-rate sessions · ${access.monthName}`;
  document.getElementById('accessgiven').textContent = `${access.given} of ${access.cap} given`;
  document.getElementById('accessleft').textContent =
    `${access.left} left · ${access.waiting} on ${access.nextMonthName}'s list`;
  const mine = document.getElementById('accessmine');
  const latest = sessions.requests[0];
  const who = person.name ? person.name.split(/\s+/)[0] : 'They';
  mine.textContent = !latest ? `${who} ${person.name ? 'has' : 'have'} not requested one.`
    : latest.grantedAt
      ? `${who} requested one ${weekday(latest.requestedAt)} and got it${latest.orderReference
        ? latest.orderStatus === 'confirmed' ? ' · paid' : latest.orderStatus === 'pending' ? ' · payment to confirm' : ' · payment declined'
        : ' · not paid yet'}.`
      : `${who} requested one ${weekday(latest.requestedAt)} · on ${latest.monthName}'s list.`;
}

export function renderSessions(person) {
  const sessions = person.sessions;
  const note = document.getElementById('sessionnote');
  const where = document.getElementById('sessioncard');
  where.textContent = '';
  if (!person.linkedCase) {
    note.textContent = 'No account linked';
    document.getElementById('sessionuse').textContent = '';
    document.getElementById('accessbox').hidden = true;
    document.getElementById('sessionrates').textContent = '';
    document.getElementById('sessioncalls').textContent = '';
    return;
  }
  const left = sessions.held.filter((h) => !h.usedAt).length;
  const live = sessions.held.find((h) => h.usedAt && !h.closedAt);
  note.textContent = live ? `Open · ${minutesOf(live, sessions)}`
    : sessions.held.length ? `${left} of ${sessions.held.length} left` : 'No sessions on the card';
  if (sessions.held.length) where.append(card(person, sessions));
  for (const pending of sessions.pending) {
    where.append(el('p', `${pending.reference} · ${pending.rateLabel} · ${money(pending.amount)} · paid ${weekday(pending.paidAt)} · to confirm on Today`, 'faint'));
  }
  useRow(person, sessions);
  accessLines(person, sessions);
  const rates = sessions.rates;
  document.getElementById('sessionrates').textContent = rates
    ? `Rates everyone sees: standard ${money(rates.standard)} a session · access rate ${money(rates.access)}, ${rates.aMonth} a month.`
    : 'Rates not set · set them on Money.';
  const calls = sessions.calls;
  document.getElementById('sessioncalls').textContent = calls.length
    ? `Calls: ${calls.length} · ${calls.map((c) => `${c.calledAt ? weekday(c.calledAt) : 'no call yet'} · ${money(c.amount)}`).join(' · ')}`
    : '';
}
