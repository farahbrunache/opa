import crypto from 'node:crypto';
import { ensureSchema, sql } from '../lib/db.js';
import { underLimit } from '../lib/settings.js';
import { callerKey, claimToken, encrypt, keyedHash, normalizeCardCode } from '../lib/crypto.js';
import {
  PAYMENT_METHODS,
  SESSION_PRICE_CENTS,
  isPaymentMethod,
  referenceCode,
} from '../lib/orders.js';
import { HttpError, handle, readJson, send } from '../lib/http.js';
import { referralCode } from '../lib/referrals.js';
import { accountOrNull } from '../lib/auth.js';
import { isRate } from '../lib/desk.js';
import { ratesNow, requestsFor, wiseHandle } from '../lib/sessions.js';

const DUPLICATE_MESSAGE =
  'That gift card has already been submitted. If you have lost your link, recover it with the ' +
  'same code.';

async function payTo(method) {
  const spec = PAYMENT_METHODS[method];
  if (spec.needsCode) return null;
  const where = await wiseHandle();
  if (!where) {
    throw new HttpError(
      503,
      `${spec.label} is not set up yet. Pick another way to pay, or try again later.`,
    );
  }
  return where;
}

export default handle('POST', async (req, res) => {
  const body = await readJson(req);

  const method = String(body.method || '').trim().toLowerCase();
  if (!isPaymentMethod(method)) {
    throw new HttpError(
      400,
      `Choose how you are paying: ${Object.values(PAYMENT_METHODS).map((m) => m.label).join(', ')}.`,
    );
  }
  const spec = PAYMENT_METHODS[method];

  const kind = body.session ? 'session' : 'call';
  const rate = kind === 'session' ? String(body.session) : null;
  let account = null;
  let caseId = null;
  let priceCents = SESSION_PRICE_CENTS;
  if (kind === 'session') {
    if (!isRate(rate)) throw new HttpError(400, 'A session is at the access rate or the standard rate.');
    const rates = await ratesNow();
    if (!rates) throw new HttpError(503, "Sessions aren't on sale yet: the rates aren't set.");
    priceCents = Math.round((rate === 'access' ? rates.access : rates.standard) * 100);
    account = accountOrNull(req);
    if (!account) throw new HttpError(401, 'Sign in with Skills Economy first, so the session lands on your card.');
  }

  let code = null;
  let amountCents = priceCents;

  if (spec.needsCode) {
    code = normalizeCardCode(body.code);
    if (code.length < 8) {
      throw new HttpError(
        400,
        'That does not look like a gift card code. Check it and enter it again — dashes and ' +
          'spaces do not matter.',
      );
    }
    if (code.length > 64) throw new HttpError(400, 'That code is longer than any gift card code.');

    const amount = Number(body.amount);
    const least = priceCents / 100;
    if (!Number.isFinite(amount) || amount < least || amount > Math.max(500, least)) {
      throw new HttpError(400, `Enter what the card is worth, in dollars, between ${least} and ${Math.max(500, least)}.`);
    }
    amountCents = Math.round(amount * 100);
  }

  const where = await payTo(method);

  await ensureSchema();

  let request = null;
  if (kind === 'session') {
    const [person] = await sql()`select id from cases where account_id = ${account}`;
    if (!person) throw new HttpError(409, 'Link a session to this account first.');
    caseId = Number(person.id);
    if (rate === 'access') {
      request = (await requestsFor(caseId)).find((r) => r.grantedAt
        && (!r.orderReference || r.orderStatus === 'rejected')) || null;
      if (!request) throw new HttpError(409, 'Request an access-rate session on your page first. It has to be given before it can be paid for.');
    }
  }

  if (!(await underLimit('submit', callerKey(req), 10, 3600))) {
    throw new HttpError(429, 'Too many submissions from here in the last hour. Try later.');
  }

  const codeHash = code ? keyedHash(code) : null;
  if (codeHash) {
    const existing = await sql()`
      select 1 from orders where card_code_hash = ${codeHash} limit 1
    `;
    if (existing.length) throw new HttpError(409, DUPLICATE_MESSAGE);
  }

  const wanted = referralCode(body.from);
  const [referrer] = wanted ? await sql()`select 1 from cases where referral_code = ${wanted}` : [];
  const fromCode = referrer ? wanted : null;

  const token = claimToken();

  let reference = null;
  for (let attempt = 0; attempt < 8 && !reference; attempt += 1) {
    const candidate = referenceCode((n) => crypto.randomInt(0, n));
    const clash = await sql()`select 1 from orders where reference_code = ${candidate} limit 1`;
    if (!clash.length) reference = candidate;
  }
  if (!reference) {
    throw new HttpError(503, "Couldn't open an order just now: eight new 10-character references "
      + 'in a row were already taken. Nothing was charged and nothing was saved. Try again in a minute.');
  }

  try {
    const [made] = await sql()`
      insert into orders (
        claim_token_hash, card_code_hash, card_amount_cents,
        card_code_encrypted, payment_method, reference_code, from_code, kind, rate,
        client_account_id, case_id
      ) values (
        ${keyedHash(token)}, ${codeHash}, ${amountCents},
        ${code ? encrypt(code) : null}, ${method}, ${reference}, ${fromCode}, ${kind}, ${rate},
        ${account}, ${caseId}
      )
      returning id
    `;
    if (request) await sql()`update access_requests set order_id = ${made.id} where id = ${request.id}`;
  } catch (error) {
    const message = String(error.message || '');
    if (message.includes('orders_card_code_hash_idx')) throw new HttpError(409, DUPLICATE_MESSAGE);
    if (message.includes('orders_reference_code_idx')) {
      throw new HttpError(503, "Couldn't open an order just now: another order took the same "
        + '10-character reference at the same moment. Nothing was saved. Try again.');
    }
    throw error;
  }

  send(res, 201, {
    claim: kind === 'session' ? null : `/claim?t=${token}`,
    reference,
    method,
    label: spec.label,
    payTo: where,
    needsCode: spec.needsCode,
    amount: amountCents / 100,
    price: priceCents / 100,
    session: rate,
  });
});
