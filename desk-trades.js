import { el, get, link, msg, offWhen, post } from '/desk-ui.js';
import { once, settled, wasBefore } from '/desk-after.js';
import { forgetSkillList, profileSkills, renderSkills } from '/desk-skills.js';

function who(person) {
  return person.name || person.reference;
}

function introduceButton(fromId, other, reason, box) {
  const button = el('button', 'Introduce', 'btn small');
  button.type = 'button';
  once(button, 'click', async () => {
    button.disabled = true;
    try {
      await post('introduce', { id: fromId, reference: other.reference, reason });
      await settled(`Introduced to ${who(other)}.`);
    } catch (error) {
      button.disabled = false;
      msg(box, error.message, 'bad');
    }
  });
  return button;
}

function suggestion(person, other, reason) {
  const row = el('div', null, 'item');
  const head = el('div', null, 'who-head');
  head.append(link(who(other), `/desk?id=${other.id}`, 'name'));
  if (other.isDemo) head.append(el('span', 'Demo', 'tag t-demo'));
  row.append(head);
  row.append(el('div', other.title, 'faint'));
  const actions = el('div', null, 'pair');
  actions.append(introduceButton(person.id, other, reason, 'rmsg'));
  row.append(actions);
  return row;
}

function ownProfile(person) {
  const wrap = el('div', null, 'ownprofile');
  const line = el('p', null, 'faint');
  wrap.append(line);

  const pasteBox = (off = false) => {
    const form = el('form', null, 'stack');
    form.noValidate = true;
    const field = el('div', null, 'field');
    const label = el('label', 'Their Directory profile');
    label.htmlFor = 'ownprofilelink';
    const input = el('input');
    input.id = 'ownprofilelink';
    input.autocomplete = 'off';
    input.placeholder = 'Paste the profile link';
    field.append(label, input);
    const save = el('button', 'Link it', 'btn small');
    save.type = 'submit';
    input.disabled = off;
    if (off) offWhen(save, true, 'Directory not connected');
    const actions = el('div', null, 'pair');
    actions.append(save);
    form.append(field, actions);
    once(form, 'submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await post('own-profile', { id: person.id, link: input.value });
        await settled('Linked their Directory profile.');
      } catch (error) {
        save.disabled = false;
        msg('rmsg', error.message, 'bad');
      }
    });
    return form;
  };

  if (!person.directoryRead) {
    if (person.ownProfileLinked) line.textContent = 'Directory profile linked · Directory not connected';
    else {
      line.remove();
      wrap.append(pasteBox(true));
    }
    return wrap;
  }

  get(`own-profile&id=${encodeURIComponent(person.id)}`).then((found) => {
    if (found.skills?.length) wrap.after(profileSkills(person, found.skills));
    if (!found.jobTitle) {
      line.textContent = 'Their Directory profile has no job title on it.';
      return;
    }
    line.textContent = `Their Directory profile says: ${found.jobTitle}`
      + (found.sector ? `, in ${found.sector}.` : '.');
    if (found.tradeId && found.tradeId !== person.trade?.id) {
      const use = el('button', 'Use it', 'btn small');
      use.type = 'button';
      once(use, 'click', async () => {
        use.disabled = true;
        try {
          await post('trade', { id: person.id, trade: found.tradeId });
          await settled(`Job title set: ${found.jobTitle}.`);
        } catch (error) {
          use.disabled = false;
          msg('rmsg', error.message, 'bad');
        }
      });
      wrap.append(use);
    } else if (!found.tradeId) {
      wrap.append(el('p', 'Not in the copied Skills Taxonomy.', 'faint'));
    }
  }).catch((error) => {
    line.textContent = error.message;
    if (error.status === 404 && !person.ownProfileLinked) wrap.append(pasteBox());
  });
  return wrap;
}

