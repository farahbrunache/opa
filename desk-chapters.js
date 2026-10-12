import { aiScope, askModel, el, modelReady, msg, paidButton, post, weekday } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';
import { FIELDS } from '/desk-callfields.js';

const view = { personId: null, number: null, person: null };
const sheet = { from: null };

const BRIEF_FOLD = 600;
const today = () => new Date().toISOString().slice(0, 10);

export function currentChapter(person) {
  return person.chapters?.length ? person.chapters[person.chapters.length - 1] : null;
}

export function chapterNumber(person, chapterId) {
  if (chapterId === null || chapterId === undefined) return 1;
  return person.chapters?.find((c) => String(c.id) === String(chapterId))?.number || 1;
}

const titleOf = (chapter) => chapter.name || `Chapter ${chapter.number}`;
const startedBy = (chapter) => (chapter.startedBy === 'them' ? 'they asked' : null);
const decisionLabel = (value) => ({ go: 'Go', 'no-go': 'No-go' })[value] || 'Not decided';

function card(person, chapter, now) {
  const button = el('button', null, 'chap');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(view.number === null ? now : view.number === chapter.number));
  button.append(el('span', now ? `Chapter ${chapter.number} · now` : `Chapter ${chapter.number}`, 'cn'));
  button.append(el('b', titleOf(chapter)));
  const calls = `${chapter.calls} ${chapter.calls === 1 ? 'call' : 'calls'}`;
  button.append(el('small', now
    ? [`Since ${weekday(chapter.startedAt)}`, startedBy(chapter)].filter(Boolean).join(' · ')
    : `${weekday(chapter.startedAt)} – ${weekday(chapter.endedAt)} · ${calls}`));
  once(button, 'click', () => {
    view.number = now ? null : chapter.number;
    renderChapters(person);
  });
  return button;
}

function showLive(live) {
  for (const id of ['nextup', 'decision']) document.getElementById(id).hidden = !live;
  document.getElementById('histbar').hidden = live;
  document.getElementById('pastchapter').hidden = live;
}

function renderReads(person) {
  const box = document.getElementById('aiscope');
  const reads = person.aiReads;
  box.hidden = !reads || view.number !== null;
  if (box.hidden) return;
  const chip = document.getElementById('aisummary');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const say = () => {
    const parts = [reads.brief ? 'the starting brief' : null, plural(reads.messages, 'message'),
      reads.calls ? plural(reads.calls, 'call') : null].filter(Boolean);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    const extra = aiScope.withSummary && reads.previous ? reads.previous.words : 0;
    document.getElementById('aiscopetext').textContent = extra
      ? `Chapter ${reads.number}, plus the ${extra}-word summary of Chapter ${reads.previous.number}. About ${(reads.words + extra).toLocaleString()} words.`
      : `Chapter ${reads.number} only: ${list} since ${weekday(reads.since)}. About ${reads.words.toLocaleString()} words.`;
    chip.setAttribute('aria-pressed', String(aiScope.withSummary));
  };
  chip.hidden = !reads.previous;
  if (reads.previous) chip.textContent = `+ Chapter ${reads.previous.number} summary · ${reads.previous.words} words`;
  else aiScope.withSummary = false;
  once(chip, 'click', () => {
    aiScope.withSummary = !aiScope.withSummary;
    say();
  });
  say();
}

function readySummary(person, number) {
  const job = (person.drafting?.jobs || []).find((j) => j.kind === 'summary' && j.state === 'ready');
  return job && job.payload?.number === number ? job.payload.content.trim() : null;
}

function draftSummary(button, person, number, into) {
  modelReady(button, person);
  const which = () => (typeof number === 'function' ? number() : number);
  resumeDraft(button, person, 'summary', (written) => {
    if (written.number === which()) into.value = written.content.trim();
  });
  once(button, 'click', async () => {
    const label = button.querySelector('.paidlabel');
    const was = label.textContent;
    button.disabled = true;
    label.textContent = 'Reading the chapter…';
    try {
      const written = await askModel(button, { id: view.person.id, of: 'summary', number: which() });
      into.value = written.content.trim();
      into.focus();
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      button.disabled = false;
      label.textContent = was;
    }
  });
}

