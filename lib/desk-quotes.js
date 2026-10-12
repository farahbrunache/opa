import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { MAX_OPEN_QUOTES, QUOTE_STATUSES, isQuoteStatus } from './desk.js';
import { askAndRecord, MODEL_CHOICE } from './desk-drafts.js';
import { readChoice } from './settings.js';
import { prompt } from './prompts.js';
import { orderId, record } from './desk-events.js';
import { scopeOf } from './chapter-scope.js';

export async function writeQuote(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'A quote needs an amount in dollars.');
  }
  const cents = Math.round(amount * 100);
  if (cents > 100_000_00) {
    throw new HttpError(400, 'That is more than a hundred thousand dollars. Check the figure.');
  }

  const scope = String(body.scope || '').trim().slice(0, 2000);
  if (!scope) {
    throw new HttpError(400, 'Say what the quote covers. A number on its own is unreadable in June.');
  }

  const rows = await sql()`select client_account_id from orders where id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  const account = rows[0].client_account_id;
  if (!account) {
    throw new HttpError(
      409,
      'Nobody has linked an account to this order yet, so there is no one to quote. They link ' +
        'it by opening their claim link while signed in.',
    );
  }

  const written = await sql()`
    insert into quotes (account_id, amount_cents, scope_encrypted)
    select ${account}, ${cents}, ${encrypt(scope)}
     where (
       select count(*) from quotes
        where account_id = ${account} and status = 'offered'
     ) < ${MAX_OPEN_QUOTES}
    returning id
  `;
  if (!written.length) {
    throw new HttpError(
      409,
      `There are already ${MAX_OPEN_QUOTES} quotes waiting on an answer from this person, ` +
        'which is as many as anybody can choose between. Withdraw one, or wait for an answer.',
    );
  }
  if (body.replaces !== undefined && body.replaces !== null) {
    const replaced = orderId(body.replaces);
    const closed = await sql()`
      update quotes set status = 'withdrawn', updated_at = now()
       where id = ${replaced} and account_id = ${account} and status = 'changes asked'
      returning amount_cents
    `;
    if (!closed.length) {
      throw new HttpError(
        409,
        'That quote is not one they asked to change, so there is nothing here to counter. The ' +
          'new quote was written; the old one is untouched.',
      );
    }
    await record(id, 'quote.moved',
      `withdrawn, countered. $${(closed[0].amount_cents / 100).toFixed(2)}`);
  }

  await record(id, 'quote.written', `$${amount.toFixed(2)}. ${scope}`);
  send(res, 201, { ok: true });
}

export async function moveQuote(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const quoteId = orderId(body.quoteId);
  const status = String(body.status || '');
  if (!isQuoteStatus(status)) {
    throw new HttpError(400, `Pick one: ${QUOTE_STATUSES.join(', ')}.`);
  }

  const rows = await sql()`select client_account_id from orders where id = ${id}`;
  const account = rows[0]?.client_account_id;
  if (!account) throw new HttpError(404, 'No account is linked to that order.');

  const done = await sql()`
    update quotes set status = ${status}, updated_at = now()
     where id = ${quoteId} and account_id = ${account}
     returning amount_cents
  `;
  if (!done.length) throw new HttpError(404, 'No quote with that number for this person.');
  await record(id, 'quote.moved', `${status}. $${(done[0].amount_cents / 100).toFixed(2)}`);
  send(res, 200, { ok: true, status });
}

export async function quoteWorth(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);

  const rows = await sql()`
    select o.recommendations_encrypted, o.recommendations_written_at from orders o where o.id = ${id}
  `;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  const scope = await scopeOf(id, { withSummary: body.withSummary === true });
  const [call] = (await sql()`
    select transcript_encrypted, chapter_id from calls
     where order_id = ${id} and transcript_encrypted is not null
     order by ended_at desc nulls last
  `).filter((c) => scope.holds(c.chapter_id));

  const transcript = call ? decrypt(call.transcript_encrypted) : null;
  if (!transcript && !(scope.later && scope.brief)) {
    throw new HttpError(409, 'There is no call to read, so there is nothing to work from.');
  }

  const sheet = rows[0].recommendations_encrypted && scope.since(rows[0].recommendations_written_at)
    ? decrypt(rows[0].recommendations_encrypted)
    : null;

  const said = [
    { role: 'system', content: await prompt('quote') },
    ...(scope.lead.length ? [{ role: 'user', content: scope.lead.join('\n\n') }] : []),
    ...(transcript ? [{ role: 'user', content: `The call:\n${transcript}` }] : []),
    ...(sheet ? [{ role: 'user', content: `What they were told:\n${sheet}` }] : []),
  ];

  send(res, 202, await askAndRecord(id, said, await readChoice(MODEL_CHOICE), 'quote'));
}
