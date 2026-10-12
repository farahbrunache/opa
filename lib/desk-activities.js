import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import {
  CADENCES, DROP_REASONS, DROP_REASONS_OFFERED, isCadence, isDropReason, nextDueAt,
} from './desk.js';
import { caseOf, orderId, record } from './desk-events.js';

const MAX_TITLE = 300;
const MAX_OUTCOME = 2000;

export function needsCase(caseId) {
  if (caseId === null) {
    throw new HttpError(
      409,
      'Nobody has signed in against this order yet, so there is no roadmap to put this on. They '
        + 'link it by opening their claim link while signed in.',
    );
  }
  return caseId;
}

export async function activityUnder(caseId, activityId) {
  const rows = await sql()`
    select id, state, title_encrypted, cadence, shown_at, next_at, source, outcome_encrypted
      from activities where id = ${activityId} and case_id = ${caseId}
  `;
  if (!rows.length) throw new HttpError(404, 'No activity with that number on this person.');
  return rows[0];
}

export async function nextPosition(caseId) {
  const [{ n }] = await sql()`
    select coalesce(max(position), 0) + 1 as n from activities where case_id = ${caseId}
  `;
  return Number(n);
}

export async function insertActivity(caseId, title, { source = 'you', state = 'drafted' } = {}) {
  const [plan] = await sql()`select id from plans where case_id = ${caseId} and in_force`;
  const [made] = await sql()`
    insert into activities (case_id, plan_id, position, title_encrypted, state, source, shown_at)
    values (${caseId}, ${plan ? plan.id : null}, ${await nextPosition(caseId)}, ${encrypt(title)},
            ${state}, ${source}, ${state === 'todo' ? new Date().toISOString() : null})
    returning id
  `;
  return Number(made.id);
}

export async function addActivity(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (!title) throw new HttpError(400, 'An activity needs a line saying what it is.');
  const caseId = needsCase(await caseOf(id));
  const made = await insertActivity(caseId, title);
  await record(id, 'activity.added', title);
  send(res, 201, { ok: true, activityId: made });
}

export async function moveActivity(caseId, activityId) {
  const item = await activityUnder(caseId, activityId);
  if (item.state !== 'drafted') throw new HttpError(409, 'Only a drafted activity moves to To do.');
  await sql()`
    update activities set state = 'todo', shown_at = now(), next_at = ${nextDueAt(item.cadence)},
           updated_at = now()
     where id = ${item.id}
  `;
  return decrypt(item.title_encrypted);
}

export async function moveToTodo(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const activityId = orderId(body.activityId);
  const title = await moveActivity(caseId, activityId);
  await record(id, 'activity.moved', title);
  send(res, 200, { ok: true, activity: { id: activityId, title } });
}

export async function finishActivity(caseId, activityId, outcome) {
  const item = await activityUnder(caseId, activityId);
  if (!['todo', 'drafted'].includes(item.state)) {
    throw new HttpError(409, 'That activity is already closed out.');
  }
  await sql()`
    update activities set state = 'done', closed_at = now(), next_at = null,
           outcome_encrypted = ${outcome ? encrypt(outcome) : item.outcome_encrypted}, updated_at = now()
     where id = ${item.id}
  `;
  return decrypt(item.title_encrypted);
}

export async function recordDone(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const outcome = String(body.outcome || '').trim().slice(0, MAX_OUTCOME);
  const title = await finishActivity(caseId, orderId(body.activityId), outcome);
  await record(id, 'activity.done', `${title}. ${outcome}`.trim());
  send(res, 200, { ok: true });
}

export async function saveOutcome(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const item = await activityUnder(caseId, orderId(body.activityId));
  const outcome = String(body.outcome || '').trim().slice(0, MAX_OUTCOME);
  await sql()`
    update activities set outcome_encrypted = ${outcome ? encrypt(outcome) : null}, updated_at = now()
     where id = ${item.id}
  `;
  await record(id, 'activity.outcome', `${decrypt(item.title_encrypted)}. ${outcome}`.trim());
  send(res, 200, { ok: true });
}

