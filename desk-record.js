import { renderTrades } from '/desk-trades.js';
import { askModel, el, link, modelReady, msg, offWhen, post, weekday, owed } from '/desk-ui.js';
import { renderPlan, renderIntroductions } from '/desk-work.js';
import { renderSessions } from '/desk-sessions.js';
import { renderActivities } from '/desk-activities.js';
import { renderCalls } from '/desk-calls.js';
import { renderContacts } from '/desk-contacts.js';
import { once, resumeDraft, settled, wasBefore } from '/desk-after.js';
import { renderThread } from '/desk-thread.js';
import { renderStrategy } from '/desk-strategy.js';
import { renderQuestions } from '/desk-questions.js';
import { renderMatches } from '/desk-matches.js';
import { renderHead } from '/desk-head.js';
import { renderLog } from '/desk-log.js';
import { watchJumps } from '/desk-jump.js';
import { currentChapter, renderChapters } from '/desk-chapters.js';
import { flaggedTag, renderBroughtBy } from '/desk-referrals.js';
import { SHEET_LINKS, unfilledSlots } from '/sheet.js';

function renderHeader(person) {
  document.getElementById('ref').textContent = person.name || 'No name yet';
  const meta = document.getElementById('called');
  meta.textContent = '';
  const latest = person.calls.find((call) => call.transcript) || person.calls[0];
  meta.append(el('span', person.reference || `Order ${person.id}`, 'mono'));
  meta.append(el('span', latest ? `Called ${weekday(latest.endedAt || latest.startedAt)}` : 'No call yet'));
  if (!person.linked) meta.append(el('span', 'No account linked'));
  if (person.isDemo) meta.append(el('span', 'Demo', 'tag t-demo'));
  if (person.isMine) meta.append(el('span', 'Yours', 'tag t-yours'));
  const flagged = flaggedTag(person);
  if (flagged) meta.append(flagged);
  const who = String(person.name || '').trim().split(/\s+/)[0] || person.reference || `Order ${person.id}`;
  const see = document.getElementById('seeas');
  see.textContent = `See what ${who} sees`;
  see.href = `/preview?id=${encodeURIComponent(person.id)}`;
}

function renderNext(person) {
  const items = owed(person);
  const yours = items.filter((item) => item.yours && item.next);
  const said = document.getElementById('nextsaid');
  if (yours.length) {
    const [first, second] = yours;
    said.textContent = `${first.next}${second ? `, then ${second.next.charAt(0).toLowerCase()}${second.next.slice(1)}` : ''}.`;
  } else {
    said.textContent = items.length ? items[0].what : 'Nothing waiting.';
  }
  const row = document.getElementById('nextgo');
  for (const old of row.querySelectorAll('a')) old.remove();
  const seen = new Set();
  items.filter((item) => item.go).forEach((item) => {
    if (seen.has(item.go)) return;
    seen.add(item.go);
    row.append(link(item.button, item.go, seen.size === 1 ? 'btn primary' : 'btn'));
  });
  row.hidden = !seen.size;
}

function renderDecision(person) {
  const box = document.getElementById('decide');
  const now = currentChapter(person);
  const later = now && now.number > 1;
  const before = later ? person.chapters[person.chapters.length - 2] : null;
  const decision = later ? now.decision : person.decision;
  document.getElementById('decidelabel').textContent = now && person.chapters.length > 1
    ? `Decision · Chapter ${now.number}` : 'Decision';
  const lastWent = { go: 'was a go', 'no-go': 'was a no-go' }[before?.decision] || "wasn't decided";
  document.getElementById('decided').textContent = later
    ? (now.decision ? `Set ${weekday(now.decisionAt)}` : `Not set · Chapter ${before.number} ${lastWent}`)
    : person.decision
      ? `Set ${weekday(person.decidedAt)}${person.decisionInherited ? ' · earlier session' : ''}`
      : person.earlierNoGoAt ? `Not set · No-go on ${weekday(person.earlierNoGoAt)} · earlier session` : 'Not set';
  box.textContent = '';
  for (const [value, label, tone] of [['go', 'Go', 'yes'], ['no-go', 'No-go', 'no']]) {
    const on = value === decision;
    const half = el('button', label, tone);
    half.type = 'button';
    half.setAttribute('aria-pressed', String(on));
    if (!on) {
      once(half, 'click', async () => {
        half.disabled = true;
        try {
          const was = later ? now.decision || null : person.decisionInherited ? null : person.decision || null;
          await post('decide', { id: person.id, decision: value });
          await settled(`Recorded as ${label}.`,
            was ? wasBefore('decide', { id: person.id, decision: was }) : null);
        } catch (error) {
          half.disabled = false;
          msg('rmsg', error.message, 'bad');
        }
      });
    }
    box.append(half);
  }
}

