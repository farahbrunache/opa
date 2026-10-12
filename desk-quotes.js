import { askModel, el, modelReady, msg, paidButton, post, money, weekday } from '/desk-ui.js';
import { once, resumeDraft, settled, wasBefore } from '/desk-after.js';
import { renderQuotePayment } from '/desk-payments.js';
import { QUOTE_TERMS } from '/quote-terms.js';

const MAX_OPEN_QUOTES = 3;
const DAY = 24 * 3_600_000;

const countering = { personId: null, quoteId: null, person: null };

const dollars = (value) => `$${Number(value) % 1 ? Number(value).toFixed(2) : Number(value)}`;
const daysBetween = (from, to) => Math.max(1, Math.floor((new Date(to) - new Date(from)) / DAY));

function datesOf(quote) {
  const parts = [`Sent ${weekday(quote.writtenAt)}`];
  const said = { agreed: 'accepted', paid: 'accepted', declined: 'declined', 'changes asked': 'change asked' };
  if (quote.answeredAt && said[quote.status]) parts.push(`${said[quote.status]} ${weekday(quote.answeredAt)}`);
  if (quote.dueAt) parts.push(`due ${weekday(quote.dueAt)}`);
  if (quote.status === 'withdrawn') parts.push(`withdrawn ${weekday(quote.movedAt)}`);
  return parts.join(' · ');
}

function flagsOf(person, quote) {
  const who = person.name ? person.name.split(/\s+/)[0] : 'them';
  const flags = [];
  const status = {
    offered: [`Waiting on ${who}`, 'wait'], 'changes asked': ['Change asked', null],
    agreed: ['Accepted', null], declined: ['Declined', 'late'], withdrawn: ['Withdrawn', null],
  }[quote.status];
  if (status && !quote.paidAt) flags.push(status);
  if (quote.paidAt) flags.push([`Paid ${weekday(quote.paidAt)}`, 'paid']);
  if (quote.late) {
    const n = daysBetween(quote.dueAt, Date.now());
    flags.push([`Late ${n} day${n === 1 ? '' : 's'}`, 'late']);
  }
  if (quote.paidAt && quote.dueAt && new Date(quote.paidAt) > new Date(quote.dueAt)) {
    const n = daysBetween(quote.dueAt, quote.paidAt);
    flags.push([`${n} day${n === 1 ? '' : 's'} late`, 'late']);
  }
  if (quote.paidAt && quote.paid < quote.amount) {
    flags.push([`${dollars(quote.amount - quote.paid)} off ${dollars(quote.amount)}`, 'disc']);
  }
  if (quote.untracked) flags.push(['No work tracked', 'late']);
  const row = el('div', null, 'flags');
  for (const [text, tone] of flags) row.append(el('span', text, tone ? `flag ${tone}` : 'flag'));
  return row;
}

function wordingOf(quote) {
  if (quote.agreedTerms) return el('p', `They agreed to: "${quote.agreedTerms}"`, 'agreed');
  if (['agreed', 'paid'].includes(quote.status)) return null;
  return el('p', `They ${quote.status === 'offered' ? 'see' : 'saw'}: "${QUOTE_TERMS}"`, 'agreed');
}

function field(id, label, input) {
  const wrap = el('div', null, 'field');
  const name = el('label', label);
  name.htmlFor = id;
  input.id = id;
  wrap.append(name, input);
  return wrap;
}

