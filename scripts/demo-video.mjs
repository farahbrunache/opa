import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'demo-video');
const RAW = join(OUT, 'raw');
const WEBM = join(OUT, 'one-percent-demo.webm');
const MP4 = join(OUT, 'one-percent-demo.mp4');
const POSTER = join(OUT, 'one-percent-demo.jpg');
const SIZE = { width: 390, height: 844 };

const TOKEN = 'DEMO-claim-link-not-a-real-token-0001';
const REFERENCE = 'DEMO7-K4QXN';
const WISETAG = '@demo-wisetag';
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const SHEET = [
  'Sample introduction line.',
  '',
  '1. Sample step A.',
  '2. Sample step B.',
  '3. Sample step C.',
  '',
  'Sample closing line.',
].join('\n');

const state = { stage: 'pending', signedIn: false };

function statusPayload() {
  const base = {
    status: state.stage,
    label: 'Wise',
    method: 'wise',
    amount: 7,
    reference: REFERENCE,
    submitted: hoursAgo(50),
    decided: state.stage === 'pending' ? null : hoursAgo(49),
    recommended: state.stage === 'used',
  };
  if (state.stage === 'pending') return { ...base, payTo: WISETAG };
  if (state.stage === 'confirmed') return { ...base, startsLeft: 3, minutesLeft: 30 };
  return { ...base, calledAt: hoursAgo(48), callSeconds: 21 * 60 };
}

function minePayload() {
  return {
    account: 'demo-account',
    sessions: [{
      reference: REFERENCE,
      approved: true,
      approvedAt: hoursAgo(3),
      paidAt: hoursAgo(50),
      calledAt: hoursAgo(48),
      callSeconds: 21 * 60,
      callKind: 'intake',
      sessionStarts: 1,
      hasCall: true,
      hasTranscript: true,
      recommendations: SHEET,
      recommendedAt: hoursAgo(3),
      stepsDone: [],
    }],
    approved: true,
    firstName: 'Sam',
    firstCustomerAt: null,
    introductions: [],
    path: [],
  };
}

const threadPayload = () => ({
  page: 1,
  perPage: 50,
  total: 1,
  messages: [{
    author: 'opening',
    body: 'What do you make of the recommendations? And would you like help following them through?',
    at: hoursAgo(3),
  }],
});

const SIGN_IN_CARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/client.css">
<style>
  body.client { min-height: 844px; display: flex; align-items: center; background: var(--c-paper); }
  .card { padding: 0 32px; text-align: center; }
  .card h1 { font-family: 'Newsreader', serif; font-size: 30px; line-height: 1.25; color: var(--c-ink); margin: 0 0 18px; }
  .card p { font-size: 20px; color: var(--c-soft); margin: 0; }
</style></head>
<body class="client"><div class="card">
  <h1>Skills Economy sends a sign-in code to your email.</h1>
  <p>No password.</p>
