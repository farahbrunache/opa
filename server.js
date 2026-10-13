import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionOf, failure, requestRef } from './lib/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/buy': ['buy.html', 'text/html; charset=utf-8'],
  '/claim': ['claim.html', 'text/html; charset=utf-8'],
  '/money': ['money.html', 'text/html; charset=utf-8'],
  '/questions': ['questions.html', 'text/html; charset=utf-8'],
  '/desk': ['desk.html', 'text/html; charset=utf-8'],
  '/preview': ['index.html', 'text/html; charset=utf-8'],
  '/funnel': ['funnel.html', 'text/html; charset=utf-8'],
  '/ai': ['ai.html', 'text/html; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/client.css': ['client.css', 'text/css; charset=utf-8'],
  '/fonts.css': ['fonts.css', 'text/css; charset=utf-8'],
  '/codefield.js': ['codefield.js', 'text/javascript; charset=utf-8'],
  '/problem.js': ['problem.js', 'text/javascript; charset=utf-8'],
  '/client-ui.js': ['client-ui.js', 'text/javascript; charset=utf-8'],
  '/client-theme.js': ['client-theme.js', 'text/javascript; charset=utf-8'],
  '/client-area.js': ['client-area.js', 'text/javascript; charset=utf-8'],
  '/client-talk.js': ['client-talk.js', 'text/javascript; charset=utf-8'],
  '/client-card.js': ['client-card.js', 'text/javascript; charset=utf-8'],
  '/client-before.js': ['client-before.js', 'text/javascript; charset=utf-8'],
  '/client-sessions.js': ['client-sessions.js', 'text/javascript; charset=utf-8'],
  '/client-source.js': ['client-source.js', 'text/javascript; charset=utf-8'],
  '/claim-call.js': ['claim-call.js', 'text/javascript; charset=utf-8'],
  '/desk-ui.js': ['desk-ui.js', 'text/javascript; charset=utf-8'],
  '/sheet.js': ['lib/sheet.js', 'text/javascript; charset=utf-8'],
  '/questions.js': ['lib/questions.js', 'text/javascript; charset=utf-8'],
  '/desk-record.js': ['desk-record.js', 'text/javascript; charset=utf-8'],
  '/desk-work.js': ['desk-work.js', 'text/javascript; charset=utf-8'],
  '/desk-contacts.js': ['desk-contacts.js', 'text/javascript; charset=utf-8'],
  '/desk-activities.js': ['desk-activities.js', 'text/javascript; charset=utf-8'],
  '/desk-sessions.js': ['desk-sessions.js', 'text/javascript; charset=utf-8'],
  '/desk-recap.js': ['desk-recap.js', 'text/javascript; charset=utf-8'],
  '/desk-thread.js': ['desk-thread.js', 'text/javascript; charset=utf-8'],
  '/desk-questions.js': ['desk-questions.js', 'text/javascript; charset=utf-8'],
  '/desk-trades.js': ['desk-trades.js', 'text/javascript; charset=utf-8'],
  '/desk-skills.js': ['desk-skills.js', 'text/javascript; charset=utf-8'],
  '/desk-callfields.js': ['desk-callfields.js', 'text/javascript; charset=utf-8'],
  '/desk-gaps.js': ['desk-gaps.js', 'text/javascript; charset=utf-8'],
  '/desk-minutes.js': ['desk-minutes.js', 'text/javascript; charset=utf-8'],
  '/desk-after.js': ['desk-after.js', 'text/javascript; charset=utf-8'],
  '/desk-lists.js': ['desk-lists.js', 'text/javascript; charset=utf-8'],
  '/desk-confirm.js': ['desk-confirm.js', 'text/javascript; charset=utf-8'],
  '/desk-top.js': ['desk-top.js', 'text/javascript; charset=utf-8'],
  '/desk-jump.js': ['desk-jump.js', 'text/javascript; charset=utf-8'],
  '/desk-progress.js': ['desk-progress.js', 'text/javascript; charset=utf-8'],
  '/desk-log.js': ['desk-log.js', 'text/javascript; charset=utf-8'],
  '/desk-chapters.js': ['desk-chapters.js', 'text/javascript; charset=utf-8'],
  '/desk-referrals.js': ['desk-referrals.js', 'text/javascript; charset=utf-8'],
  '/desk-matches.js': ['desk-matches.js', 'text/javascript; charset=utf-8'],
  '/desk-calls.js': ['desk-calls.js', 'text/javascript; charset=utf-8'],
  '/desk-roadmap.js': ['desk-roadmap.js', 'text/javascript; charset=utf-8'],
  '/desk-prompts.js': ['desk-prompts.js', 'text/javascript; charset=utf-8'],
  '/money-payments.js': ['money-payments.js', 'text/javascript; charset=utf-8'],
  '/money-speed.js': ['money-speed.js', 'text/javascript; charset=utf-8'],
  '/money-costs.js': ['money-costs.js', 'text/javascript; charset=utf-8'],
  '/money-charges.js': ['money-charges.js', 'text/javascript; charset=utf-8'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
  '/media/link-your-session.mp4': ['media/link-your-session.mp4', 'video/mp4'],
  '/media/link-your-session.jpg': ['media/link-your-session.jpg', 'image/jpeg'],
};

const ENDPOINTS = {
  '/api/submit': () => import('./api/submit.js'),
  '/api/costs': () => import('./api/costs.js'),
  '/api/status': () => import('./api/status.js'),
  '/api/recover': () => import('./api/recover.js'),
  '/api/call': () => import('./api/call.js'),
  '/api/payments': () => import('./api/payments.js'),
  '/api/desk': () => import('./api/desk.js'),
  '/api/auth': () => import('./api/auth.js'),
  '/api/retell': () => import('./api/retell.js'),
  '/api/sweep': () => import('./api/sweep.js'),
  '/api/drafting-bill': () => import('./api/drafting-bill.js'),
  '/api/client': () => import('./api/client.js'),
};

for (const name of readdirSync(join(HERE, 'fonts'))) {
  if (name.endsWith('.woff2')) PAGES[`/fonts/${name}`] = [`fonts/${name}`, 'font/woff2'];
}

const MOVED = {
  '/payments': '/money',
  '/costs': '/money',
};

const NEVER_CACHE = new Set(['/claim', '/money', '/desk', '/preview', '/ai']);

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
}

