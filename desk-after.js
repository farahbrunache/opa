import { call, draftFailed, msg, shownDrafts, waitDraft } from '/desk-ui.js';

const STAYS_MS = 6000;

let redraw = null;

export function drawnBy(fn) {
  redraw = fn;
}

export async function again() {
  if (!redraw) return;
  const was = window.scrollY;
  await redraw();
  window.scrollTo(0, was);
}

const wired = new WeakMap();

export function once(node, type, handler) {
  if (!node) return;
  let types = wired.get(node);
  if (!types) {
    types = new Set();
    wired.set(node, types);
  }
  if (types.has(type)) return;
  types.add(type);
  node.addEventListener(type, handler);
}

function line() {
  let box = document.getElementById('after');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'after';
  box.className = 'after';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.hidden = true;
  document.body.append(box);
  return box;
}

let hideAt = null;

function show(said, putBack) {
  const box = line();
  box.textContent = '';
  box.hidden = false;
  const words = document.createElement('span');
  words.textContent = said;
  box.append(words);

  if (putBack) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'undo';
    button.textContent = 'Undo';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Putting it back…';
      try {
        await putBack();
        await again();
        show('Put back.');
      } catch (error) {
        box.hidden = true;
        throw error;
      }
    });
    box.append(button);
  }

  if (hideAt) window.clearTimeout(hideAt);
  hideAt = window.setTimeout(() => {
    box.hidden = true;
    hideAt = null;
  }, STAYS_MS);
}

export async function settled(said, putBack) {
  show(said, putBack);
  await again();
}

export function wasBefore(action, body) {
  if (body === null || body === undefined) return null;
  return () => call(`/api/desk?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const redrawAfter = new Set();

function startedAt(value) {
  const at = new Date(value);
  return `${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export function resumeDraft(button, person, kind, fill, every = false) {
  const job = (person.drafting?.jobs || []).find((j) => j.kind === kind);
  if (!job) return;
  if (job.state === 'running') {
    const label = button.querySelector('.paidlabel');
    button.disabled = true;
    if (label) label.textContent = `Drafting · started ${startedAt(job.startedAt)}`;
    if (redrawAfter.has(job.draftId)) return;
    redrawAfter.add(job.draftId);
    waitDraft(job.draftId).catch(() => null).then(() => again());
    return;
  }
  if (shownDrafts.has(job.draftId) && !(every && job.state === 'ready')) return;
  shownDrafts.add(job.draftId);
  if (job.state === 'failed') msg('rmsg', draftFailed(job).message, 'bad');
  else fill(job.payload);
}
