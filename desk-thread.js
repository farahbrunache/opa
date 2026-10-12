import { askModel, el, link, modelReady, mpage, msg, post, stamp } from '/desk-ui.js';
import { once, resumeDraft, settled } from '/desk-after.js';
import { openPivot } from '/desk-chapters.js';

const QUICK = {
  me: [
    ['Working on it', "I'm going through your call now. Your next steps will reach you this week."],
    ['Answer', "Here's what I'd do first: "],
  ],
  auto: [
    ['Reviewed', 'Farah reviewed your last message.'],
    ['Searching', 'Farah is searching for collaboration matches. Please allow 48 hours for a response.'],
  ],
};

const compose = { mode: 'me', fromTemplate: false, questions: [] };

let afterAsking = () => {};
export function whenAsked(fn) {
  afterAsking = fn;
}

export function askInMessage(questions) {
  const input = document.getElementById('replybody');
  const lines = questions.map((q) => `• ${q.body}`);
  const lead = 'A few questions before the next step:';
  input.value = input.value.trim()
    ? `${input.value.trimEnd()}\n\n${lines.join('\n')}`
    : `${lead}\n${lines.join('\n')}`;
  compose.questions = [...new Set([...compose.questions, ...questions.filter((q) => q.id)])];
  setMode('me');
  document.getElementById('messages').scrollIntoView({ behavior: 'smooth' });
  input.focus({ preventScroll: true });
}

export function sendInMessage(activities) {
  const input = document.getElementById('replybody');
  const lines = activities.map((a) => `• ${a.title}`);
  input.value = input.value.trim()
    ? `${input.value.trimEnd()}\n\n${lines.join('\n')}`
    : `New on your roadmap:\n${lines.join('\n')}`;
  setMode('me');
  document.getElementById('messages').scrollIntoView({ behavior: 'smooth' });
  input.focus({ preventScroll: true });
}

function setMode(mode) {
  compose.mode = mode;
  for (const half of document.querySelectorAll('#sendmode [data-mode]')) {
    half.setAttribute('aria-pressed', String(half.dataset.mode === mode));
  }
  const input = document.getElementById('replybody');
  input.maxLength = mode === 'auto' ? 300 : 4000;
  input.placeholder = mode === 'auto' ? 'A line of status' : 'Write to them';
  const quick = document.getElementById('quick');
  quick.textContent = '';
  for (const [name, text] of QUICK[mode]) {
    const chip = el('button', mode === 'me' ? `Template: ${name}` : name, 'chip');
    chip.type = 'button';
    once(chip, 'click', () => {
      input.value = text;
      compose.fromTemplate = mode === 'me';
      input.focus();
    });
    quick.append(chip);
  }
}

function renderThreadPager(person) {
  const box = document.getElementById('threadpager');
  box.textContent = '';
  const total = person.messageCount;
  const perPage = person.messagesPerPage;
  const at = person.messagePage;
  const last = Math.max(1, Math.ceil(total / perPage));
  box.hidden = total <= perPage;
  if (box.hidden) return;
  const to = (n) => {
    const url = new URL(window.location.href);
    url.searchParams.set('mpage', String(n));
    return url.pathname + url.search;
  };
  if (at > 1) box.append(link('Older', to(at - 1), 'btn small'));
  box.append(el('span', `Page ${at} of ${last}`, 'faint'));
  if (at < last) box.append(link('Newer', to(at + 1), 'btn small'));
}

function pivotLine(chapter, before) {
  const line = el('div', null, 'pivline');
  const by = chapter.startedBy === 'them' ? 'they asked' : null;
  line.append(el('span', `Pivot · Chapter ${chapter.number} starts`));
  line.append(el('p', `${before.name || `Chapter ${before.number}`} → ${chapter.name || `Chapter ${chapter.number}`}`));
  line.append(el('time', [stamp(chapter.startedAt), by].filter(Boolean).join(' · ')));
  return line;
}

const fold = { personId: null, open: false };

function bubble(message, waitingSince, them) {
  if (message.author === 'opening') {
    const box = el('div', null, 'opening');
    box.append(el('span', 'Opening line · scripted'), el('p', message.body), el('time', stamp(message.at)));
    return box;
  }
  if (message.author === 'auto') {
    const note = el('div', null, 'sys');
    note.append(el('span', 'Auto update'), el('p', message.body), el('time', stamp(message.at)));
    return note;
  }
  const theirs = message.author === 'client';
  const unread = theirs && waitingSince !== null && new Date(message.at) > waitingSince;
  const box = el('div', null, `msg ${theirs ? 'them' : 'me'}${unread ? ' unread' : ''}`);
  const who = el('span', theirs ? them : 'You', 'who2');
  if (unread) who.append(el('span', 'New', 'tag t-msg'));
  if (message.fromTemplate) who.append(el('em', 'from template · only you see this', 'priv'));
  box.append(who, el('p', message.body), el('time', stamp(message.at)));
  return box;
}