</div></body></html>`;

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function answer(route) {
  const url = new URL(route.request().url());
  const method = route.request().method();
  const action = url.searchParams.get('action');
  const at = new Date().toISOString();
  const refuse = (status, error) => json(route, status, { error, ref: 'demo0000', action, at });

  if (url.pathname === '/api/submit' && method === 'POST') {
    return json(route, 201, {
      claim: `/claim?t=${TOKEN}`, reference: REFERENCE, method: 'wise', label: 'Wise', payTo: WISETAG, needsCode: false,
    });
  }
  if (url.pathname === '/api/status') return json(route, 200, statusPayload());
  if (url.pathname === '/api/auth' && action === 'start') {
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: SIGN_IN_CARD });
  }
  if (url.pathname === '/api/client') {
    if (!state.signedIn) return refuse(401, 'Sign in with Skills Economy first.');
    if (action === 'link' || action === 'mine') return json(route, 200, minePayload());
    if (action === 'thread') return json(route, 200, threadPayload());
    if (action === 'sessions') return json(route, 200, { rates: null, access: null, held: [], request: null, pending: [] });
  }
  return refuse(404, `The demo has no answer for ${method} ${url.pathname}${action ? ` action=${action}` : ''}.`);
}

function linkMask() {
  const LABEL = 'Hidden here. Your link is private to you.';
  const style = () => {
    if (document.getElementById('demo-mask-style')) return;
    const css = document.createElement('style');
    css.id = 'demo-mask-style';
    css.textContent = '[data-demo-mask]{position:relative;display:block;min-height:2.6em;color:transparent!important;'
      + 'text-shadow:0 0 9px rgba(24,38,31,0.55)!important;text-decoration:none!important;'
      + 'user-select:none;pointer-events:none}'
      + '[data-demo-mask]::after{content:attr(data-demo-mask);position:absolute;inset:0;'
      + 'display:flex;align-items:center;justify-content:center;text-align:center;'
      + "color:#18261f;text-shadow:none;font:600 13px/1.25 'DM Sans',system-ui,sans-serif;"
      + 'background:rgba(255,251,243,0.55);border-radius:8px;padding:2px 6px}';
    document.head.append(css);
  };
  const sweep = () => {
    style();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/claim\?t=/.test(node.nodeValue)) continue;
      const holder = node.parentElement;
      if (holder && !holder.closest('[data-demo-mask]') && holder.id !== 'demo-caption') {
        holder.setAttribute('data-demo-mask', LABEL);
      }
    }
  };
  const start = () => {
    sweep();
    new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}

function captionBar() {
  const draw = () => {
    let text = '';
    try { text = sessionStorage.getItem('demo-caption') || ''; } catch { }
    let bar = document.getElementById('demo-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-caption';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
        + 'padding:12px 16px 14px;background:rgba(24,38,31,0.92);color:#f3ecda;'
        + "font:600 16px/1.3 'DM Sans',system-ui,sans-serif;text-align:center;";
      document.body.append(bar);
      document.body.style.paddingBottom = '64px';
    }
    bar.textContent = text;
    bar.hidden = !text;
  };
  window.demoCaption = draw;
  if (document.body) draw();
  else document.addEventListener('DOMContentLoaded', draw);
}

async function caption(page, text) {
  await page.evaluate((line) => {
    try { sessionStorage.setItem('demo-caption', line); } catch { }
    window.demoCaption?.();
  }, text);
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function glide(page, to) {
  const from = await page.evaluate(() => window.scrollY);
  const target = typeof to === 'number' ? to : await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    return node ? node.getBoundingClientRect().top + window.scrollY - 24 : window.scrollY;
  }, to);
  const steps = 30;
  for (let i = 1; i <= steps; i += 1) {
    const y = from + ((target - from) * i) / steps;
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await pause(30);
  }
}

async function expectText(page, step, text) {
  try {
    await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    throw new Error(`Step "${step}": the screen at ${page.url()} doesn't show "${text}". `
      + 'A client screen changed; update scripts/demo-video.mjs to match it.');
  }
}

const marks = { started: 0, end: 0, closed: 0 };
const now = () => (Date.now() - marks.started) / 1000;