let sheetTemplate = '';

function renderRecommendations(person) {
  const input = document.getElementById('recommendbody');
  const form = document.getElementById('recommendform');
  document.getElementById('sheetstate').textContent = person.recommendedAt
    ? `Sent ${weekday(person.recommendedAt)}` : 'Not written';

  if (person.recommendations && !input.value) input.value = person.recommendations;

  const rules = document.getElementById('sheetrules');
  rules.textContent = '';
  for (const rule of person.sheet?.rules || []) rules.append(el('li', rule, null));
  rules.closest('.box').hidden = !rules.children.length;
  const chips = document.getElementById('sheetlinks');
  chips.textContent = '';
  for (const [name, href] of SHEET_LINKS) {
    const chip = el('button', name, 'chip');
    chip.type = 'button';
    chip.title = href;
    once(chip, 'click', () => {
      const at = input.selectionStart ?? input.value.length;
      const to = input.selectionEnd ?? at;
      const before = input.value.slice(0, at);
      const after = input.value.slice(to);
      const lead = before && !/\s$/.test(before) ? ' ' : '';
      input.value = before + lead + href + after;
      const caret = at + lead.length + href.length;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
    chips.append(chip);
  }

  sheetTemplate = person.sheet?.template || '';
  document.getElementById('usetemplate').hidden = !sheetTemplate;
  once(document.getElementById('usetemplate'), 'click', () => {
    if (input.value.trim() && !window.confirm('Replace what is in the box with the template?')) return;
    input.value = sheetTemplate;
    input.focus();
    input.setSelectionRange(0, 0);
  });

  once(form, 'submit', async (event) => {
    event.preventDefault();
    const left = unfilledSlots(input.value);
    if (left && !window.confirm(
      `${left} part${left === 1 ? ' is' : 's are'} still in square brackets. Send it anyway?`,
    )) {
      return;
    }
    try {
      await post('recommend', { id: person.id, body: input.value });
      await settled('Recommendations sent.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });

  renderDrafting(person);
}

function renderDrafting(person) {
  const drafting = person.drafting || { models: [], slots: [], chosen: null };
  const button = document.getElementById('draftit');
  const label = button.querySelector('.paidlabel');
  const note = document.getElementById('draftnote');
  const row = document.getElementById('models');
  row.textContent = '';
  modelReady(button, person);

  for (const slot of drafting.slots || []) {
    const model = drafting.models.find((m) => m.slot === slot);
    const chosen = Boolean(model) && (model.slot === drafting.chosen || drafting.models.length === 1);
    const pick = el('button', model ? model.name : `Slot ${slot}`, 'btn ghost small choice');
    pick.type = 'button';
    if (!model) offWhen(pick, true, 'Not set up');
    pick.setAttribute('aria-pressed', String(chosen));
    pick.disabled = !model;
    if (model && !chosen) {
      once(pick, 'click', async () => {
        try {
          await post('model', { slot: model.slot, for: 'sheet' });
          await settled(`Drafting with ${model.name}.`);
        } catch (error) {
          msg('rmsg', error.message, 'bad');
        }
      });
    }
    row.append(pick);
  }

  const show = (written) => {
    const input = document.getElementById('recommendbody');
    input.value = written.content;
    input.focus();
    note.textContent = [
      written.model,
      written.seconds + 's',
      written.promptTokens ? written.promptTokens + ' in' : null,
      written.completionTokens ? written.completionTokens + ' out' : null,
      written.fellBack ? 'fallback model' : null,
    ].filter(Boolean).join(' · ');
  };
  label.textContent = 'Draft from the strategy';
  resumeDraft(button, person, null, show);

  once(button, 'click', async () => {
    button.disabled = true;
    note.textContent = '';
    label.textContent = 'Drafting…';
    try {
      show(await askModel(button, { id: person.id }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      button.disabled = false;
      label.textContent = 'Draft from the strategy';
    }
  });
}

export function renderPerson(person) {
  renderHeader(person);
  renderChapters(person);
  renderHead(person);
  renderNext(person);
  renderDecision(person);
  renderBroughtBy(person);
  renderPlan(person);
  renderThread(person);
  renderCalls(person);
  renderStrategy(person);
  renderRecommendations(person);
  renderQuestions(person);
  renderActivities(person);
  renderSessions(person);
  renderContacts(person);
  renderMatches(person);
  renderIntroductions(person);
  renderTrades(person);
  renderLog(person);
  watchJumps();
}
