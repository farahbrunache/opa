import { el, msg, post, weekday } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';

function dueForm(person, quote) {
  const form = el('form', null, 'stack');

  const field = el('div', null, 'field');
  const label = el('label', 'Due (optional)');
  const input = el('input');
  input.type = 'date';
  input.id = `quotedue-${quote.id}`;
  if (quote.dueAt) input.value = String(quote.dueAt).slice(0, 10);
  label.htmlFor = input.id;
  field.append(label, input);

  const actions = el('div', null, 'pair');
  const save = el('button', 'Set the date', 'btn small');
  save.type = 'submit';
  actions.append(save);

  form.append(field, actions);
  once(form, 'submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const was = quote.dueAt ? String(quote.dueAt).slice(0, 10) : '';
      await post('quote-due', { id: person.id, quoteId: quote.id, dueAt: input.value });
      await settled(input.value ? `Due ${weekday(`${input.value}T12:00`)}.` : 'No date on it now.',
        wasBefore('quote-due', { id: person.id, quoteId: quote.id, dueAt: was }));
    } catch (error) {
      save.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return form;
}

function paidForm(person, quote) {
  const form = el('form', null, 'stack');

  const amountField = el('div', null, 'field');
  const amountLabel = el('label', 'What actually arrived, in dollars');
  const amount = el('input');
  amount.type = 'number';
  amount.inputMode = 'decimal';
  amount.min = '0';
  amount.step = 'any';
  amount.id = `quotepaid-${quote.id}`;
  amount.value = String(quote.amount);
  amountLabel.htmlFor = amount.id;
  amountField.append(amountLabel, amount);

  const whenField = el('div', null, 'field');
  const whenLabel = el('label', 'When (empty is today)');
  const at = el('input');
  at.type = 'date';
  at.id = `quotepaidat-${quote.id}`;
  whenLabel.htmlFor = at.id;
  whenField.append(whenLabel, at);

  const whyField = el('div', null, 'field');
  const whyLabel = el('label', 'Why less than quoted');
  const why = el('input');
  why.type = 'text';
  why.maxLength = 500;
  why.autocomplete = 'off';
  why.id = `quotediscount-${quote.id}`;
  whyLabel.htmlFor = why.id;
  whyField.append(whyLabel, why);

  const actions = el('div', null, 'pair');
  const save = el('button', 'Write down what arrived', 'btn small');
  save.type = 'submit';
  actions.append(save);

  form.append(amountField, whenField, whyField, actions);
  once(form, 'submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await post('quote-paid', {
        id: person.id,
        quoteId: quote.id,
        amount: amount.value,
        at: at.value,
        discount: why.value,
      });
      await settled('Payment recorded.');
    } catch (error) {
      save.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return form;
}

export function renderQuotePayment(person, quote, into) {
  if (quote.discount) into.append(el('p', quote.discount, 'muted'));
  if (quote.status === 'agreed' && !quote.paidAt) {
    into.append(dueForm(person, quote));
    into.append(paidForm(person, quote));
  }
}