export function renderThread(person) {
  const list = document.getElementById('thread');
  const note = document.getElementById('threadnote');
  const form = document.getElementById('reply');
  list.textContent = '';

  if (!person.conversationOpen) {
    note.textContent = person.decision === 'no-go' ? 'Closed: no-go' : 'Opens on a go';
    form.hidden = true;
    list.hidden = true;
    document.getElementById('threadpager').hidden = true;
    return;
  }
  list.hidden = false;
  form.hidden = false;
  const ours = person.messages.filter((m) => m.author !== 'client').map((m) => new Date(m.at));
  const waitingSince = person.awaitingReply
    ? (ours.length ? new Date(Math.max(...ours)) : new Date(0)) : null;
  note.textContent = waitingSince ? ''
    : !person.linked ? "No account linked · they can't reply"
    : `Open since ${stamp(person.approvedAt).split(' · ')[0]}`;
  if (waitingSince) note.append(el('span', 'Waiting on you', 'tag t-msg'));

  if (!person.messages.length) list.append(el('p', 'Nothing said yet.', 'empty'));
  const opening = person.messages.filter((m) => m.author === 'opening');
  const ordered = [...opening, ...person.messages.filter((m) => m.author !== 'opening')];

  if (fold.personId !== person.id) Object.assign(fold, { personId: person.id, open: false });
  const chapters = person.chapters || [];
  const now = chapters[chapters.length - 1] || null;
  const earlier = (m) => now && now.number > 1 && new Date(m.at) < new Date(now.startedAt)
    && String(m.id) !== String(now.fromMessageId);
  const folded = ordered.filter(earlier).length;
  if (folded) {
    const from = [...new Set(chapters.filter((c) => c.number < now.number).map((c) => c.number))];
    const which = from.length === 1 ? `Chapter ${from[0]}` : 'earlier chapters';
    const toggle = el('button', fold.open ? `Hide ${which} messages`
      : `Show ${folded} ${folded === 1 ? 'message' : 'messages'} from ${which}`, 'earlier');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      fold.open = !fold.open;
      renderThread(person);
    });
    list.append(toggle);
  }
  const lines = chapters.slice(1);
  let shown = 0;
  const atLastPage = person.messagePage >= Math.ceil(person.messageCount / person.messagesPerPage);
  const first = ordered.length ? new Date(ordered[0].at) : null;
  for (const message of ordered) {
    while (shown < lines.length && new Date(lines[shown].startedAt) <= new Date(message.at)) {
      if (first && new Date(lines[shown].startedAt) >= first) list.append(pivotLine(lines[shown], chapters[shown]));
      shown += 1;
    }
    const row = bubble(message, waitingSince, person.name ? person.name.split(/\s+/)[0] : 'Them');
    if (earlier(message)) {
      row.classList.add('oldmsg');
      row.hidden = !fold.open;
    }
    if (message.author === 'client' && now) {
      const start = el('button', 'Start a pivot from this message', 'msgact');
      start.type = 'button';
      start.addEventListener('click', () => openPivot(person, { messageId: message.id, body: message.body }));
      row.append(start);
    }
    list.append(row);
  }
  if (atLastPage) {
    for (; shown < lines.length; shown += 1) list.append(pivotLine(lines[shown], chapters[shown]));
  }
  list.scrollTop = list.scrollHeight;

  renderThreadPager(person);
  for (const half of document.querySelectorAll('#sendmode [data-mode]')) {
    once(half, 'click', () => {
      if (half.dataset.mode !== compose.mode) compose.fromTemplate = false;
      setMode(half.dataset.mode);
    });
  }
  setMode(compose.mode);

  once(form, 'submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('replybody');
    const text = input.value;
    const asked = compose.mode === 'me'
      ? compose.questions.filter((q) => text.includes(q.body)).map((q) => q.id) : [];
    try {
      const out = await post('reply', {
        id: person.id,
        body: text,
        mode: compose.mode === 'auto' ? 'auto' : undefined,
        fromTemplate: compose.fromTemplate || undefined,
        questions: asked.length ? asked : undefined,
      });
      input.value = '';
      compose.fromTemplate = false;
      compose.questions = [];
      afterAsking(asked);
      if (mpage) {
        const back = new URL(window.location.href);
        back.searchParams.delete('mpage');
        window.location.replace(back);
        return;
      }
      await settled(out.asked ? `Sent, with ${out.asked} question${out.asked === 1 ? '' : 's'} asked.` : 'Sent.');
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    }
  });

  renderReplyDrafting(person);
}

function renderReplyDrafting(person) {
  const button = document.getElementById('draftreply');
  const label = button.querySelector('.paidlabel');
  const note = document.getElementById('replydraftnote');
  modelReady(button, person);
  const show = (written) => {
    const input = document.getElementById('replybody');
    input.value = written.content;
    compose.fromTemplate = false;
    setMode('me');
    input.focus();
    note.textContent = [written.model, written.seconds + 's'].filter(Boolean).join(' · ');
  };
  label.textContent = 'Draft a reply';
  resumeDraft(button, person, 'reply', show);
  once(button, 'click', async () => {
    button.disabled = true;
    note.textContent = '';
    label.textContent = 'Drafting…';
    try {
      show(await askModel(button, { id: person.id, of: 'reply' }));
    } catch (error) {
      msg('rmsg', error.message, 'bad');
    } finally {
      button.disabled = false;
      label.textContent = 'Draft a reply';
    }
  });
}