const MEDIA = new Set(['/media/link-your-session.mp4', '/media/link-your-session.jpg']);

async function page(req, res, pathname) {
  const [file, type] = PAGES[pathname];
  const body = await readFile(join(HERE, file));
  res.setHeader('content-type', type);
  if (pathname.startsWith('/fonts/')) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  if (NEVER_CACHE.has(pathname)) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
  }
  if (MEDIA.has(pathname)) {
    res.setHeader('cache-control', 'public, max-age=604800');
    res.setHeader('accept-ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start > end || start >= body.length) {
        res.statusCode = 416;
        res.setHeader('content-range', `bytes */${body.length}`);
        return res.end('');
      }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
      res.setHeader('content-length', String(end - start + 1));
      return res.end(body.subarray(start, end + 1));
    }
    res.setHeader('content-length', String(body.length));
  }
  res.statusCode = 200;
  res.end(body);
}

export async function route(req, res) {
  const url = new URL(req.url, 'https://placeholder.invalid');
  let pathname = url.pathname.replace(/\/+$/, '') || '/';

  securityHeaders(res);

  if (pathname === '/auth/callback') {
    req.url = `/api/auth?action=callback&${url.searchParams.toString()}`;
    pathname = '/api/auth';
  }

  const asFile = Object.keys(PAGES).find((key) => pathname === `${key}.html`);
  if (asFile) {
    res.statusCode = 308;
    res.setHeader('location', asFile);
    return res.end('');
  }

  if (MOVED[pathname]) {
    res.statusCode = 308;
    res.setHeader('location', MOVED[pathname] + url.search);
    return res.end('');
  }

  if (PAGES[pathname]) return page(req, res, pathname);

  const endpoint = ENDPOINTS[pathname];
  if (endpoint) {
    const handler = (await endpoint()).default;
    return handler(req, res);
  }

  res.statusCode = 404;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(failure(req, 404, `There is nothing at ${pathname}.`)));
}

function log(req, res, pathname) {
  const ref = requestRef(req);
  res.setHeader('x-request-ref', ref);
  res.on('finish', () => {
    const action = actionOf(req);
    console.log(`[one-percent] ${req.method} ${pathname}${action ? ` action=${action}` : ''} ${res.statusCode} ref=${ref}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT) || 3000;
  http
    .createServer((req, res) => {
      log(req, res, new URL(req.url, 'https://placeholder.invalid').pathname);
      route(req, res).catch((error) => {
        console.error(`[one-percent] ref=${requestRef(req)}`, error);
        if (res.writableEnded) return;
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(failure(req, 500, `The request could not be completed: ${error.message}`)));
      });
    })
    .listen(port, () => console.log(`[one-percent] listening on ${port}`));
  import('./lib/db.js')
    .then((db) => db.ensureSchema())
    .then(() => import('./lib/draft-jobs.js'))
    .then((jobs) => jobs.sweep())
    .catch((error) => console.error(`[one-percent] drafts weren't resumed at start: ${error.message}`));
}
