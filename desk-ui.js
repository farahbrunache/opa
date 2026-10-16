export const here = new URL(window.location.href);
export const personId = here.searchParams.get('id');
export const state = here.searchParams.get('state') || 'waiting';
export const page = Math.max(1, Number(here.searchParams.get('page')) || 1);
export const mpage = here.searchParams.get('mpage');
export const asked = (here.searchParams.get('q') || '').trim();
export const askedForQueue = here.searchParams.has('state') || here.searchParams.has('page')
  || Boolean(asked);

export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function link(text, href, className) {
  const a = el('a', text, className);
  a.href = href;
  return a;
}

export function msg(id, text, kind) {
  const box = document.getElementById(id);
  box.hidden = false;
  box.className = 'msg ' + (kind || '');
  box.textContent = text;
  if (kind === 'bad') box.scrollIntoView({ block: 'nearest' });
}

function clockNow() {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export async function call(url, options) {
  const action = new URL(url, window.location.href).searchParams.get('action') || url;
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const lost = new Error(
      `No answer from the server for ${action}; the connection dropped. The browser said "${error.message}". ${clockNow()}.`,
    );
    lost.status = 0;
    throw lost;
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const said = data.error
      || `The server answered ${response.status} with no reason in it${text ? `: ${text.slice(0, 200)}` : ''}.`;
    const error = new Error(`${said} (${action} · HTTP ${response.status} · ${clockNow()})`);
    error.status = response.status;
    error.said = data.error || '';
    throw error;
  }
  return data;
}

export function get(action) {
  return call(`/api/desk?action=${action}`);
}

export function post(action, body) {
  const on = personId ? `&on=${encodeURIComponent(personId)}` : '';
  return call(`/api/desk?action=${action}${on}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function weekday(value) {
  return value
    ? new Date(value).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : '';
}

export function stamp(value) {
  if (!value) return '';
  const at = new Date(value);
  return `${weekday(at)} · ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function minutes(seconds) {
  return seconds ? `${Math.round(seconds / 60)} min` : 'length not recorded';
}

export function demoChip(row, into) {
  if (row.isDemo) into.append(el('div', 'DEMO', 'badge demo'));
  if (row.isMine) into.append(el('div', 'YOURS', 'badge demo'));
}

export function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

export function owed(person) {
  const out = [];
  if (person.awaitingReply) {
    out.push({ what: 'They wrote and are waiting on a reply.', yours: true,
      next: 'Answer their message', go: '#messages', button: 'Reply' });
  }
  if (person.recordMissing) {
    const aDayOn = person.calledAt
      && Date.now() - new Date(person.calledAt).getTime() > 24 * 3600 * 1000;
    out.push({
      what: aDayOn
        ? 'Call record still not saved after a day. Open the call and save it.'
        : 'Call record not saved yet. The hourly job gets it.',
      yours: Boolean(aDayOn),
      next: aDayOn ? 'Save the call record' : null, go: '#call', button: 'The call',
    });
  }
  const now = person.chapters?.[person.chapters.length - 1];
  if (now && now.number > 1) {
    if (!now.decision) {
      out.push({ what: 'New direction. Read the brief, then go or no-go.', yours: true,
        next: 'Read the new brief, then decide go or no-go', go: '#brief', button: 'The brief' });
    }
  } else if (!person.decision) {
    out.push({ what: 'Go or no-go.', yours: true, next: 'Decide go or no-go', go: '#decision', button: 'Decide' });
  }
  const roadmap = {
    review: ['Roadmap changes are waiting on you.', 'Review the roadmap changes'],
    redraw: ['An outcome came in since the roadmap was drawn.', 'Redraw the roadmap'],
    send: ['Nothing of theirs is on their page. A drafted activity is waiting.', 'Move an activity to To do'],
  }[person.roadmap?.due];
  if (roadmap) {
    out.push({ what: roadmap[0], yours: true, next: roadmap[1], go: '#activities', button: 'Roadmap' });
  }
  if (!person.strategy?.live) {
    out.push({ what: 'Write the strategy.', yours: true,
      next: 'Write the strategy', go: '#strategy', button: 'Strategy' });
  }
  if (!person.recommendedAt) {
    out.push({ what: 'Write recommendations.', yours: true,
      next: 'Write recommendations', go: '#steps', button: 'Recommendations' });
  }
  return out;
}

export const MODEL_ACTIONS = ['draft', 'strategy-draft', 'questions-draft', 'find-matches', 'call-gaps', 'roadmap-draft'];

export const aiScope = { withSummary: false };

const DRAFT_POLL_MS = 3000;
const watching = new Map();
export const shownDrafts = new Set();

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function waitDraft(draftId) {
  if (!watching.has(draftId)) {
    const run = (async () => {
      for (;;) {
        await new Promise((done) => { setTimeout(done, DRAFT_POLL_MS); });
        try {
          const out = await get(`draft-result&id=${draftId}`);
          if (out.state !== 'running') return out;
        } catch (error) {
          if (error.status !== 0) throw error;
        }
      }
    })().finally(() => watching.delete(draftId));
    watching.set(draftId, run);
  }
  return watching.get(draftId);
}

export function draftFailed(out) {
  const error = new Error(out.failure || `Draft ${out.draftId} failed with no reason given.`);
  error.status = 502;
  return error;
}

export async function askModel(button, body, action = 'draft') {
  if (!MODEL_ACTIONS.includes(action)) {
    throw new Error(`${action} isn't one of the actions that run the model.`);
  }
  if (!button.classList.contains('paid')) {
    throw new Error('This button runs the drafting model and isn\'t marked as costing money, so nothing was sent.');
  }
  const label = button.querySelector('.paidlabel');
  const was = label ? label.textContent : '';
  const doing = was.replace(/…$/, '');
  const started = Date.now();
  let shown = '';
  const tick = setInterval(() => {
    if (!label) return;
    shown = `${doing} · ${clock(Date.now() - started)}`;
    label.textContent = shown;
  }, 1000);
  try {
    const { draftId } = await post(action, { ...body, withSummary: aiScope.withSummary });
    const out = await waitDraft(draftId);
    shownDrafts.add(draftId);
    if (out.state === 'failed') throw draftFailed(out);
    return out.payload;
  } finally {
    clearInterval(tick);
    if (label && label.textContent === shown) label.textContent = was;
  }
}

export function offWhen(button, off, state) {
  button.hidden = false;
  button.querySelector('.offstate')?.remove();
  button.classList.toggle('off', Boolean(off));
  if (off) {
    button.disabled = true;
    button.append(el('span', state, 'offstate'));
  } else {
    button.disabled = false;
  }
  return !off;
}

export const NO_MODEL = 'No model set up';
export const hasModel = (person) => Boolean((person.drafting?.models || []).length);
export function modelReady(button, person) {
  return offWhen(button, !hasModel(person), NO_MODEL);
}

export function paidButton(label) {
  const button = el('button', null, 'btn ai paid');
  button.type = 'button';
  const mark = el('span', '$', 'coin');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', 'Costs money');
  mark.title = 'Costs money';
  button.append(mark, el('span', label, 'paidlabel'));
  return button;
}
