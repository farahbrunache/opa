import { askModel, el, link, modelReady, msg, paidButton, post, weekday } from '/desk-ui.js';
import { askInMessage, whenAsked } from '/desk-thread.js';
import { renderPages } from '/desk-lists.js';
import { STAGES, fits } from '/questions.js';
import { once, resumeDraft, settled } from '/desk-after.js';

const PICKS = 3;
const A_PAGE = 8;

const view = { personId: null, ticked: new Set(), suggested: null, browsing: false, page: 1, passing: null };

whenAsked((ids) => {
  for (const id of ids) view.ticked.delete(id);
});

function open(person) {
  return person.questions.filter((q) => q.fit !== 'other' && fits(q, person.questionStage) && !q.askedAt && !q.passedAt);
}

function picks(person) {
  const why = new Map((view.suggested?.picks || []).map((p) => [p.id, p.reason]));
  const suggested = person.questions.filter((q) => why.has(q.id) && !q.askedAt && !q.passedAt);
  const chosen = suggested.length ? suggested : open(person);
  return chosen.slice(0, PICKS).map((q) => ({ ...q, why: why.get(q.id) || null }));
}

function tickButton(person, question) {
  const button = el('button', null, 'btn small');
  button.type = 'button';
  const draw = () => {
    const on = view.ticked.has(question.id);
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'In the message' : 'Add to message';
  };
  draw();
  once(button, 'click', () => {
    if (view.ticked.has(question.id)) view.ticked.delete(question.id);
    else if (view.ticked.size < PICKS) view.ticked.add(question.id);
    else {
      msg('rmsg', `Up to ${PICKS} a message, so they can answer them all.`, 'bad');
      return;
    }
    draw();
    askButtons(person);
  });
  return button;
}