function copyList(said) {
  const wrap = el('div');
  wrap.append(el('p', said, 'faint'));
  const copy = el('button', 'Copy the Skills Taxonomy', 'btn small');
  copy.type = 'button';
  once(copy, 'click', async () => {
    copy.disabled = true;
    try {
      const out = await post('trades-copy', {});
      forgetSkillList();
      await settled(`Copied ${out.titles} job titles and ${out.skills} skills.`);
    } catch (error) {
      copy.disabled = false;
      msg('rmsg', error.message, 'bad');
    }
  });
  wrap.append(copy);
  return wrap;
}

export function renderTrades(person) {
  const box = document.getElementById('jobtitle');
  box.textContent = '';
  const could = document.getElementById('couldwork');
  could.textContent = '';
  document.getElementById('skillcount').textContent = `${(person.skills || []).length} of 10`;

  if (!person.trades.length) {
    box.append(copyList('No Skills Taxonomy copied yet.'));
    return;
  }

  if (person.hasCase) box.append(ownProfile(person));
  renderSkills(person, box, copyList);

  if (!person.trade) {
    could.append(el('p', 'No job title set.', 'faint'));
    return;
  }
  const { sameTrade, sameSector } = person.couldWorkWith;
  if (!sameTrade.length && !sameSector.length) {
    could.append(el('p', 'Nobody to suggest yet.', 'faint'));
    return;
  }
  if (sameTrade.length) {
    could.append(el('h3', `Also ${person.trade.title}`, 'groupname'));
    for (const other of sameTrade) {
      could.append(suggestion(person, other, `Both ${person.trade.title}: overflow work and what to charge.`));
    }
  }
  if (sameSector.length) {
    could.append(el('h3', `Elsewhere in ${person.trade.sector}`, 'groupname'));
    for (const other of sameSector) {
      could.append(suggestion(person, other,
        `${person.trade.title} and ${other.title}, both in ${person.trade.sector}: they can send each other work.`));
    }
  }
}

const PAIRS_SHOWN = 3;

function pairCard(pair) {
  const card = el('li', null, 'pairc');
  const side = (one) => {
    const pp = el('div', null, 'pp');
    pp.append(link(who(one), `/desk?id=${one.id}`), el('span', one.title));
    return pp;
  };
  card.append(side(pair.a), el('span', '+', 'plus'), side(pair.b));
  const reason = pair.a.title === pair.b.title
    ? `Both ${pair.a.title}: overflow work and what to charge.`
    : `${pair.a.title} and ${pair.b.title}, both in ${pair.sector}: they can send each other work.`;
  const actions = el('div', null, 'pact');
  const button = introduceButton(pair.a.id, pair.b, reason, 'qmsg');
  button.className = 'btn';
  const skip = el('button', 'Skip', 'btn ghost');
  skip.type = 'button';
  once(skip, 'click', async () => {
    skip.disabled = true;
    const body = { id: pair.a.id, order: pair.b.id };
    try {
      await post('skip', body);
      await settled(`Skipped ${who(pair.a)} and ${who(pair.b)}.`, wasBefore('unskip', body));
    } catch (error) {
      skip.disabled = false;
      msg('qmsg', error.message, 'bad');
    }
  });
  actions.append(button, skip, el('span', pair.sector, 'muted'));
  if (pair.isDemo) actions.append(el('span', 'Demo', 'tag t-demo'));
  card.append(actions);
  return card;
}

export async function renderPairs() {
  const box = document.getElementById('pairs');
  const more = document.getElementById('morepairs');
  const count = document.getElementById('pairscount');
  box.textContent = '';
  more.hidden = true;
  try {
    const data = await get('pairs');
    count.textContent = `${data.pairs.length} suggested`;
    if (!data.pairs.length) {
      box.append(el('li', 'None.', 'empty'));
      return;
    }
    let shown = 0;
    const showMore = () => {
      for (const pair of data.pairs.slice(shown, shown + PAIRS_SHOWN)) box.append(pairCard(pair));
      shown = Math.min(data.pairs.length, shown + PAIRS_SHOWN);
      more.hidden = shown >= data.pairs.length;
    };
    more.onclick = showMore;
    showMore();
  } catch (error) {
    count.textContent = '';
    box.append(el('li', error.message, 'empty'));
  }
}
