import { el, msg, post } from '/desk-ui.js';

export function renderPrompts(data) {
  const list = document.getElementById('promptlist');
  list.textContent = '';
  const prompts = data.prompts || [];
  const count = () => {
    document.getElementById('promptcount').textContent =
      `${prompts.filter((p) => p.text).length} of ${prompts.length} set`;
  };
  count();
  for (const item of prompts) {
    const form = el('form', null, 'stack');
    form.noValidate = true;
    const id = `prompt-${item.name}`;
    const label = el('label', item.name, 'label');
    label.htmlFor = id;
    const state = el('span', item.text ? '' : 'Not set', 'muted');
    const head = el('div', null, 'sechead');
    head.append(label, state);
    const box = el('textarea');
    box.id = id;
    box.rows = 8;
    box.maxLength = 20000;
    box.value = item.text;
    const save = el('button', 'Save', 'btn primary');
    save.type = 'submit';
    const row = el('div', null, 'pair');
    row.append(save);
    form.append(head, box, row);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await post('prompt', { name: item.name, text: box.value });
        item.text = box.value;
        state.textContent = 'Saved';
        count();
      } catch (error) {
        msg('pmsg', error.message, 'bad');
      } finally {
        save.disabled = false;
      }
    });
    list.append(form);
  }
}