function passBox(person, question) {
  const box = el('div', null, 'reasons');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Not now, because');
  box.append(el('span', 'Not now, because (optional):', 'faint'));
  const send = async (reason) => {
    try {
      await post('question-pass', { id: person.id, question: question.id, reason: reason || undefined });
      view.passing = null;
      await settled('Set aside.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  };
  for (const { value, label } of person.passReasons || []) {
    const button = el('button', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    once(button, 'click', () => send(value));
    box.append(button);
  }
  const skip = el('button', 'No reason', 'btn ghost small');
  skip.type = 'button';
  once(skip, 'click', () => send(null));
  const cancel = el('button', 'Cancel', 'btn ghost small');
  cancel.type = 'button';
  once(cancel, 'click', () => {
    view.passing = null;
    renderQuestions(person);
  });
  box.append(skip, cancel);
  return box;
}

function nextRow(person, question) {
  const li = el('li', null, 'qnext');
  const text = el('div', null, 'stack tight');
  text.append(el('span', question.body, 'qtext'));
  const tags = [question.scope || 'Everyone', question.topic].filter(Boolean).join(' · ');
  text.append(el('span', tags, 'faint'));
  if (question.isDemo) text.append(el('span', 'Demo', 'tag t-demo'));
  if (question.why) text.append(el('span', question.why, 'why'));
  li.append(text);
  const pair = el('div', null, 'pair');
  const notNow = el('button', 'Not now', 'btn ghost small');
  notNow.type = 'button';
  once(notNow, 'click', () => {
    view.passing = question.id;
    renderQuestions(person);
  });
  pair.append(tickButton(person, question), notNow);
  li.append(pair);
  if (view.passing === question.id) li.append(passBox(person, question));
  return li;
}

function askButtons(person) {
  const ticked = person.questions.filter((q) => view.ticked.has(q.id));
  const button = document.getElementById('qtomsg');
  button.hidden = !person.conversationOpen;
  button.disabled = !ticked.length;
  button.textContent = `Ask these in a message (${ticked.length} of ${PICKS})`;
  button.onclick = () => askInMessage(ticked.map((q) => ({ id: q.id, body: q.body })));
}

function askedRows(person) {
  const asked = person.questions.filter((q) => q.askedAt)
    .sort((a, b) => new Date(b.askedAt) - new Date(a.askedAt));
  document.getElementById('qaskedhead').hidden = !asked.length;
  document.getElementById('qaskedcount').textContent = String(asked.length);
  const list = document.getElementById('qaskedlist');
  list.textContent = '';
  for (const q of asked) {
    const p = el('p', null, 'drow');
    p.append(el('b', q.body), ` · asked ${weekday(q.askedAt)}${q.asks > 1 ? ` · ${q.asks} times` : ''} · `,
      el('span', q.answered ? 'answered' : 'waiting', q.answered ? 'good' : null));
    list.append(p);
  }
  return asked.length;
}

function browse(person, rest) {
  const bar = document.getElementById('qbrowsebar');
  const list = document.getElementById('qlist');
  const pager = document.getElementById('qpager');
  bar.textContent = '';
  list.textContent = '';
  list.hidden = !view.browsing;
  pager.hidden = true;
  const toggle = el('button', view.browsing ? 'Hide the rest' : `Browse all ${rest.length} · ${A_PAGE} a page`, 'btn ghost small');
  toggle.type = 'button';
  toggle.disabled = !rest.length;
  once(toggle, 'click', () => {
    view.browsing = !view.browsing;
    view.page = 1;
    renderQuestions(person);
  });
  bar.append(toggle, link('Question lists', '/questions', 'btn ghost small'));
  if (!view.browsing) return;
  const last = Math.max(1, Math.ceil(rest.length / A_PAGE));
  view.page = Math.min(view.page, last);
  for (const q of rest.slice((view.page - 1) * A_PAGE, view.page * A_PAGE)) {
    const li = el('li');
    const button = el('button', null, 'q');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(view.ticked.has(q.id)));
    button.append(el('span', '✓', 'box2'));
    const text = el('span');
    text.append(el('span', q.body, 'qt'));
    for (const said of [q.scope, q.topic]) if (said) text.append(' ', el('span', said, 'tag'));
    if (q.stage !== 'any') text.append(' ', el('span', STAGES[q.stage]?.label || q.stage, 'tag'));
    if (q.passedAt) text.append(el('span', `Not now${q.passReason ? ` · ${q.passReason}` : ''} · ${weekday(q.passedAt)}`, 'hint asked'));
    button.append(text);
    once(button, 'click', () => {
      if (view.ticked.has(q.id)) view.ticked.delete(q.id);
      else if (view.ticked.size < PICKS) view.ticked.add(q.id);
      else {
        msg('rmsg', `Up to ${PICKS} a message, so they can answer them all.`, 'bad');
        return;
      }
      button.setAttribute('aria-pressed', String(view.ticked.has(q.id)));
      askButtons(person);
    });
    li.append(button);
    list.append(li);
  }
  renderPages(pager, view.page, last, (to) => {
    view.page = to;
    renderQuestions(person);
  });
}

export function renderQuestions(person) {
  if (view.personId !== person.id) {
    Object.assign(view, { personId: person.id, ticked: new Set(), suggested: null, browsing: false, page: 1, passing: null });
  }
  const pick = document.getElementById('qpick');
  pick.textContent = '';
  const nextList = document.getElementById('qnext');
  nextList.textContent = '';

  if (!person.questionStage) {
    document.getElementById('qasked').textContent = 'No-go';
    document.getElementById('qfor').textContent = '';
    document.getElementById('qnexthead').hidden = true;
    document.getElementById('qai').hidden = true;
    document.getElementById('qtomsg').hidden = true;
    document.getElementById('qaskedhead').hidden = true;
    document.getElementById('qaskedlist').textContent = '';
    document.getElementById('qbrowsebar').textContent = '';
    document.getElementById('qlist').hidden = true;
    document.getElementById('qpager').hidden = true;
    return;
  }
  document.getElementById('qfor').textContent = person.trade
    ? `For ${person.trade.title} · ${person.trade.sector}`
    : 'No job title from their skills yet, so these are the questions for everyone';

  const next = picks(person);
  const nextIds = new Set(next.map((q) => q.id));
  const rest = person.questions.filter((q) => !nextIds.has(q.id) && !q.askedAt);
  document.getElementById('qnexthead').hidden = !next.length;
  document.getElementById('qnextsaid').textContent = view.suggested
    ? 'picked from the calls ($)' : 'their job title first, then their sector, then everyone';
  for (const q of next) nextList.append(nextRow(person, q));
  if (!next.length) nextList.append(el('li', 'Nothing left to ask at this stage.', 'empty'));
  const asked = askedRows(person);
  document.getElementById('qasked').textContent = `${next.length} next · ${rest.length} more · ${asked} asked`;

  const ai = document.getElementById('qai');
  ai.hidden = !view.suggested;
  if (view.suggested) document.getElementById('qaitext').textContent = view.suggested.summary;
  document.getElementById('qclear').onclick = () => {
    view.suggested = null;
    renderQuestions(person);
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
        renderQuestions(person);
      } catch (error) {
        msg('rmsg', error.message, 'bad');
      } finally {
        button.disabled = false;
        label.textContent = 'Pick what to ask next';
      }
    });
    pick.append(button);
  }
  askButtons(person);
  browse(person, rest);
}
