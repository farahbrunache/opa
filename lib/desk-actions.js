import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { ACTION_STATUSES, CADENCES, isActionStatus, isCadence, nextDueAt } from './desk.js';
import { orderId, record } from './desk-events.js';

async function milestoneUnder(orderIdValue, milestoneId) {
  const rows = await sql()`
    select m.id from milestones m
      join plans p on p.id = m.plan_id
     where m.id = ${milestoneId} and p.order_id = ${orderIdValue} and p.in_force
  `;
  if (!rows.length) {
    throw new HttpError(404, 'No milestone with that number under this person\'s current plan.');
  }
  return Number(rows[0].id);
}

async function itemUnder(orderIdValue, itemId) {
  const rows = await sql()`
    select a.id, a.status, a.shown_at from action_items a
      join milestones m on m.id = a.milestone_id
      join plans p on p.id = m.plan_id
     where a.id = ${itemId} and p.order_id = ${orderIdValue} and p.in_force
  `;
  if (!rows.length) {
    throw new HttpError(404, 'No action with that number under this person\'s current plan.');
  }
  return rows[0];
}

export async function addAction(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const milestoneId = await milestoneUnder(id, orderId(body.milestoneId));

  const title = String(body.title || '').trim().slice(0, 300);
  if (!title) throw new HttpError(400, 'An action needs a line saying what to do.');

  const cadence = String(body.cadence || 'none');
  if (!isCadence(cadence)) {
    throw new HttpError(400, `Pick how often to come back: ${Object.keys(CADENCES).join(', ')}.`);
  }

  const next = await sql()`
    select coalesce(max(position), 0) + 1 as n from action_items
     where milestone_id = ${milestoneId}
  `;
  await sql()`
    insert into action_items (milestone_id, position, title_encrypted, cadence)
    values (${milestoneId}, ${next[0].n}, ${encrypt(title)}, ${cadence})
  `;
  await record(id, 'action.added', title);
  send(res, 201, { ok: true });
}

export async function recordAction(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const item = await itemUnder(id, orderId(body.actionId));

  const status = String(body.status || '');
  if (!isActionStatus(status)) {
    throw new HttpError(400, `Pick a status: ${ACTION_STATUSES.join(', ')}.`);
  }
  const outcome = String(body.outcome || '').trim().slice(0, 2000);

  const open = status === 'open';
  const [row] = await sql()`select cadence from action_items where id = ${item.id}`;
  await sql()`
    update action_items set
      status = ${status},
      outcome_encrypted = ${outcome ? encrypt(outcome) : null},
      closed_at = ${open ? null : new Date().toISOString()},
      next_at = ${open && item.shown_at ? nextDueAt(row.cadence) : null},
      updated_at = now()
    where id = ${item.id}
  `;
  await record(id, 'action.recorded', `${status}. ${outcome}`.trim());
  send(res, 200, { ok: true, status });
}

export async function pushAction(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const item = await itemUnder(id, orderId(body.actionId));
  if (item.status !== 'open') {
    throw new HttpError(409, 'That one is closed out. Reopen it to ask about it again.');
  }
  if (!item.shown_at) throw new HttpError(409, 'That one hasn\'t been sent to them yet.');

  const [row] = await sql()`select cadence, title_encrypted from action_items where id = ${item.id}`;
  const at = nextDueAt(row.cadence);
  const [saved] = await sql()`
    update action_items set next_at = ${at}, asked_at = now(), updated_at = now()
     where id = ${item.id}
    returning asked_at
  `;
  await record(id, 'action.asked', decrypt(row.title_encrypted));
  send(res, 200, { ok: true, nextAt: at, askedAt: saved.asked_at });
}

export async function setCadence(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const item = await itemUnder(id, orderId(body.actionId));
  const cadence = String(body.cadence || '');
  if (!isCadence(cadence)) {
    throw new HttpError(400, `Pick how often to come back: ${Object.keys(CADENCES).join(', ')}.`);
  }
  const at = item.status === 'open' && item.shown_at ? nextDueAt(cadence) : null;
  const [row] = await sql()`
    update action_items set cadence = ${cadence}, next_at = ${at}, updated_at = now()
     where id = ${item.id}
    returning title_encrypted
  `;
  await record(id, 'action.cadence', `${decrypt(row.title_encrypted)}: ${CADENCES[cadence].label}.`);
  send(res, 200, { ok: true, cadence, nextAt: at });
}
