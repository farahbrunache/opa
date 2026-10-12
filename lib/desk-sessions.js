import { ensureSchema, sql } from './db.js';
import { decrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { caseOf, orderId } from './desk-events.js';
import { activityUnder, needsCase } from './desk-activities.js';
import {
  CLOSED_WHY, SESSION_CAP_MINUTES, accessNow, closeSession, heldFor, openSession, openSessionOf,
  pendingSessionOrders, ratesNow, requestsFor,
} from './sessions.js';
import { costLines, draftCost, endpointRates } from './costs.js';
import { hourRates } from './pricing.js';

export async function useSession(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const activity = await activityUnder(caseId, orderId(body.activityId));
  if (activity.state !== 'todo') throw new HttpError(409, 'A session goes to an activity that is on their page.');
  if (await openSessionOf(id)) throw new HttpError(409, 'A session is already open. Close it first.');
  const title = decrypt(activity.title_encrypted);
  if (!(await openSession(id, caseId, activity.id, title))) throw new HttpError(409, 'No session is left on their card.');
  send(res, 200, { ok: true, activity: title });
}

export async function endSession(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const why = body.why === 'delivered' ? 'delivered' : 'closed';
  const open = await openSessionOf(id);
  if (!open) throw new HttpError(409, 'No session is open.');
  await closeSession(id, open.id, why);
  send(res, 200, { ok: true, why: CLOSED_WHY[why] });
}

async function modelCosts(caseId) {
  const lines = await costLines();
  const perSecondLine = lines.find((l) => l.every === 'draft-second');
  const perSecond = perSecondLine ? perSecondLine.costs : null;
  const rates = await endpointRates();
  const drafts = await sql()`
    select d.session_id, d.seconds, d.created_at, d.gave_up_at, d.finished_at, d.endpoint_id,
           d.prompt_tokens, d.completion_tokens
      from drafts d join held_sessions h on h.id = d.session_id
     where h.case_id = ${caseId}
  `;
  const out = new Map();
  for (const d of drafts) {
    const key = Number(d.session_id);
    const was = out.get(key) || { ai: 0, unpriced: 0 };
    const cost = draftCost(d, perSecond, rates);
    if (cost === null) was.unpriced += 1;
    else was.ai += cost;
    out.set(key, was);
  }
  return out;
}

export async function sessionsFor(caseId, orders) {
  const held = caseId ? await heldFor(caseId) : [];
  const ai = caseId ? await modelCosts(caseId) : new Map();
  for (const h of held) Object.assign(h, ai.get(h.id) || { ai: 0, unpriced: 0 });
  return {
    cap: SESSION_CAP_MINUTES,
    hourRates: await hourRates(),
    rates: await ratesNow(),
    access: await accessNow(),
    held,
    requests: caseId ? await requestsFor(caseId) : [],
    pending: caseId ? await pendingSessionOrders(caseId) : [],
    calls: orders.filter((o) => o.kind === 'call'),
  };
}
