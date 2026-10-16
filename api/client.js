import { caseForAccount, ensureSchema, findByClaimTokenHash, sql } from '../lib/db.js';
import { underLimit } from '../lib/settings.js';
import { callerKey, decrypt, encrypt, keyedHash } from '../lib/crypto.js';
import { NAME_COOKIE, requireAccount } from '../lib/auth.js';
import { describeStatus } from '../lib/orders.js';
import { HttpError, handle, readCookie, readJson, send } from '../lib/http.js';
import { tickActivity } from '../lib/client-page.js';
import { cardView, requireClient, sessionsView, threadView } from '../lib/client-view.js';
import { syncStepsFor } from '../lib/chapter-steps.js';
import { requestAccess } from '../lib/sessions.js';

async function mine(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  send(res, 200, await sessionsView(account));
}

async function thread(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  const asked = new URL(req.url, 'https://placeholder.invalid').searchParams.get('page');
  send(res, 200, await threadView(account, asked));
}

async function sendMessage(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  await requireClient(account);
  if (!(await underLimit('client-send', callerKey(req), 30, 3600))) {
    throw new HttpError(429, "That's a lot of messages in an hour. Try again later.");
  }

  const body = await readJson(req);
  const text = String(body.body || '').trim().slice(0, 4000);
  if (!text) throw new HttpError(400, 'Write something first.');

  await sql()`
    insert into messages (account_id, author, body_encrypted)
    values (${account}, 'client', ${encrypt(text)})
  `;

  await sql()`update cases set closed_at = null where account_id = ${account}`;

  return thread(req, res);
}

async function card(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  send(res, 200, await cardView(account));
}

async function askAccess(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  await requireClient(account);
  if (!(await underLimit('client-access', callerKey(req), 20, 3600))) {
    throw new HttpError(429, "That's a lot of requests in an hour. Try again later.");
  }
  const [person] = await sql()`select id, is_demo from cases where account_id = ${account}`;
  if (!person) throw new HttpError(409, 'Link a session first.');
  const out = await requestAccess(Number(person.id), Boolean(person.is_demo));
  if (!out) throw new HttpError(503, "Access-rate sessions aren't set up yet. The standard rate still works.");
  if (out.already) throw new HttpError(409, 'You already have a request in. Pay for it, or wait for its month.');
  return card(req, res);
}

async function link(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  if (!(await underLimit('client-link', callerKey(req), 20, 3600))) {
    throw new HttpError(429, 'Too many attempts from here. Try later.');
  }

  const body = await readJson(req);
  const raw = String(body.t || '').trim();
  const token = raw.includes('t=') ? raw.split('t=').pop().split('&')[0].trim() : raw;
  if (!token) throw new HttpError(400, 'Paste the link you were given after paying.');

  const order = await findByClaimTokenHash(keyedHash(token));
  if (!order) throw new HttpError(404, 'No order matches that link.');
  if (describeStatus(order) === 'rejected') {
    throw new HttpError(409, "That order didn't check out, so there's nothing to link.");
  }
  if (order.client_account_id && order.client_account_id !== account) {
    throw new HttpError(409, 'That link is already held by a different account.');
  }

  const caseId = await caseForAccount(account);
  const name = nameFromCookie(readCookie(req, NAME_COOKIE));
  if (name) {
    await sql()`update cases set name_encrypted = ${encrypt(name)} where id = ${caseId}`;
  }
  const linked = [
    ...await sql()`
      update orders set client_account_id = ${account}, case_id = ${caseId}
       where id = ${order.id} and client_account_id is null
      returning id
    `,
    ...await sql()`
      update orders set case_id = ${caseId}
       where client_account_id = ${account} and case_id is null
      returning id
    `,
  ].map((o) => o.id);
  await sql()`
    update messages set account_id = ${account}, order_id = null
     where order_id = ${order.id} and account_id is null
  `;
  if (linked.length) {
    await sql()`update calls set chapter_id = chapter_now(${caseId}) where order_id = any(${linked}) and chapter_id is null`;
    await sql()`update strategies set case_id = ${caseId} where order_id = any(${linked}) and case_id is null`;
    await sql()`update call_gaps set chapter_id = chapter_now(${caseId}) where order_id = any(${linked}) and chapter_id is null`;
    for (const id of linked) await syncStepsFor(Number(id));
  }
  return mine(req, res);
}

function nameFromCookie(sealed) {
  if (!sealed) return null;
  try {
    return decrypt(sealed).slice(0, 120) || null;
  } catch {
    return null;
  }
}

export default handle(['GET', 'POST'], async (req, res) => {
  const action = new URL(req.url, 'https://placeholder.invalid').searchParams.get('action');
  if (req.method === 'GET' && action === 'mine') return mine(req, res);
  if (req.method === 'GET' && action === 'thread') return thread(req, res);
  if (req.method === 'GET' && action === 'sessions') return card(req, res);
  if (req.method === 'POST' && action === 'link') return link(req, res);
  if (req.method === 'POST' && action === 'access-request') return askAccess(req, res);
  if (req.method === 'POST' && action === 'send') return sendMessage(req, res);
  if (req.method === 'POST' && action === 'activity') return tickActivity(req, res);
  throw new HttpError(
    400,
    'Use action=mine, action=thread, action=sessions, action=link, action=send, ' +
      'action=access-request or action=activity.',
  );
});
