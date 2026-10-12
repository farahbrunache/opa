import { askModel, el, modelReady, msg, paidButton, weekday } from '/desk-ui.js';
import { askInMessage, whenAsked } from '/desk-thread.js';
import { STAGES, STAGE_ORDER } from '/questions.js';
import { once, resumeDraft } from '/desk-after.js';

const view = { personId: null, set: null, ticked: new Set(), suggested: null, drafted: false };

function setsOf(questions) {
  return STAGE_ORDER.filter((stage) => stage !== 'any').map((stage) => ({
    key: stage,
    label: STAGES[stage].label,
    questions: questions.filter((q) => q.stage === stage || q.stage === 'any'),
  }));
}

whenAsked((ids) => {
  for (const id of ids) view.ticked.delete(id);
  view.drafted = false;
});

function strip(person) {
  const box = document.getElementById('flow3');
  box.textContent = '';
  const ticked = person.questions.filter((q) => view.ticked.has(q.id)).length;
  const picks = view.suggested?.picks.length || 0;
  const steps = [
    ['1 · Suggest', picks ? `${picks} picked` : 'Optional', picks ? 'done' : ticked ? null : 'on'],
    ['2 · Tick', `${ticked} ticked`, ticked ? 'done' : picks ? 'on' : null],
    ['3 · Draft', view.drafted ? 'In Messages' : 'Then Send', view.drafted ? 'done' : ticked ? 'on' : null],
  ];
  for (const [name, said, tone] of steps) {
    const li = el('li', null, tone);
    li.append(el('b', name), el('span', said));
    box.append(li);
  }
}

function row(question, why, person) {
  const li = el('li');
  const button = el('button', null, why ? 'q sug' : 'q');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(view.ticked.has(question.id)));
  button.append(el('span', '✓', 'box2'));
  const text = el('span');
  if (why) text.append(el('span', 'Suggested', 'tag t-new'), ' ');
  text.append(el('span', question.body, 'qt'));
  for (const said of [question.scope, question.topic]) if (said) text.append(' ', el('span', said, 'tag'));
  if (question.isDemo) text.append(' ', el('span', 'Demo', 'tag t-demo'));
  if (question.askedAt) {
    text.append(el('span', `Asked ${weekday(question.askedAt)}${question.asks > 1 ? ` · ${question.asks} times` : ''}`, 'hint asked'));
  }
  if (why) text.append(el('span', why, 'why'));
  button.append(text);
  once(button, 'click', () => {
    if (view.ticked.has(question.id)) view.ticked.delete(question.id);
    else view.ticked.add(question.id);
    button.setAttribute('aria-pressed', String(view.ticked.has(question.id)));
    askButtons(person);
    counts(person);
    strip(person);
  });
  li.append(button);
  return li;
}

function askButtons(person) {
  const ticked = person.questions.filter((q) => view.ticked.has(q.id));
  const button = document.getElementById('qtomsg');
  button.hidden = !person.conversationOpen;
  button.disabled = !ticked.length;
  button.textContent = `Ask these in a message (${ticked.length})`;
  button.onclick = () => {
    askInMessage(ticked.map((q) => ({ id: q.id, body: q.body })));
    view.drafted = true;
    strip(person);
  };
}

function counts(person) {
  const asked = person.questions.filter((q) => q.askedAt).length;
  document.getElementById('qasked').textContent = `${asked} of ${person.questions.length} asked`
    + ` · ${person.questions.filter((q) => view.ticked.has(q.id)).length} ticked`;
}

function draw(person, sets) {
  const list = document.getElementById('qlist');
  const chips = document.getElementById('qsets');
  list.textContent = '';
  chips.textContent = '';
  for (const set of sets) {
    const chip = el('button', set.key === person.questionStage ? `${set.label} · now` : set.label, 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(set.key === view.set));
    once(chip, 'click', () => {
      view.set = set.key;
      draw(person, sets);
    });
    chips.append(chip);
  }
  const current = sets.find((s) => s.key === view.set) || sets[0];
  const why = new Map((view.suggested?.picks || []).map((p) => [p.id, p.reason]));
  const top = person.questions.filter((q) => why.has(q.id));
  for (const q of top) list.append(row(q, why.get(q.id), person));
  for (const q of current ? current.questions : []) {
    if (!why.has(q.id)) list.append(row(q, null, person));
  }
  if (!current?.questions.length) list.append(el('li', 'No questions on the lists for this stage yet.', 'empty'));
  counts(person);
  strip(person);
  const ai = document.getElementById('qai');
  ai.hidden = !view.suggested;
  if (view.suggested) document.getElementById('qaitext').textContent = view.suggested.summary;
  askButtons(person);
}

export function renderQuestions(person) {
  if (view.personId !== person.id) {
    Object.assign(view, { personId: person.id, set: null, ticked: new Set(), suggested: null, drafted: false });
  }
  const pick = document.getElementById('qpick');
  pick.textContent = '';

  if (!person.questionStage) {
    document.getElementById('qasked').textContent = 'No-go';
    document.getElementById('qsets').textContent = '';
    document.getElementById('qlist').textContent = '';
    document.getElementById('qai').hidden = true;
    document.getElementById('flow3').textContent = '';
    document.getElementById('qtomsg').hidden = true;
    document.getElementById('qfor').textContent = '';
    return;
  }
  const sets = setsOf(person.questions);
  if (!view.set || !sets.some((s) => s.key === view.set)) view.set = person.questionStage;
  document.getElementById('qfor').textContent = person.trade
    ? `For ${person.trade.title} · ${person.trade.sector}`
    : 'No job title from their skills yet, so these are the questions for everyone';

  document.getElementById('qclear').onclick = () => {
    view.suggested = null;
    draw(person, sets);
  };

  const hasCall = (person.calls || []).some((call) => call.transcript);
  if (person.questions.length && hasCall) {
    const button = paidButton('Pick what to ask next');
    modelReady(button, person);
    const label = button.querySelector('.paidlabel');
    const show = (answer) => {
      view.suggested = { summary: answer.summary || answer.content, picks: answer.picks || [] };
    };
    resumeDraft(button, person, 'questions', show);
    once(button, 'click', async () => {
      button.disabled = true;
      label.textContent = 'Reading the call…';
      try {
        show(await askModel(button, { id: person.id }, 'questions-draft'));
        draw(person, sets);
      } catch (error) {
        msg('rmsg', error.message, 'bad');
      } finally {
        button.disabled = false;
        label.textContent = 'Pick what to ask next';
      }
    });
    pick.append(button);
  }
  draw(person, sets);
}
