import { el, msg, post, stamp } from '/desk-ui.js';
import { once, settled } from '/desk-after.js';
import { chapterNumber } from '/desk-chapters.js';

const FILTERS = [['all', 'All'], ['msg', 'Messages'], ['edit', 'Edits'], ['money', 'Money'], ['note', 'Notes']];
let showing = 'all';
let chapter = null;

function chapterAt(person, at) {
  const started = (person.chapters || []).filter((c) => new Date(c.startedAt) <= new Date(at));
  return started.length ? started[started.length - 1].number : 1;
}

function messageLines(person) {
  return (person.messages || [])
    .filter((m) => m.author === 'client'
      || (m.author === 'operator' && !m.fromTemplate && m.body !== person.recommendations))
    .map((m) => ({
      group: 'msg',
      label: m.author === 'client' ? 'Message received' : 'Message sent',
      detail: m.body.length > 140 ? `${m.body.slice(0, 140)}…` : m.body,
      by: m.author === 'client' ? 'From client' : 'By you',
      at: m.at,
      chapter: chapterAt(person, m.at),
    }));
}

function draw(list, lines) {
  list.textContent = '';
  const shown = lines.filter((line) => (showing === 'all' || line.group === showing)
    && (chapter === null || line.chapter === chapter));
  if (!shown.length) {
    list.append(el('li', 'Nothing here yet.', 'empty'));
    return;
  }
  for (const line of shown) {
    const li = el('li');
    li.append(el('time', stamp(line.at)));
    const text = el('span');
    text.append(el('b', line.label));
    if (line.detail) text.append(` ${line.detail}`);
    text.append(el('small', line.by));
    li.append(text);
    list.append(li);
  }
}

export function renderLog(person) {
  const list = document.getElementById('events');
  const events = (person.events || []).map((e) => ({ ...e, chapter: chapterNumber(person, e.chapterId) }));
  const lines = [...events, ...messageLines(person)]
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const chapters = person.chapters || [];
  if (chapter !== null && !chapters.some((c) => c.number === chapter)) chapter = null;
  const byChapter = document.getElementById('logch');
  byChapter.textContent = '';
  byChapter.hidden = chapters.length < 2;
  for (const [key, label] of [[null, 'All chapters'], ...[...chapters].reverse().map((c) => [c.number, `Chapter ${c.number}`])]) {
    const chip = el('button', label, 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(key === chapter));
    chip.addEventListener('click', () => {
      chapter = key;
      for (const other of byChapter.children) other.setAttribute('aria-pressed', String(other === chip));
      draw(list, lines);
    });
    byChapter.append(chip);
  }
  document.getElementById('logcount').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;

  const chips = document.getElementById('logf');
  chips.textContent = '';
  for (const [key, label] of FILTERS) {
    const chip = el('button', label, 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(key === showing));
    once(chip, 'click', () => {
      showing = key;
      for (const other of chips.children) other.setAttribute('aria-pressed', String(other === chip));
      draw(list, lines);
    });
    chips.append(chip);
  }
  draw(list, lines);

  once(document.getElementById('addnote'), 'submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('note');
    if (!input.value.trim()) return;
    try {
      await post('note', { id: person.id, note: input.value });
      input.value = '';
      await settled('Note added.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}
