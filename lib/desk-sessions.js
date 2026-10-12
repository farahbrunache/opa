import { ensureSchema, sql } from './db.js';
import { decrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { caseOf, orderId, record } from './desk-events.js';
import { activityUnder, needsCase } from './desk-activities.js';
import { accessNow, heldFor, pendingSessionOrders, ratesNow, requestsFor } from './sessions.js';

export async function useSession(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const activity = await activityUnder(caseId, orderId(body.activityId));
  if (activity.state !== 'todo') throw new HttpError(409, 'A session goes to an activity that is on their page.');
  const [held] = await sql()`
    select id, rate from held_sessions where case_id = ${caseId} and used_at is null
     order by bought_at asc, id asc limit 1
  `;
  if (!held) throw new HttpError(409, 'No session is left on their card.');
  await sql()`
    update held_sessions set used_at = now(), activity_id = ${activity.id} where id = ${held.id}
  `;
  const title = decrypt(activity.title_encrypted);
  await record(id, 'session.used', `For ${title}.`);
  send(res, 200, { ok: true, activity: title });
}

export async function sessionsFor(caseId, orders) {
  const held = caseId ? await heldFor(caseId) : [];
  return {
    rates: await ratesNow(),
    access: await accessNow(),
    held,
    requests: caseId ? await requestsFor(caseId) : [],
    pending: caseId ? await pendingSessionOrders(caseId) : [],
    calls: orders.filter((o) => o.kind === 'call'),
  };
}