function pastChapter(person, chapter) {
  const box = document.getElementById('pastchapter');
  box.textContent = '';
  const now = currentChapter(person);
  document.getElementById('histsaid').textContent = `Chapter ${chapter.number} is history. Read-only.`;
  const back = document.getElementById('histback');
  back.textContent = `Back to Chapter ${now.number}`;
  once(back, 'click', () => {
    view.number = null;
    renderChapters(view.person);
  });

  const top = el('div', null, 'box');
  const line = el('div', null, 'line');
  line.append(el('span', `Decision · Chapter ${chapter.number}`, 'label'));
  line.append(el('span', decisionLabel(chapter.decision),
    `tag ${chapter.decision === 'go' ? 't-go' : chapter.decision === 'no-go' ? 't-owe' : 't-demo'}`));
  top.append(line);

  const calls = person.calls.filter((c) => c.fields && chapterNumber(person, c.chapterId) === chapter.number);
  for (const call of calls) {
    top.append(el('span', `Call lines · ${weekday(call.startedAt)}`, 'label'));
    const list = el('dl', null, 'lines');
    for (const [key, label] of FIELDS) {
      list.append(el('dt', label), el('dd', call.fields[key] || '—'));
    }
    top.append(list);
  }

  const shut = chapter.closedWith || { activities: [], work: [] };
  const rows = [
    ...(shut.activities || []).map((title) => [`Activity: ${title}`, 'Dropped · changed direction']),
    ...shut.work.map((title) => [`Yours: ${title}`, 'Dropped']),
  ];
  if (rows.length) {
    top.append(el('span', 'Closed with', 'label'));
    const list = el('ul', null, 'carry');
    for (const [what, how] of rows) {
      const item = el('li');
      item.append(el('span', what), el('span', how, 'tag t-demo'));
      list.append(item);
    }
    top.append(list);
  }
  box.append(top);

  const words = el('div', null, 'box');
  const head = el('div', null, 'line');
  head.append(el('span', `Chapter ${chapter.number} summary`, 'label'));
  head.append(el('span', chapter.summary ? `${chapter.summaryWords} words` : 'None written', 'faint'));
  words.append(head);
  if (chapter.summary) words.append(el('p', chapter.summary, 'said'));

  const form = el('form', null, 'stack');
  form.noValidate = true;
  form.hidden = true;
  const nameId = `pastname${chapter.number}`;
  const sumId = `pastsum${chapter.number}`;
  const nameField = el('div', null, 'field');
  const nameLabel = el('label', 'Name');
  nameLabel.htmlFor = nameId;
  const name = el('input');
  Object.assign(name, { id: nameId, type: 'text', maxLength: 120, value: chapter.name || '' });
  nameField.append(nameLabel, name);
  const sumField = el('div', null, 'field');
  const sumLabel = el('label', 'Summary');
  sumLabel.htmlFor = sumId;
  const summary = el('textarea');
  Object.assign(summary, { id: sumId, rows: 4, maxLength: 4000,
    value: readySummary(person, chapter.number) || chapter.summary || '' });
  sumField.append(sumLabel, summary);
  const save = el('button', 'Save', 'btn primary');
  save.type = 'submit';
  const saveRow = el('div', null, 'pair');
  saveRow.append(save);
  const write = paidButton('Write it with AI');
  draftSummary(write, person, chapter.number, summary);
  saveRow.append(write);
  form.append(nameField, sumField, saveRow);

  const edit = el('button', 'Edit', 'btn small');
  edit.type = 'button';
  once(edit, 'click', () => {
    form.hidden = false;
    edit.hidden = true;
    summary.focus();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const base = { id: person.id, number: chapter.number };
      if (name.value.trim() !== (chapter.name || '')) await post('chapter-edit', { ...base, field: 'name', text: name.value });
      if (summary.value.trim() !== (chapter.summary || '')) await post('chapter-edit', { ...base, field: 'summary', text: summary.value });
      await settled('Saved.');
    } catch (error) {
      save.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  const editRow = el('div', null, 'pair');
  editRow.append(edit);
  words.append(editRow, form);
  box.append(words);
}

function renderBrief(person) {
  const now = currentChapter(person);
  const section = document.getElementById('brief');
  const shown = Boolean(now) && view.number === null && (now.number > 1 || Boolean(now.brief));
  section.hidden = !shown;
  document.getElementById('jumpbrief').hidden = !shown;
  if (!shown) return;

  const lines = document.getElementById('brieflines');
  const grid = document.getElementById('brieflinefields');
  const fill = document.getElementById('brieffill');
  lines.hidden = now.number < 2;
  fill.hidden = now.number < 2;
  if (now.number > 1) {
    grid.textContent = '';
    for (const [key, label] of FIELDS) {
      const field = el('div', null, 'field');
      const name = el('label', label);
      name.htmlFor = `briefline-${key}`;
      const input = el('input');
      Object.assign(input, { id: `briefline-${key}`, type: 'text', maxLength: 300, value: now.fields?.[key] || '' });
      input.dataset.key = key;
      field.append(name, input);
      grid.append(field);
    }
    if (modelReady(fill, person) && !now.brief) fill.disabled = true;
    const show = (read) => {
      for (const input of grid.querySelectorAll('input')) input.value = read.fields[input.dataset.key] || '';
    };
    fill.querySelector('.paidlabel').textContent = 'Fill call lines from it';
    resumeDraft(fill, person, 'fields:brief', show);
    once(fill, 'click', async () => {
      const label = fill.querySelector('.paidlabel');
      fill.disabled = true;
      label.textContent = 'Reading the brief…';
      try {
        show(await askModel(fill, { id: view.person.id, brief: true }, 'call-fields-draft'));
      } catch (error) {
        msg('rmsg', error.message, 'bad');
      } finally {
        fill.disabled = false;
        label.textContent = 'Fill call lines from it';
      }
    });
    once(lines, 'submit', async (event) => {
      event.preventDefault();
      const fields = Object.fromEntries([...grid.querySelectorAll('input')].map((i) => [i.dataset.key, i.value]));
      try {
        await post('chapter-edit', { id: view.person.id, number: currentChapter(view.person).number, field: 'fields', fields });
        await settled('Lines saved.');
      } catch (error) {
        msg('rmsg', error.message, 'bad');
      }
    });
  }

  const by = now.fromMessageId ? 'from their message' : now.fromCallId ? 'from a call' : null;
  document.getElementById('briefsaid').textContent = [`Chapter ${now.number}`, by].filter(Boolean).join(' · ');
  const text = document.getElementById('brieftext');
  text.textContent = now.brief || 'No brief yet.';
  const long = (now.brief || '').length > BRIEF_FOLD;
  text.classList.toggle('full', !long);
  const full = document.getElementById('brieffull');
  full.hidden = !long;
  full.textContent = 'Show the whole brief';
  once(full, 'click', () => {
    const open = text.classList.toggle('full');
    full.textContent = open ? 'Show less' : 'Show the whole brief';
  });

  const form = document.getElementById('briefform');
  const body = document.getElementById('briefbody');
  form.hidden = true;
  once(document.getElementById('briefedit'), 'click', () => {
    body.value = currentChapter(view.person).brief || '';
    form.hidden = false;
    body.focus();
  });
  once(form, 'submit', async (event) => {
    event.preventDefault();
    try {
      await post('chapter-edit', { id: view.person.id, number: currentChapter(view.person).number, field: 'brief', text: body.value });
      await settled('Brief saved.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}

function carryRow(label, choices, key, picked) {
  const item = el('li');
  item.append(el('span', label));
  if (choices.length === 1) {
    item.append(el('span', choices[0][1], 'tag t-go'));
    return item;
  }
  const seg = el('div', null, 'seg small');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  for (const [value, word] of choices) {
    const half = el('button', word, 'plain');
    half.type = 'button';
    half.dataset.carry = key;
    half.dataset.value = value;
    half.setAttribute('aria-pressed', String(value === picked));
    half.addEventListener('click', () => {
      for (const other of seg.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === half));
    });
    seg.append(half);
  }
  item.append(seg);
  return item;
}

const picked = (key) => document.querySelector(`#pivotcarry [data-carry="${key}"][aria-pressed="true"]`)?.dataset.value;

export function openPivot(person, from = null) {
  const now = currentChapter(person);
  if (!now) return;
  view.number = null;
  sheet.from = from;
  const next = now.number + 1;
  document.getElementById('pivothead').textContent = `Start Chapter ${next}`;
  document.getElementById('pivotgo').textContent = `Start Chapter ${next}`;
  document.getElementById('pivotname').value = '';
  const day = from?.day && from.day > String(now.startedAt).slice(0, 10) ? from.day : today();
  document.getElementById('pivotstart').value = day;
  document.getElementById('pivotstart').max = today();
  document.getElementById('pivotchanged').value = '';
  document.getElementById('pivotbrief').value = from?.body || '';
  document.getElementById('pivotsummary').value = readySummary(person, now.number) || now.summary || '';
  document.getElementById('pivotsummarylabel').textContent = `Summary of Chapter ${now.number}`;
  document.getElementById('pivotoldnamefield').hidden = Boolean(now.name);
  document.getElementById('pivotoldnamelabel').textContent = `Name of Chapter ${now.number}`;
  document.getElementById('pivotoldname').value = '';

  const inThis = (row) => chapterNumber(person, row.chapterId) === now.number;
  const contacts = (person.contacts || []).filter(inThis);
  const waiting = (person.introductions || []).filter((i) => i.outcome === 'waiting').length;
  const openSteps = (person.activities || []).filter((a) => ['todo', 'drafted'].includes(a.state)).length;
  const openWork = (person.work || []).filter((w) => !w.doneAt && w.state !== 'dropped').length;
  const sessionsLeft = (person.orders || []).filter((o) => !o.calledAt).length;

  const list = document.getElementById('pivotcarry');
  list.textContent = '';
  list.append(carryRow('Skills profile', [['carry', 'Carry']], 'skills'));
  list.append(carryRow(`Sessions left · ${sessionsLeft}`, [['carry', 'Carry']], 'sessions'));
  for (const contact of contacts) {
    list.append(carryRow(`To approach: ${contact.name}`, [['carry', 'Carry'], ['leave', 'Leave']], `contact:${contact.id}`, 'carry'));
  }
  list.append(carryRow(`Introductions waiting · ${waiting}`, [['carry', 'Carry'], ['leave', 'Leave']], 'introductions', 'carry'));
  list.append(carryRow(`Open activities · ${openSteps}`, [['carry', 'Carry'], ['close', 'Close']], 'activities', 'close'));
  list.append(carryRow(`Open work of yours · ${openWork}`, [['carry', 'Carry'], ['close', 'Close']], 'work', 'close'));
  list.append(carryRow('Decision', [['reset', 'Reset'], ['keep', 'Keep']], 'decision', 'reset'));

  const form = document.getElementById('pivotsheet');
  form.hidden = false;
  renderChapters(person);
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('pivotname').focus({ preventScroll: true });
}

function wireSheet(person) {
  const form = document.getElementById('pivotsheet');
  document.querySelector('#pivotsumdraft .paidlabel').textContent = 'Write the summary';
  draftSummary(document.getElementById('pivotsumdraft'), person, () => currentChapter(view.person).number,
    document.getElementById('pivotsummary'));
  once(document.getElementById('pivotcancel'), 'click', () => {
    form.hidden = true;
  });
  once(form, 'submit', async (event) => {
    event.preventDefault();
    const go = document.getElementById('pivotgo');
    go.disabled = true;
    try {
      const contacts = [...document.querySelectorAll('#pivotcarry [data-carry^="contact:"][aria-pressed="true"]')]
        .filter((b) => b.dataset.value === 'carry')
        .map((b) => Number(b.dataset.carry.slice('contact:'.length)));
      const done = await post('pivot', {
        id: view.person.id,
        name: document.getElementById('pivotname').value,
        startsOn: document.getElementById('pivotstart').value,
        changed: document.getElementById('pivotchanged').value,
        brief: document.getElementById('pivotbrief').value,
        closingName: document.getElementById('pivotoldname').value,
        summary: document.getElementById('pivotsummary').value,
        fromMessageId: sheet.from?.messageId ?? null,
        fromCallId: sheet.from?.callId ?? null,
        contacts,
        introductions: picked('introductions'),
        activities: picked('activities'),
        work: picked('work'),
        decision: picked('decision'),
      });
      form.hidden = true;
      sheet.from = null;
      await settled(`Chapter ${done.number} started.`);
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      go.disabled = false;
    }
  });
}

export function renderChapters(person) {
  if (view.personId !== person.id) {
    Object.assign(view, { personId: person.id, number: null });
    aiScope.withSummary = false;
  }
  view.person = person;
  const box = document.getElementById('chapters');
  const chapters = person.chapters || [];
  const now = currentChapter(person);
  box.hidden = !now;
  box.textContent = '';
  if (!now) {
    document.getElementById('pivotsheet').hidden = true;
    showLive(true);
    document.getElementById('aiscope').hidden = true;
    renderBrief(person);
    return;
  }

  box.append(card(person, now, true));
  for (const chapter of chapters.slice(0, -1).reverse()) box.append(card(person, chapter, false));
  const add = el('button', '+ New chapter', 'chap new');
  add.type = 'button';
  once(add, 'click', () => openPivot(person));
  box.append(add);

  if (view.number === null) box.scrollLeft = 0;
  const earlier = view.number === null ? null : chapters.find((c) => c.number === view.number);
  if (!earlier) view.number = null;
  showLive(!earlier);
  if (earlier) pastChapter(person, earlier);
  renderReads(person);
  renderBrief(person);
  wireSheet(person);
}
