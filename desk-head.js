import { el, link, msg, post, weekday } from '/desk-ui.js';
import { once, settled } from '/desk-after.js';

function press(label, action, body, said) {
  const button = el('button', label, 'btn small');
  button.type = 'button';
  once(button, 'click', async () => {
    button.disabled = true;
    try {
      await post(action, body);
      await settled(said);
    } catch (error) {
      button.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  return button;
}

function renderOrders(person) {
  const box = document.getElementById('orders');
  const head = document.getElementById('ordershead');
  box.textContent = '';
  if (!person.linkedCase) {
    head.textContent = 'Sessions bought · no account linked';
    return;
  }
  head.textContent = `Sessions bought · ${person.orders.length}`;
  for (const order of person.orders) {
    const item = el('div', null, 'item');
    const top = el('div', null, 'line');
    top.append(el('span', order.reference, 'mono'));
    top.append(el('span', order.calledAt ? weekday(order.calledAt) : 'No call came back', 'muted'));
    item.append(top);
    const bottom = el('div', null, 'line');
    const state = el('span');
    if (order.decision) {
      state.append(el('span', order.decision === 'go' ? 'Go' : 'No-go',
        `tag ${order.decision === 'go' ? 't-go' : 't-owe'}`), ' ');
    }
    const said = [order.thisOne ? 'This session' : null,
      order.recommendedAt ? `Next steps sent ${weekday(order.recommendedAt)}` : 'Next steps not written'];
    state.append(el('span', said.filter(Boolean).join(' · '), 'muted'));
    bottom.append(state);
    if (!order.thisOne) bottom.append(link('Open', `/desk?id=${order.id}`, 'btn small'));
    item.append(bottom);
    box.append(item);
  }
}

function renderStanding(person) {
  const why = document.getElementById('statewhy');
  const row = document.getElementById('caseacts');
  const form = document.getElementById('blockform');
  row.textContent = '';
  form.hidden = true;

  const lines = [];
  let block;
  if (person.blocker) {
    lines.push(`Waiting on: ${person.blocker.replace(/[.\s]+$/, '')}.`);
    lines.push(person.blockedUntil ? `Back ${weekday(person.blockedUntil)}.` : 'Back after a week.');
    block = press('Unblock', 'unblock', { id: person.id }, 'Unblocked.');
  } else {
    block = el('button', 'Blocked', 'btn');
    block.type = 'button';
    once(block, 'click', () => {
      form.hidden = false;
      document.getElementById('blockreason').focus();
    });
  }
  if (person.closedAt) lines.push(`Closed ${weekday(person.closedAt)}.`);
  const close = press(person.closedAt ? 'Open again' : 'Close', 'close', { id: person.id },
    person.closedAt ? 'Opened again.' : 'Closed.');
  for (const button of [block, close]) {
    button.className = 'btn';
    row.append(button);
  }
  why.textContent = lines.join(' ');
  why.hidden = !lines.length;

  once(form, 'submit', async (event) => {
    event.preventDefault();
    try {
      await post('block', {
        id: person.id,
        reason: document.getElementById('blockreason').value,
        until: document.getElementById('blockuntil').value || null,
      });
      await settled('Blocked.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });
}

const asking = { personId: null, open: false };

function renderWhose(person) {
  if (asking.personId !== person.id) Object.assign(asking, { personId: person.id, open: false });
  const why = document.getElementById('minewhy');
  const said = document.getElementById('minesaid');
  const actions = document.getElementById('mine');
  const confirm = document.getElementById('mineconfirm');
  actions.textContent = '';
  said.hidden = true;
  confirm.hidden = true;
  if (person.isDemo || person.isMine) {
    why.textContent = person.isDemo ? 'Demo' : 'Yours';
    if (person.isMine) {
      said.textContent = 'Marked as yours. It stays out of your counts.';
      said.hidden = false;
    }
    return;
  }
  why.textContent = "A client's";
  if (asking.open) {
    document.getElementById('mineask').textContent =
      `Mark ${person.reference || 'this session'} as yours? This can't be undone.`;
    confirm.hidden = false;
  } else {
    const button = el('button', 'This one is mine', 'btn ghost small');
    button.type = 'button';
    once(button, 'click', () => {
      asking.open = true;
      renderWhose(person);
    });
    actions.append(button);
  }
  const yes = document.getElementById('mineyes');
  yes.onclick = async () => {
    yes.disabled = true;
    try {
      await post('mine', { id: person.id });
      asking.open = false;
      await settled('Marked as yours.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      yes.disabled = false;
    }
  };
  document.getElementById('mineno').onclick = () => {
    asking.open = false;
    renderWhose(person);
  };
}

export function renderHead(person) {
  renderOrders(person);
  renderStanding(person);
  renderWhose(person);
}
