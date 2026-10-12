import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { caseOf, orderId, record } from './desk-events.js';

function needsCase(caseId) {
  if (caseId === null) {
    throw new HttpError(
      409,
      'Nobody has signed in against this order yet, so there is no case to mark. They link it ' +
        'by opening their claim link while signed in.',
    );
  }
  return caseId;
}

export async function block(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) {
    throw new HttpError(400, 'Say what it is waiting on. A blocker with no reason is a case you '
      + 'will not remember in a week.');
  }

  let until = null;
  if (body.until) {
    const when = new Date(String(body.until));
    if (Number.isNaN(when.getTime())) throw new HttpError(400, 'That is not a date.');
    if (when.getTime() < Date.now()) {
      throw new HttpError(400, 'That date has passed, so it would come straight back. Leave it '
        + 'empty to have it come back on its own.');
    }
    until = when.toISOString();
  }

  await sql()`
    update cases set blocked_at = now(), blocked_until = ${until},
                     blocker_encrypted = ${encrypt(reason)}
     where id = ${caseId}
  `;
  await record(id, 'note', `Blocked: ${reason}`);
  send(res, 200, { ok: true });
}

export async function unblock(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const rows = await sql()`select blocker_encrypted from cases where id = ${caseId}`;
  if (!rows.length || !rows[0].blocker_encrypted) {
    throw new HttpError(409, 'Nothing is blocking this one.');
  }
  await sql()`
    update cases set blocked_at = null, blocked_until = null, blocker_encrypted = null
     where id = ${caseId}
  `;
  await record(id, 'note', `Unblocked: ${decrypt(rows[0].blocker_encrypted)}`);
  send(res, 200, { ok: true });
}

export async function recommendationDone(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const done = body.done !== false;

  const rows = await sql()`
    update orders
       set recommendation_done_at = case when ${done}
                                         then coalesce(recommendation_done_at, now()) else null end
     where id = ${id} and status = 'confirmed'
     returning recommendation_done_at
  `;
  if (!rows.length) throw new HttpError(404, 'No confirmed order with that number.');
  await record(id, 'recommendation-done', done ? 'Completed a recommendation.' : 'Taken back off.');
  send(res, 200, { ok: true, at: rows[0].recommendation_done_at });
}

export async function close(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const [row] = await sql()`select closed_at from cases where id = ${caseId}`;
  const closing = !row.closed_at;
  await sql()`
    update cases set closed_at = ${closing ? new Date().toISOString() : null}
     where id = ${caseId}
  `;
  await record(id, 'note', closing
    ? 'Closed. A view only: they see no difference and the conversation stays open.'
    : 'Opened again.');
  send(res, 200, { ok: true, closed: closing });
}
