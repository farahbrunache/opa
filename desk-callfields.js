import { askModel, el, modelReady, msg, paidButton, post } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';

export const FIELDS = [
  ['trade', 'Job title'],
  ['rate', 'Rate'],
  ['inTheWay', "What's in the way"],
  ['firstCustomer', 'First customer'],
];

export function renderCallFields(person, call) {
  const form = el('form', null, 'box callfields');
  form.noValidate = true;
  const order = call.orderId || person.id;
  const grid = el('div', null, 'grid2');
  form.append(el('span', 'Call lines', 'label'), grid);
  const inputs = {};
  for (const [key, label] of FIELDS) {
    const field = el('div', null, 'field');
    const id = `cf-${call.id}-${key}`;
    const name = el('label', label);
    name.htmlFor = id;
    const input = el('textarea');
    input.id = id;
    input.rows = 2;
    input.maxLength = 300;
    input.value = call.fields?.[key] || '';
    inputs[key] = input;
    field.append(name, input);
    grid.append(field);
  }

  const note = el('p', null, 'faint');
  const actions = el('div', null, 'pair');
  const save = el('button', 'Save', 'btn small');
  save.type = 'submit';
  actions.append(save);

  once(form, 'submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const fields = Object.fromEntries(FIELDS.map(([key]) => [key, inputs[key].value]));
      await post('call-fields', { id: order, call: call.id, fields });
      await settled('Saved the four lines.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      save.disabled = false;
    }
  });

  if (call.transcript) {
    const fill = paidButton('Fill from the call');
    modelReady(fill, person);
    const label = fill.querySelector('.paidlabel');
    const show = (answer) => {
      for (const [key] of FIELDS) {
        if (answer.fields?.[key]) inputs[key].value = answer.fields[key];
      }
      note.textContent = [answer.model, answer.seconds ? `${answer.seconds}s` : null].filter(Boolean).join(' · ');
    };
    resumeDraft(fill, person, `fields:${call.id}`, show);
    once(fill, 'click', async () => {
      fill.disabled = true;
      label.textContent = 'Reading the call…';
      try {
        show(await askModel(fill, { id: order, call: call.id }, 'call-fields-draft'));
      } catch (error) {
        msg('rmsg', error.message, 'bad');
      } finally {
        fill.disabled = false;
        label.textContent = 'Fill from the call';
      }
    });
    actions.append(fill);
  }

  form.append(actions, note);
  return form;
}
