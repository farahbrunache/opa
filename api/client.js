import { caseForAccount, ensureSchema, findByClaimTokenHash, sql } from '../lib/db.js';
import { agreedWording } from '../lib/quote-terms.js';
import { underLimit } from '../lib/settings.js';
import { callerKey, decrypt, encrypt, keyedHash } from '../lib/crypto.js';
import { NAME_COOKIE, requireAccount } from '../lib/auth.js';
import { describeStatus } from '../lib/orders.js';
import { isQuoteAnswer } from '../lib/desk.js';
import { HttpError, handle, readCookie, readJson, send } from '../lib/http.js';
import { tickStep } from '../lib/client-page.js';
import { quotesView, requireClient, sessionsView, threadView } from '../lib/client-view.js';

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

async function quotes(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  send(res, 200, await quotesView(account));
}

async function answerQuote(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  if (!(await underLimit('client-quote', callerKey(req), 40, 3600))) {
    throw new HttpError(429, 'That is a lot of answers in an hour. Try again later.');
  }

  const body = await readJson(req);
  const answer = String(body.answer || '');
  if (!isQuoteAnswer(answer)) {
    throw new HttpError(400, 'The answer is either agreed, declined or changes asked.');
  }

  const reason = String(body.reason || '').trim().slice(0, 2000);
  if (answer !== 'agreed' && !reason) {
    throw new HttpError(
      400,
      answer === 'declined'
        ? 'Say in a line why it is a no. Without it there is nothing to write a better one from.'
        : 'Say in a line what needs changing. Without it there is nothing to change.',
    );
  }

  if (answer === 'agreed' && body.accepted !== true) {
    throw new HttpError(400, "Tick the box first. It says the work starts once it's paid and "
      + "there's no refund after that.");
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Which quote?');

  const done = await sql()`
    update quotes set
      status = ${answer},
      answered_at = now(),
      reason_encrypted = ${reason ? encrypt(reason) : null},
      agreed_terms = ${answer === 'agreed' ? agreedWording() : null},
      updated_at = now()
     where id = ${id} and account_id = ${account} and status = 'offered'
     returning id
  `;
  if (!done.length) {
    throw new HttpError(409, 'That quote is not one of yours, or it has already been answered.');
  }

  await sql()`
    insert into case_events (order_id, kind, detail_encrypted)
    select id, 'quote.answered',
           ${encrypt(answer === 'agreed' ? `agreed. ${agreedWording()}` : `${answer}. ${reason}`.trim())}
      from orders where client_account_id = ${account}
     order by created_at desc limit 1
  `;

  return quotes(req, res);
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
    await sql()`update recaps set chapter_id = chapter_now(${caseId}) where order_id = any(${linked}) and chapter_id is null`;
    await sql()`update call_gaps set chapter_id = chapter_now(${caseId}) where order_id = any(${linked}) and chapter_id is null`;
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
  if (req.method === 'GET' && action === 'quotes') return quotes(req, res);
  if (req.method === 'POST' && action === 'link') return link(req, res);
  if (req.method === 'POST' && action === 'quote-answer') return answerQuote(req, res);
  if (req.method === 'POST' && action === 'send') return sendMessage(req, res);
  if (req.method === 'POST' && action === 'step') return tickStep(req, res);
  throw new HttpError(
    400,
    'Use action=mine, action=thread, action=quotes, action=link, action=send, ' +
      'action=quote-answer or action=step.',
  );
});
