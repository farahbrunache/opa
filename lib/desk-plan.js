import { ensureSchema, sql } from './db.js';
import { encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { MILESTONE_STATUSES, PLAN_PATHS, isMilestoneStatus, isPlanPath } from './desk.js';
import { caseOf, orderId, record } from './desk-events.js';

function needsCase(caseId) {
  if (caseId === null) {
    throw new HttpError(
      409,
      'Nobody has signed in against this order yet, so there is no case to work with. They ' +
        'link it by opening their claim link while signed in.',
    );
  }
  return caseId;
}

export async function setPlan(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const path = String(body.path || '');
  if (!isPlanPath(path)) {
    throw new HttpError(400, `Pick a path: ${Object.keys(PLAN_PATHS).join(' or ')}.`);
  }

  const exists = await sql()`select 1 from orders where id = ${id} and status = 'confirmed'`;
  if (!exists.length) throw new HttpError(404, 'No confirmed order with that number.');
  const caseId = needsCase(await caseOf(id));

  const current = await sql()`select path from plans where case_id = ${caseId} and in_force`;
  if (current[0]?.path === path) {
    throw new HttpError(409, 'That path is already the one in force.');
  }

  await sql()`update plans set in_force = false where case_id = ${caseId} and in_force`;
  await sql()`insert into plans (order_id, case_id, path) values (${id}, ${caseId}, ${path})`;
  await record(id, 'plan.set', PLAN_PATHS[path].label);
  send(res, 200, { ok: true, path });
}

export async function addMilestone(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const title = String(body.title || '').trim().slice(0, 300);
  if (!title) throw new HttpError(400, 'A milestone needs a line saying what it is.');

  const caseId = needsCase(await caseOf(id));
  const plans = await sql()`select id from plans where case_id = ${caseId} and in_force`;
  if (!plans.length) throw new HttpError(409, 'Pick a path first — a milestone belongs to one.');

  const next = await sql()`
    select coalesce(max(position), 0) + 1 as n from milestones where plan_id = ${plans[0].id}
  `;
  await sql()`
    insert into milestones (plan_id, position, title_encrypted)
    values (${plans[0].id}, ${next[0].n}, ${encrypt(title)})
  `;
  await record(id, 'milestone.added', title);
  send(res, 201, { ok: true });
}

export async function recordMilestone(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const milestoneId = orderId(body.milestoneId);
  const status = String(body.status || '');
  if (!isMilestoneStatus(status)) {
    throw new HttpError(400, `Pick a status: ${MILESTONE_STATUSES.join(', ')}.`);
  }
  const outcome = String(body.outcome || '').trim().slice(0, 2000);

  const done = await sql()`
    update milestones m set
      status = ${status},
      outcome_encrypted = ${outcome ? encrypt(outcome) : null},
      updated_at = now()
     from plans p
    where m.id = ${milestoneId} and m.plan_id = p.id
      and p.order_id = ${id} and p.in_force
    returning m.id
  `;
  if (!done.length) {
    throw new HttpError(404, 'No milestone with that number under this person\'s current plan.');
  }
  await record(id, 'milestone.recorded', `${status}. ${outcome}`.trim());
  send(res, 200, { ok: true, status });
}
