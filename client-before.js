import { el } from '/client-ui.js';
import { sessionCard } from '/client-sessions.js';
import { PREVIEW } from '/client-source.js';

function savedClaim() {
  if (PREVIEW) return null;
  try {
    const saved = localStorage.getItem('onepercent.claim');
    return saved && saved.startsWith('/claim?t=') ? saved : null;
  } catch {
    return null;
  }
}

export function waitingSession(sessions) {
  return sessions.find((s) => s.hasTranscript) || sessions[0] || null;
}

function hero(root, eyebrow, title, lede) {
  root.querySelector('[data-eyebrow]').textContent = eyebrow;
  root.querySelector('h1').textContent = title;
  root.querySelector('[data-lede]').textContent = lede;
}

function claimLink(panel, label) {
  const saved = savedClaim();
  if (saved) {
    const go = el('a', label, 'cbtn');
    go.href = saved;
    panel.append(go);
  } else {
    panel.append(el('p', 'Open the claim link you saved after paying. The call starts there.', 'ctext'));
  }
  const lost = el('p', saved ? "It's the link you got after paying. Lost it? " : 'Lost it? ', 'cfine');
  const recover = el('a', 'Recover it on the Pay page.');
  recover.href = '/buy';
  lost.append(recover);
  panel.append(lost);
}

export function renderBefore(root, data) {
  const panel = root.querySelector('[data-panel]');
  const linker = root.querySelector('[data-linker]');
  panel.textContent = '';
  linker.hidden = data.sessions.length > 0;
  panel.hidden = !data.sessions.length;

  if (!data.sessions.length) {
    hero(root, 'One Percent', "You're signed in.", 'No session is linked to this account yet.');
    return null;
  }

  const session = waitingSession(data.sessions);
  if (session.hasTranscript) {
    hero(root, 'One Percent · Your session', 'Your call is being read.',
      'A person reads the call and writes your next steps, usually within 48 hours.');
    panel.append(sessionCard(session, 'Waiting to be read'));
    panel.append(el('p', 'Nothing is needed from you. This page changes when your next steps are written.', 'ctext'));
  } else if (session.hasCall) {
    hero(root, 'One Percent · Your session', "Your call didn't record anything.",
      "It ended before anything was said, so there's nothing for a person to read.");
    panel.append(sessionCard(session));
    claimLink(panel, 'Start again from my claim link');
    panel.append(el('p', session.callSeconds > 0
      ? 'Your claim link says how many minutes are left.'
      : 'The minutes are all still there.', 'cfine'));
  } else {
    hero(root, 'One Percent · Your session', "Your call hasn't started.",
      'The session is paid for. The call starts from your claim link.');
    panel.append(sessionCard(session));
    claimLink(panel, 'Open my claim link');
  }
  return session;
}
