import { ensureSchema, sql } from './db.js';
import { encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { PROJECT_DELIVERED, PROJECT_STATES, isProjectState } from './desk.js';
import { caseOf, orderId, record } from './desk-events.js';

function needsCase(caseId) {
  if (caseId === null) {
    throw new HttpError(
      409,
      'Nobody has signed in against this order yet, so there is nobody to owe work to. They '
        + 'link it by opening their claim link while signed in.',
    );
  }
  return caseId;
}

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

  let quoteId = null;
  if (body.quoteId) {
    const [order] = await sql()`select client_account_id from orders where id = ${id}`;
    const [quote] = await sql()`
      select id from quotes where id = ${orderId(body.quoteId)}
        and account_id = ${order?.client_account_id || ''}
    `;
    if (!quote) throw new HttpError(404, 'No quote with that number for this person.');
    quoteId = Number(quote.id);
  }

  await sql()`
    insert into projects (case_id, quote_id, title_encrypted, due_at, note_encrypted)
    values (${caseId}, ${quoteId}, ${encrypt(title)}, ${readDate(body.dueAt, 'the date it is due')},
            ${String(body.note || '').trim().slice(0, 1000)
              ? encrypt(String(body.note).trim().slice(0, 1000)) : null})
  `;
  await record(id, 'project.taken', title);
  send(res, 201, { ok: true });
}

export async function moveWork(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const [project] = await sql()`
    select id, state from projects where id = ${orderId(body.projectId)} and case_id = ${caseId}
  `;
  if (!project) throw new HttpError(404, 'No work with that number for this person.');

  const state = String(body.state || '');
  if (!isProjectState(state)) {
    throw new HttpError(400, `Pick a state: ${PROJECT_STATES.join(', ')}.`);
  }

  const delivered = state === PROJECT_DELIVERED;
  await sql()`
    update projects set
      state = ${state},
      delivered_at = case when ${delivered}
        then coalesce(case when state = ${PROJECT_DELIVERED} then delivered_at end, now()) end,
      note_encrypted = ${String(body.note || '').trim().slice(0, 1000)
        ? encrypt(String(body.note).trim().slice(0, 1000)) : null},
      updated_at = now()
    where id = ${project.id}
  `;
  await record(id, 'project.moved', `${state}. ${String(body.note || '').trim()}`.trim());
  send(res, 200, { ok: true, state });
}

export async function setWorkDue(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const [project] = await sql()`
    select id from projects where id = ${orderId(body.projectId)} and case_id = ${caseId}
  `;
  if (!project) throw new HttpError(404, 'No work with that number for this person.');

  const dueAt = readDate(body.dueAt, 'the date it is due');
  await sql()`update projects set due_at = ${dueAt}, updated_at = now() where id = ${project.id}`;
  await record(id, 'project.moved', dueAt ? `Due ${dueAt.slice(0, 10)}.` : 'No date on it.');
  send(res, 200, { ok: true, dueAt });
}
