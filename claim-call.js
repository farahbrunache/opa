import { call, localProblem, showProblem } from '/problem.js';

const VOICE_CLIENT = 'https://cdn.jsdelivr.net/npm/retell-client-js-sdk@3.0.1/+esm';

const CALL_MINUTES = 30;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function micIcon(mark) {
  const ring = el('div', mark || null, 'micicon');
  ring.setAttribute('aria-hidden', 'true');
  if (mark) return ring;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3');
  svg.append(path);
  ring.append(svg);
  return ring;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leftLine(status) {
  const n = Number(status.startsLeft ?? 0);
  const starts = `${n} start${n === 1 ? '' : 's'} left in the next 24 hours.`;
  const minutes = Number(status.minutesLeft ?? CALL_MINUTES);
  if (minutes >= CALL_MINUTES) return starts;
  return `${minutes} of ${CALL_MINUTES} minutes left. ${starts}`;
}

function restartLine(status) {
  const minutes = Number(status.minutesLeft ?? CALL_MINUTES);
  const said = minutes >= CALL_MINUTES
    ? 'Your minutes are all still there.'
    : `The minutes you didn't use are still there: ${minutes} of ${CALL_MINUTES}.`;
  const n = Number(status.startsLeft ?? 0);
  return `Start again. ${said} ${n} start${n === 1 ? '' : 's'} left in the next 24 hours.`;
}

function refusal(error) {
  const name = error?.name || '';
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser won't let the page use a microphone at all. Open this link in Safari, "
      + 'Chrome or Firefox, then start again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Plug one in, or open this link on a phone, then start again.';
  }
  if (name === 'NotReadableError') {
    return 'Another app is using the microphone. Close it (a call, a voice memo, a meeting), then '
      + 'start again.';
  }
  if (/system/i.test(error?.message || '')) {
    return "Your device's privacy settings block the microphone for this browser. Open Settings, "
      + 'then Privacy, then Microphone, turn it on for this browser, then start again.';
  }
  return 'This browser is blocking the microphone for this page. Tap the lock or settings icon '
    + 'next to the address, allow the microphone, then start again. On an iPhone, turning off '
    + 'Lockdown Mode for this site is usually what does it.';
}

export function describeFailure(failure, callId) {
  const parts = [];
  const seen = new Set();

  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    const text = typeof value === 'string' ? value : String(value);
    if (!text || text === '[object Object]' || seen.has(text)) return;
    seen.add(text);
    parts.push(label ? `${label}: ${text}` : text);
  };

  if (failure instanceof Error || (failure && typeof failure === 'object')) {
    add(null, failure.message || failure.reason || failure.error || String(failure));
    add('reason', failure.reason);
    add('error', typeof failure.error === 'string' ? failure.error : undefined);
    add('name', failure.name);
    add('code', failure.code);
    add('status', failure.status);
    for (const [key, value] of Object.entries(failure)) {
      if (['message', 'reason', 'error', 'name', 'code', 'status', 'stack'].includes(key)) continue;
      if (value && typeof value === 'object') continue;
      add(key, value);
    }
    let cause = failure.cause;
    for (let depth = 0; cause && depth < 3; depth += 1) {
      add('caused by', cause.message || String(cause));
      cause = cause.cause;
    }
  } else {
    add(null, String(failure));
  }

  if (callId) parts.push(`call ${callId}`);
  parts.push(`client ${VOICE_CLIENT}`);

  console.error('[one-percent] the session failed', failure);

  const said = parts.join(' · ');

  const bare = typeof failure === 'string' || (parts.length <= 2 && !failure?.name);
  return `${said}. If the browser asked for the microphone and it was refused, or there is `
    + 'no microphone on this device, that is what this says.'
    + (bare ? " The reason itself is in the browser's error log, under Error starting call." : '');
}

