import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { WORK_DONE, WORK_STATES_OFFERED, isWorkState } from './desk.js';
import { caseOf, orderId, record } from './desk-events.js';
import { activityUnder, needsCase } from './desk-activities.js';

function readDate(given, what) {
  const text = String(given || '').trim();
  if (!text) return null;
  const when = new Date(text);
  if (Number.isNaN(when.getTime())) throw new HttpError(400, `That is not a date for ${what}.`);
  return when.toISOString();
}

export async function takeOnWork(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const title = String(body.title || '').trim().slice(0, 300);
  if (!title) throw new HttpError(400, 'What is the work? One line.');

  let activityId = null;
  if (body.activityId) {
    const activity = await activityUnder(caseId, orderId(body.activityId));
    if (activity.state !== 'todo') throw new HttpError(409, 'Work goes under an activity that is on their page.');
    activityId = Number(activity.id);
  }

  await sql()`
    insert into work (case_id, activity_id, title_encrypted, due_at, note_encrypted)
    values (${caseId}, ${activityId}, ${encrypt(title)}, ${readDate(body.dueAt, 'the date it is due')},
            ${String(body.note || '').trim().slice(0, 1000)
              ? encrypt(String(body.note).trim().slice(0, 1000)) : null})
  `;
  await record(id, 'work.taken', activityId
    ? `${title} · for ${decrypt((await activityUnder(caseId, activityId)).title_encrypted)}` : title);
  send(res, 201, { ok: true });
}

export async function moveWork(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const [row] = await sql()`
    select id, state from work where id = ${orderId(body.workId)} and case_id = ${caseId}
  `;
  if (!row) throw new HttpError(404, 'No work with that number for this person.');

  const state = String(body.state || '');
  if (!isWorkState(state)) {
    throw new HttpError(400, `Pick a state: ${WORK_STATES_OFFERED.join(', ')}.`);
  }

  const done = state === WORK_DONE;
  await sql()`
    update work set
      state = ${state},
      done_at = case when ${done}
        then coalesce(case when state = ${WORK_DONE} then done_at end, now()) end,
      note_encrypted = ${String(body.note || '').trim().slice(0, 1000)
        ? encrypt(String(body.note).trim().slice(0, 1000)) : null},
      updated_at = now()
    where id = ${row.id}
  `;
  await record(id, 'work.moved', `${state}. ${String(body.note || '').trim()}`.trim());
  send(res, 200, { ok: true, state });
}

export async function setWorkDue(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const [row] = await sql()`
    select id from work where id = ${orderId(body.workId)} and case_id = ${caseId}
  `;
  if (!row) throw new HttpError(404, 'No work with that number for this person.');

  const dueAt = readDate(body.dueAt, 'the date it is due');
  await sql()`update work set due_at = ${dueAt}, updated_at = now() where id = ${row.id}`;
  await record(id, 'work.moved', dueAt ? `Due ${dueAt.slice(0, 10)}.` : 'No date on it.');
  send(res, 200, { ok: true, dueAt });
}

export async function workFor(caseId) {
  if (!caseId) return [];
  const rows = await sql()`
    select id, activity_id, title_encrypted, state, due_at, done_at, note_encrypted,
           created_at, updated_at, chapter_id
      from work where case_id = ${caseId} order by created_at asc
  `;
  return rows.map((w) => ({
    id: Number(w.id),
    activityId: w.activity_id === null || w.activity_id === undefined ? null : Number(w.activity_id),
    title: decrypt(w.title_encrypted),
    state: w.state,
    dueAt: w.due_at,
    doneAt: w.done_at,
    note: w.note_encrypted ? decrypt(w.note_encrypted) : null,
    late: w.done_at === null && w.state !== 'dropped' && w.due_at !== null
      && new Date(w.due_at).getTime() <= Date.now(),
    takenAt: w.created_at,
    movedAt: w.updated_at,
    chapterId: w.chapter_id,
  }));
}
