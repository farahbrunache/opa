import { ensureSchema, sql } from './db.js';
import { encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';

async function quoteUnder(orderIdValue, quoteId) {
  const [order] = await sql()`select client_account_id from orders where id = ${orderIdValue}`;
  const account = order?.client_account_id;
  if (!account) throw new HttpError(404, 'No account is linked to that order.');

  const rows = await sql()`
    select id, amount_cents, status, paid_cents, due_at
      from quotes where id = ${quoteId} and account_id = ${account}
  `;
  if (!rows.length) throw new HttpError(404, 'No quote with that number for this person.');
  return rows[0];
}

export async function setQuoteDue(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const quote = await quoteUnder(id, orderId(body.quoteId));

  const given = String(body.dueAt || '').trim();
  let dueAt = null;
  if (given) {
    const when = new Date(given);
    if (Number.isNaN(when.getTime())) throw new HttpError(400, 'That is not a date.');
    dueAt = when.toISOString();
  }

  await sql()`update quotes set due_at = ${dueAt}, updated_at = now() where id = ${quote.id}`;
  await record(id, 'quote.due', dueAt ? `Due ${dueAt.slice(0, 10)}.` : 'No date on it.');
  send(res, 200, { ok: true, dueAt });
}

export async function recordPayment(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const quote = await quoteUnder(id, orderId(body.quoteId));

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'How much actually arrived, in dollars?');
  }
  const cents = Math.round(amount * 100);

  const discount = String(body.discount || '').trim().slice(0, 500);
  if (cents < quote.amount_cents && !discount) {
    const quoted = (quote.amount_cents / 100).toFixed(2);
    throw new HttpError(
      400,
      `That is less than the $${quoted} quoted. Add a note.`,
    );
  }

  const at = String(body.at || '').trim();
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) throw new HttpError(400, 'That is not a date.');

  await sql()`
    update quotes set
      paid_cents = ${cents},
      paid_at = ${when.toISOString()},
      discount_encrypted = ${discount ? encrypt(discount) : null},
      status = 'paid',
      updated_at = now()
    where id = ${quote.id}
  `;

  const short = quote.amount_cents - cents;
  await record(id, 'quote.paid', short > 0
    ? `$${(cents / 100).toFixed(2)} of $${(quote.amount_cents / 100).toFixed(2)}. ${discount}`
    : `$${(cents / 100).toFixed(2)}.`);
  send(res, 200, { ok: true, paidCents: cents, shortBy: short > 0 ? short : 0 });
}