async function walk(page, base) {
  await page.goto(`${base}/buy`);
  await caption(page, 'Pick how to pay');
  await expectText(page, 'pay', 'How would you like to pay?');
  await pause(2500);
  await glide(page, '#buy');
  await pause(1500);
  await page.click('[data-pay="wise"]');
  await expectText(page, 'pay', 'Send $7 on Wise to that name.');
  await pause(3000);
  await page.click('#go');
  await expectText(page, 'pay', 'Paste this 10-character code into the note');
  await expectText(page, 'pay', REFERENCE);
  await caption(page, 'Your reference and your private link');
  await pause(3000);
  await glide(page, (await page.evaluate(() => window.scrollY)) + 320);
  await pause(2500);
  await page.getByRole('button', { name: 'Open my order' }).click();

  await page.waitForURL(/\/claim\?t=/);
  await caption(page, 'Send $7 on Wise with the reference in the note');
  await expectText(page, 'waiting', 'Pay $7 on Wise to book your call.');
  await expectText(page, 'waiting', REFERENCE);
  await pause(3000);
  await glide(page, 420);
  await expectText(page, 'waiting', 'Waiting for $7 with this reference');
  await pause(2500);

  state.stage = 'confirmed';
  await caption(page, 'Once the $7 is matched, the call is ready');
  await page.goto(page.url());
  await expectText(page, 'ready', 'Your call is ready.');
  await pause(2500);
  await glide(page, '.callbox');
  await expectText(page, 'ready', 'Your browser asks for the microphone first.');
  await pause(3000);

  state.stage = 'used';
  await caption(page, "Sign in so you don't have to keep the link");
  await page.goto(page.url());
  await expectText(page, 'after the call', 'Your next steps are written.');
  await pause(3000);
  await glide(page, '.cvideo');
  await pause(2000);
  await glide(page, '.sessmini');
  await pause(1500);

  await page.getByRole('link', { name: 'Sign in with Skills Economy' }).first().click();
  await page.waitForURL(/\/api\/auth/);
  await caption(page, '');
  await expectText(page, 'sign-in card', 'Skills Economy sends a sign-in code to your email.');
  await pause(3200);

  state.signedIn = true;
  await page.goto(`${base}/claim?t=${TOKEN}&in=1`);
  await page.waitForURL(`${base}/`);
  await caption(page, 'Your session is on your account now');
  await expectText(page, 'signed in', 'Sam, your plan is underway.');
  await pause(500);
  await page.screenshot({ path: POSTER, type: 'jpeg', quality: 70 });
  await pause(3000);
  await glide(page, '#c-plan');
  await expectText(page, 'signed in', 'Your next steps');
  await pause(3000);
  await glide(page, '#c-sessions');
  await expectText(page, 'signed in', 'Your sessions');
  await expectText(page, 'signed in', '1 on this account');
  await pause(3500);
  marks.end = now();
}

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  process.env.NODE_ENV = 'test';
  const { route } = await import('../server.js');
  const server = http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (res.writableEnded) return;
      res.statusCode = 404;
      res.end('');
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy
    ? { args: [`--proxy-server=https=${proxy.replace(/^https?:\/\//, '')}`] }
    : {});
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: Boolean(proxy),
    recordVideo: { dir: RAW, size: { width: SIZE.width * 2, height: SIZE.height * 2 } },
  });
  await context.addInitScript(captionBar);
  await context.addInitScript(linkMask);
  await context.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
  await context.route(`${base}/api/**`, answer);

  const page = await context.newPage();
  marks.started = Date.now();
  let failed = null;
  try {
    await walk(page, base);
  } catch (error) {
    failed = error;
  }
  await context.close();
  marks.closed = now();
  await browser.close();
  server.close();

  if (failed) {
    console.error(`The demo video wasn't made. ${failed.message}`);
    process.exit(1);
  }

  const [recorded] = readdirSync(RAW).filter((f) => f.endsWith('.webm'));
  renameSync(join(RAW, recorded), WEBM);
  rmSync(RAW, { recursive: true, force: true });
  console.log(`Video: ${WEBM}`);
  console.log(`Still: ${POSTER}`);

  if (hasFfmpeg()) {
    const length = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', WEBM]).toString());
    const keep = (length - (marks.closed - marks.end)).toFixed(2);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', WEBM, '-t', keep, '-c:v', 'libx264',
      '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', MP4],
    { stdio: 'inherit' });
    console.log(`Video: ${MP4}`);
  } else {
    console.log('No ffmpeg on this machine, so there is no .mp4. The .webm plays in a browser.');
  }
}

await main();