export function callBox(box, options) {
  const { token, changed, ended } = options;
  let current = options.status;

  function draw(...nodes) {
    box.textContent = '';
    box.append(...nodes);
  }

  function startButton(label = 'Start') {
    const button = el('button', label, 'bigstart');
    button.type = 'button';
    button.addEventListener('click', () => start(button));
    return button;
  }

  function ready() {
    draw(startButton(), el('p', 'Your browser asks for the microphone first.'),
      el('p', leftLine(current), 'cfine'));
  }

  function againButton() {
    const button = el('button', 'Start again', 'cbtn');
    button.type = 'button';
    button.addEventListener('click', () => start(button));
    return button;
  }

  async function refresh() {
    try {
      const fresh = await call(`/api/status?t=${encodeURIComponent(token)}`, {}, 'Checking your order');
      if (fresh.status !== 'confirmed') {
        changed(fresh);
        return false;
      }
      current = fresh;
    } catch {
    }
    return true;
  }

  async function failed(title, said, problem) {
    if (!(await refresh())) return;
    const report = el('div', null, 'msg bad');
    showProblem(report, problem, title);
    report.firstChild.textContent = said;
    draw(el('h3', title), report, el('p', restartLine(current)), againButton());
  }

  async function neverConnected(callId) {
    if (!callId) return;
    await fetch('/api/call?action=abandon', { // quiet: failure already shown
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: token, callId }),
    }).catch((error) => console.error('[one-percent] closing the call that never connected failed', error));
  }

  async function microphone() {
    draw(micIcon(), el('h3', 'Allow the microphone'),
      el('p', 'Choose Allow in the box at the top of the screen.'));
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no getUserMedia');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch (error) {
      const report = el('div', null, 'msg bad');
      showProblem(report, localProblem(refusal(error), 'microphone', error?.name || 'refused'));
      draw(micIcon(), el('h3', "The microphone isn't available."), report, againButton());
      return false;
    }
  }

  async function start(pressed) {
    pressed.disabled = true;
    if (!(await microphone())) return;

    const button = startButton('Starting…');
    button.disabled = true;
    draw(button, el('p', 'Your browser asks for the microphone first.'), el('p', leftLine(current), 'cfine'));

    let data;
    try {
      data = await call('/api/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ t: token }),
      }, 'Starting the call');
    } catch (error) {
      await failed("The call didn't start.", error.message, error);
      return;
    }

    let RetellWebClient;
    try {
      ({ RetellWebClient } = await import(VOICE_CLIENT));
    } catch (error) {
      console.error('[one-percent] the voice client did not load', error);
      await neverConnected(data.callId);
      await failed("The call didn't start.",
        "This browser couldn't load the voice client "
          + `(${error.message}). Try a different browser — Chrome, Safari or Firefox, kept up `
          + 'to date.',
        localProblem('', 'voice_client', error?.name || 'import'));
      return;
    }

    for (const count of [3, 2, 1]) {
      draw(el('p', 'Starting in', 'clabel'), el('div', String(count), 'countnum'),
        el('p', 'The assistant speaks first.'));
      await wait(1000);
    }

    let began = null;
    let over = false;
    let ticking = null;
    const timer = el('div', null, 'timer');
    const showTime = () => {
      timer.textContent = `${clock(began ? (Date.now() - began) / 1000 : 0)} `;
      timer.append(el('small', `/ ${CALL_MINUTES}:00`));
    };
    const client = new RetellWebClient();
    const end = el('button', 'End the call', 'cbtn');
    end.type = 'button';
    end.addEventListener('click', () => {
      end.disabled = true;
      client.stopCall();
    });
    showTime();
    draw(el('span', 'On the call · recorded', 'livedot'), timer,
      el('p', "You have up to 30 minutes, so take your time with each answer."), end);

    const finish = () => {
      over = true;
      clearInterval(ticking);
    };

    client.on('call_started', () => {
      began = Date.now();
      ticking = setInterval(showTime, 1000);
    });
    client.on('call_ended', () => {
      if (over) return;
      finish();
      if (!began) {
        neverConnected(data.callId);
        failed("The call didn't start.", 'The call ended before it connected.',
          localProblem('', 'call_ended', 'before connecting'));
        return;
      }
      draw(micIcon('✓'), el('h3', 'The session has ended.'),
        el('p', 'A person reads everything the call wrote down and writes what to do next. '
          + 'Come back to this link in about 48 hours.'));
      ended();
    });
    client.on('error', (err) => {
      if (over) return;
      finish();
      const at = began ? clock((Date.now() - began) / 1000) : null;
      neverConnected(data.callId);
      failed(at ? `The call dropped at ${at}.` : "The call didn't start.",
        `The session stopped. ${describeFailure(err, data.callId)}`,
        localProblem('', at ? 'call_connection_lost' : 'start_call', err?.name || 'error'));
    });

    try {
      await client.startCall({
        accessToken: data.accessToken,
        callId: data.callId,
        transport: data.transport || undefined,
        iceServers: data.iceServers || undefined,
      });
    } catch (error) {
      if (over) return;
      finish();
      await neverConnected(data.callId);
      await failed("The call didn't start.",
        `The session did not start. ${describeFailure(error, data.callId)}`,
        localProblem('', 'start_call', error?.name || 'error'));
    }
  }

  ready();
}
