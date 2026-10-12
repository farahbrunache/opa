import { day, el } from '/client-ui.js';

export function chipFor(session, waiting = 'Being read') {
  if (session.recommendations) return ['Next steps written', 'ok'];
  if (session.hasTranscript) return [waiting, ''];
  if (session.hasCall) return ['Nothing recorded', 'mute'];
  return ['Not started', 'mute'];
}

export function sessionLine(session, label) {
  if (!session.hasCall) return `Paid ${day(session.paidAt)}`;
  const kind = label || (session.callKind === 'follow-up' ? 'Follow-up call' : 'First call');
  const parts = [kind, day(session.calledAt)];
  if (session.callSeconds > 0) parts.push(`${Math.max(1, Math.round(session.callSeconds / 60))} min`);
  else if (!session.hasTranscript) parts.push('0 min');
  return parts.filter(Boolean).join(' · ');
}

function chip(text, tone) {
  return el('span', text, tone ? `cchip ${tone}` : 'cchip');
}

export function sessionCard(session, waiting) {
  const card = el('div', null, 'sessmini');
  const [text, tone] = chipFor(session, waiting);
  card.append(el('b', session.reference, 'mono'), chip(text, tone), el('small', sessionLine(session, 'Call')));
  return card;
}

export function drawSessions(section, sessions, current) {
  const list = section.querySelector('.sessrows');
  list.textContent = '';
  section.querySelector('.cdate').textContent = `${sessions.length} on this account`;
  for (const session of sessions) {
    const row = el('li', null, session === current ? 'cur' : null);
    const [text, tone] = chipFor(session);
    row.append(el('b', session.reference, 'mono'), chip(text, tone), el('small', sessionLine(session)));
    list.append(row);
  }
  section.hidden = false;
}

export function drawFoot(foot, session, count) {
  foot.querySelector('[data-ref]').textContent = session ? session.reference : '';
  foot.querySelector('[data-ref]').parentElement.hidden = !session;
  const jump = foot.querySelector('[data-count]');
  jump.textContent = `${count} · see all`;
  jump.parentElement.hidden = !count;
}
