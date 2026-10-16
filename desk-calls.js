import { el, get, msg, weekday, minutes } from '/desk-ui.js';
import { once } from '/desk-after.js';
import { renderGaps } from '/desk-gaps.js';
import { chapterNumber, currentChapter, openPivot } from '/desk-chapters.js';

const picked = { personId: null, callId: null };

function speaker(name, person) {
  if (/^(agent|assistant)$/i.test(name)) return 'Assistant';
  if (/^(user|caller)$/i.test(name)) return person.name ? person.name.split(/\s+/)[0] : 'Caller';
  return name;
}

function transcriptBox(text, person) {
  const box = el('div', null, 'transcript');
  box.tabIndex = 0;
  box.setAttribute('aria-label', 'Call transcript');
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = el('p');
    const m = line.match(/^([A-Za-z][\w ]{0,20}):\s*(.*)$/);
    if (m) p.append(el('b', `${speaker(m[1], person)}:`), ` ${m[2]}`);
    else p.textContent = line;
    box.append(p);
  }
  return box;
}

function summaryOf(call) {
  const s = call.summary;
  if (!s) return null;
  if (typeof s === 'string') return s;
  return typeof s.call_summary === 'string' ? s.call_summary : null;
}

function copyButton(text) {
  const copy = el('button', 'Copy', 'iconbtn');
  copy.type = 'button';
  once(copy, 'click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select it and copy';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  });
  return copy;
}

function everything(call, words) {
  const button = el('button', 'Everything the voice service has ↗', 'btn ghost small');
  button.type = 'button';
  once(button, 'click', async () => {
    button.disabled = true;
    try {
      const record = await get(`call-record&call=${encodeURIComponent(call.callId)}`);
      const text = JSON.stringify(record, null, 2);
      words.append(el('pre', text, null));
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied, and shown above';
      } catch {
        button.textContent = 'Shown above';
      }
    } catch (error) {
      button.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return button;
}

function panel(person, call) {
  const wrap = el('div', null, 'callp');
  const meta = el('div', null, 'pmeta');
  meta.append(el('span', call.kind === 'intake' ? 'First call' : 'Follow-up'),
    el('span', minutes(call.seconds)));
  if (call.reference) meta.append(el('span', call.reference, 'mono'));
  if ((person.chapters || []).length > 1) meta.append(el('span', `Chapter ${chapterNumber(person, call.chapterId)}`, 'tag t-demo'));
  wrap.append(meta);

  const now = currentChapter(person);
  if (now && chapterNumber(person, call.chapterId) === now.number && String(now.fromCallId) !== String(call.id)) {
    const start = el('button', 'Start a chapter from this call', 'msgact');
    start.type = 'button';
    once(start, 'click', () => openPivot(person, {
      callId: call.id,
      body: summaryOf(call) || '',
      day: String(call.endedAt || call.startedAt).slice(0, 10),
    }));
    wrap.append(start);
  }

  const summary = el('div', null, 'box');
  const top = el('div', null, 'line');
  top.append(el('span', 'Summary', 'label'));
  if (summaryOf(call)) top.append(el('span', 'From the voice service', 'faint from'));
  summary.append(top,
    el('p', summaryOf(call) || 'None came with this call.', summaryOf(call) ? null : 'faint'));
  wrap.append(summary);

  wrap.append(renderGaps(person, call));


  const head = el('div', null, 'line');
  head.append(el('span', 'Transcript', 'label'), copyButton(call.transcript));
  const words = transcriptBox(call.transcript, person);
  wrap.append(head, words);
  if (call.callId) {
    const row = el('div', null, 'pair');
    row.append(everything(call, words));
    wrap.append(row);
  }
  return wrap;
}

export function renderCalls(person) {
  const box = document.getElementById('calls');
  const chips = document.getElementById('callpick');
  const calls = person.calls.filter((call) => call.transcript);
  box.textContent = '';
  chips.textContent = '';
  if (picked.personId !== person.id) Object.assign(picked, { personId: person.id, callId: null });
  document.getElementById('callcount').textContent = calls.length > 1 ? `${calls.length} calls` : '';
  if (!calls.length) {
    chips.hidden = true;
    box.append(el('p', person.calls.length ? 'Started, nothing recorded.' : 'No call yet.', 'empty'));
    return;
  }
  const current = calls.find((call) => call.id === picked.callId) || calls[0];
  chips.hidden = calls.length < 2;
  calls.forEach((call, i) => {
    const chip = el('button', `Call ${calls.length - i} · ${weekday(call.endedAt || call.startedAt)}`, 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(call === current));
    once(chip, 'click', () => {
      picked.callId = call.id;
      renderCalls(person);
    });
    chips.append(chip);
  });
  box.append(panel(person, current));
}