export async function reopenActivity(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const item = await activityUnder(caseId, orderId(body.activityId));
  if (item.state === 'todo') throw new HttpError(409, 'That one is already on their page.');
  await sql()`
    update activities set state = 'todo', shown_at = coalesce(shown_at, now()), closed_at = null,
           drop_reason = null, next_at = ${nextDueAt(item.cadence)}, updated_at = now()
     where id = ${item.id}
  `;
  await record(id, 'activity.reopened', decrypt(item.title_encrypted));
  send(res, 200, { ok: true });
}

export async function dropActivity(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const item = await activityUnder(caseId, orderId(body.activityId));
  if (!['todo', 'drafted'].includes(item.state)) {
    throw new HttpError(409, 'That activity is already closed out.');
  }
  const reason = String(body.reason || '');
  if (!isDropReason(reason)) {
    throw new HttpError(400, `Say why: ${DROP_REASONS_OFFERED.map((r) => DROP_REASONS[r]).join(', ')}.`);
  }
  const outcome = String(body.outcome || '').trim().slice(0, MAX_OUTCOME);
  await sql()`
    update activities set state = 'dropped', closed_at = now(), next_at = null, drop_reason = ${reason},
           outcome_encrypted = ${outcome ? encrypt(outcome) : null}, updated_at = now()
     where id = ${item.id}
  `;
  const title = decrypt(item.title_encrypted);
  await record(id, 'activity.dropped', `${title}. ${DROP_REASONS[reason]}. ${outcome}`.trim());
  send(res, 200, { ok: true });
}

export async function pushActivity(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const item = await activityUnder(caseId, orderId(body.activityId));
  if (item.state !== 'todo') throw new HttpError(409, "That one isn't on their page, so there's nothing to ask about.");
  const at = nextDueAt(item.cadence);
  const [saved] = await sql()`
    update activities set next_at = ${at}, asked_at = now(), updated_at = now()
     where id = ${item.id}
    returning asked_at
  `;
  await record(id, 'activity.asked', decrypt(item.title_encrypted));
  send(res, 200, { ok: true, nextAt: at, askedAt: saved.asked_at });
}

export async function setCadence(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const item = await activityUnder(caseId, orderId(body.activityId));
  const cadence = String(body.cadence || '');
  if (!isCadence(cadence)) {
    throw new HttpError(400, `Pick how often to come back: ${Object.keys(CADENCES).join(', ')}.`);
  }
  const at = item.state === 'todo' ? nextDueAt(cadence) : null;
  await sql()`
    update activities set cadence = ${cadence}, next_at = ${at}, updated_at = now() where id = ${item.id}
  `;
  await record(id, 'activity.cadence', `${decrypt(item.title_encrypted)}: ${CADENCES[cadence].label}.`);
  send(res, 200, { ok: true, cadence, nextAt: at });
}

export async function activitiesFor(caseId) {
  if (!caseId) return [];
  const rows = await sql()`
    select a.id, a.position, a.title_encrypted, a.state, a.source, a.step_order_id, a.step_chapter_id,
           a.step_number, a.shown_at, a.cadence, a.next_at, a.asked_at, a.outcome_encrypted, a.drop_reason,
           a.closed_at, a.chapter_id, a.created_at, a.updated_at,
           (select count(*)::int from held_sessions h where h.activity_id = a.id) as sessions_used
      from activities a where a.case_id = ${caseId}
     order by a.position asc, a.id asc
  `;
  return rows.map((a) => ({
    id: Number(a.id),
    title: decrypt(a.title_encrypted),
    state: a.state,
    source: a.source,
    fromSteps: a.step_order_id !== null || a.step_chapter_id !== null,
    stepNumber: a.step_number === null ? null : Number(a.step_number),
    shownAt: a.shown_at,
    cadence: a.cadence,
    cadenceLabel: CADENCES[a.cadence]?.label || a.cadence,
    nextAt: a.next_at,
    due: a.state === 'todo' && a.next_at !== null && new Date(a.next_at).getTime() <= Date.now(),
    askedAt: a.asked_at,
    outcome: a.outcome_encrypted ? decrypt(a.outcome_encrypted) : null,
    dropReason: a.drop_reason,
    dropReasonLabel: a.drop_reason ? DROP_REASONS[a.drop_reason] || a.drop_reason : null,
    closedAt: a.closed_at,
    chapterId: a.chapter_id,
    sessionsUsed: Number(a.sessions_used || 0),
    addedAt: a.created_at,
    updatedAt: a.updated_at,
  }));
}