function counterForm(person, quote) {
  const form = el('form', null, 'stack');
  form.noValidate = true;
  const amount = el('input');
  amount.type = 'number';
  amount.inputMode = 'decimal';
  amount.min = '1';
  amount.step = '0.01';
  amount.value = String(quote.amount);
  const scope = el('textarea');
  scope.rows = 2;
  scope.maxLength = 2000;
  scope.value = quote.scope;
  const grid = el('div', null, 'grid2');
  grid.append(field(`counteramount-${quote.id}`, 'New amount', amount),
    field(`counterscope-${quote.id}`, 'What it covers', scope));
  const pair = el('div', null, 'pair');
  const send = el('button', 'Send the counter', 'btn primary small');
  send.type = 'submit';
  const cancel = el('button', 'Cancel', 'btn ghost small');
  cancel.type = 'button';
  once(cancel, 'click', () => {
    countering.quoteId = null;
    renderQuotes(person);
  });
  pair.append(send, cancel);
  form.append(grid, pair);
  once(form, 'submit', async (event) => {
    event.preventDefault();
    send.disabled = true;
    try {
      await post('quote', { id: person.id, amount: amount.value, scope: scope.value, replaces: quote.id });
      countering.quoteId = null;
      await settled('Counter sent.');
    } catch (error) {
      send.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return form;
}

function moves(person, quote) {
  const pair = el('div', null, 'pair');
  if (quote.status === 'changes asked' && countering.quoteId !== quote.id) {
    const counter = el('button', 'Counter it', 'btn primary small');
    counter.type = 'button';
    once(counter, 'click', () => {
      countering.quoteId = quote.id;
      renderQuotes(person);
    });
    pair.append(counter);
  }
  if (['offered', 'agreed', 'changes asked'].includes(quote.status)) {
    for (const [status, label] of [['paid', 'Mark paid'], ['withdrawn', 'Withdraw']]) {
      const button = el('button', label, 'btn ghost small');
      button.type = 'button';
      once(button, 'click', async () => {
        button.disabled = true;
        try {
          await post('quote-move', { id: person.id, quoteId: quote.id, status });
          await settled(`Quote ${status}.`,
            wasBefore('quote-move', { id: person.id, quoteId: quote.id, status: quote.status }));
        } catch (error) {
          button.disabled = false;
          msg('rmsg', error.message, 'bad');
        }
      });
      pair.append(button);
    }
  }
  return pair;
}

function card(person, quote) {
  const item = el('article', null, 'quote');
  const top = el('div', null, 'qtop');
  const what = el('div', null, 'stack tight');
  what.append(el('b', quote.scope, 'wrapline'), el('span', datesOf(quote), 'faint'));
  top.append(el('span', dollars(quote.amount), 'qamt'), what);
  item.append(top, flagsOf(person, quote));
  if (quote.reason) item.append(el('p', quote.reason, 'theirnote'));
  const wording = wordingOf(quote);
  if (wording) item.append(wording);
  renderQuotePayment(person, quote, item);
  item.append(moves(person, quote));
  if (countering.quoteId === quote.id) item.append(counterForm(person, quote));
  return item;
}

function floorLine(person) {
  const floor = document.getElementById('breakeven');
  const b = person.breakEven;
  floor.textContent = !b
    ? ''
    : b.breakEven > 0
      ? `Break-even ${money(b.breakEven)}: ${money(b.theirs)} spent on them`
        + `${b.share ? `, plus ${money(b.share)} of running the project` : ''}`
        + `, less ${money(b.coveredBySession)} from their session.`
      : 'Their session already covered what they cost.';
  if (b && !b.monthlyKnown) floor.textContent += ' No monthly costs listed.';
  floor.hidden = !floor.textContent;
}

function worthButton(person) {
  const worth = document.getElementById('worth');
  const said = document.getElementById('worthsaid');
  for (const old of worth.querySelectorAll('.paid')) old.remove();
  said.textContent = '';
  if (!person.calls.some((call) => call.transcript)) return;
  const ask = paidButton("What's it worth to them?");
  modelReady(ask, person);
  const label = ask.querySelector('.paidlabel');
  const show = (answer) => {
    said.textContent = answer.content;
    label.textContent = 'Read it again';
  };
  resumeDraft(ask, person, 'quote', show, true);
  once(ask, 'click', async () => {
    ask.disabled = true;
    label.textContent = 'Reading the call…';
    try {
      show(await askModel(ask, { id: person.id }, 'quote-worth'));
    } catch (error) {
      said.textContent = '';
      msg('rmsg', error.message, 'bad');
    } finally {
      ask.disabled = false;
      if (label.textContent === 'Reading the call…') label.textContent = "What's it worth to them?";
    }
  });
  worth.append(ask);
}

export function renderQuotes(person) {
  if (countering.personId !== person.id) Object.assign(countering, { personId: person.id, quoteId: null });
  countering.person = person;
  const list = document.getElementById('quotelist');
  const note = document.getElementById('quotenote');
  const form = document.getElementById('writequote');
  list.textContent = '';
  if (!person.linked) {
    note.textContent = 'No account linked';
    form.hidden = true;
    return;
  }
  const open = person.quotes.filter((q) => q.status === 'offered').length;
  const paid = person.quotes.filter((q) => q.paidAt).length;
  note.textContent = [person.decision === 'no-go' ? 'No-go' : null,
    `${open} of ${MAX_OPEN_QUOTES} waiting`, paid ? `${paid} paid` : null].filter(Boolean).join(' · ');
  form.hidden = MAX_OPEN_QUOTES - open <= 0;
  floorLine(person);
  worthButton(person);

  if (!person.quotes.length) list.append(el('p', 'Nothing quoted yet.', 'empty'));
  for (const quote of person.quotes) list.append(card(person, quote));

  once(form, 'submit', async (event) => {
    event.preventDefault();
    const amount = document.getElementById('amount').value;
    const { person: now } = countering;
    if (now.decision === 'no-go'
      && !window.confirm(`This person was a no-go. Write them a quote for $${amount}?`)) {
      return;
    }
    try {
      await post('quote', { id: now.id, amount, scope: document.getElementById('scope').value });
      document.getElementById('amount').value = '';
      document.getElementById('scope').value = '';
      await settled('Quote written.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}
