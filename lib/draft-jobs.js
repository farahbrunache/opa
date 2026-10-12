import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, query, send } from './http.js';
import { FOLLOW_BUDGET_MS, POLL_EVERY_MS, jobState, tokenCost } from './draft.js';
import { recordSpend } from './spend.js';

export const RESUME_WITHIN_SECONDS = 15 * 60;
export const KEEP_DAYS = 7;
const USED_KEPT_SECONDS = 60 * 60;
const STALLED_SECONDS = 120;
const STATUS_TRIES = 3;
const SAVED_ELSEWHERE = new Set(['recap', 'gaps', 'roadmap']);

const following = new Map();

const familyOf = (kind) => String(kind || '').split(':')[0];
const cut = (text) => String(text || '').slice(0, 2000);
const ranFor = (row) => Math.max(0, Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000));

export async function noteSpend(draftRow, seconds) {
  if (!Number.isFinite(Number(seconds))) return;
  const [order] = await sql()`select is_demo, is_mine from orders where id = ${draftRow.order_id}`;
  const byTokens = tokenCost(draftRow.slot, draftRow.prompt_tokens, draftRow.completion_tokens);
  await recordSpend({
    kind: 'draft',
    source: `draft:${draftRow.id}`,
    amountCents: byTokens === null ? null : Math.round(byTokens * 100),
    seconds: Number(seconds),
    wasDemo: Boolean(order?.is_demo || order?.is_mine),
    orderId: Number(draftRow.order_id),
    at: draftRow.created_at,
  });
}

export async function closeAbandoned(id = null) {
  const abandoned = await sql()`
    update drafts
       set gave_up_at = now(),
           failure = coalesce(failure, model || ' job ' || coalesce(job_id, 'with no id')
             || ' was never seen to finish, and ' || ${String(RESUME_WITHIN_SECONDS / 60)}
             || ' minutes have passed. Press again to start a new job.')
     where (${id}::bigint is null or order_id = ${id})
       and finished_at is null and gave_up_at is null
       and created_at <= now() - (${RESUME_WITHIN_SECONDS} || ' seconds')::interval
    returning id, created_at, order_id
  `;
  for (const row of abandoned) await noteSpend(row, Math.round(FOLLOW_BUDGET_MS / 1000));
}

async function contextOf(id) {
  const [row] = await sql()`select context_encrypted from draft_jobs where draft_id = ${id}`;
  if (!row?.context_encrypted) return {};
  try {
    return JSON.parse(decrypt(row.context_encrypted));
  } catch {
    return {};
  }
}

const LOADERS = {
  fields: async () => (await import('./desk-callfields.js')).finishFields,
  gaps: async () => (await import('./desk-gaps.js')).finishGaps,
  questions: async () => (await import('./desk-questions.js')).finishQuestions,
  matches: async () => (await import('./desk-matches.js')).finishMatches,
  roadmap: async () => (await import('./desk-roadmap.js')).finishRoadmap,
};

async function finish(done, answer, context) {
  const family = familyOf(done.kind);
  if (family === 'recap') {
    await sql()`
      insert into recaps (draft_id, order_id, content_encrypted)
      values (${done.id}, ${done.order_id}, ${encrypt(answer.content)})
    `;
    return answer;
  }
  if (family === 'summary') return { ...answer, number: context.number ?? null };
  if (LOADERS[family]) return (await LOADERS[family]())(answer, context, done);
  return answer;
}

async function settle(row, answer) {
  const seconds = ranFor(row);
  const [done] = await sql()`
    update drafts
       set model = ${answer.model}, prompt_tokens = ${answer.promptTokens},
           completion_tokens = ${answer.completionTokens}, seconds = ${seconds},
           finished_at = now()
     where id = ${row.id} and finished_at is null and gave_up_at is null
    returning id, created_at, order_id, kind, slot, prompt_tokens, completion_tokens
  `;
  if (!done) return;
  await noteSpend(done, seconds);
  const context = await contextOf(done.id);
  let payload;
  try {
    payload = await finish(done, { ...answer, fellBack: Boolean(context.fellBack), seconds }, context);
  } catch (error) {
    await sql()`update drafts set failure = ${cut(error?.message || error)} where id = ${done.id}`;
    return;
  }
  const saved = SAVED_ELSEWHERE.has(familyOf(done.kind));
  await sql()`
    insert into draft_jobs (draft_id, result_encrypted, ready_at, used_at)
    values (${done.id}, ${encrypt(JSON.stringify(payload))}, now(), case when ${saved} then now() end)
    on conflict (draft_id) do update
      set result_encrypted = excluded.result_encrypted, ready_at = excluded.ready_at,
          used_at = excluded.used_at
  `;
}

async function giveUp(row, reason) {
  const [gone] = await sql()`
    update drafts set gave_up_at = now(), failure = ${cut(reason)}
     where id = ${row.id} and gave_up_at is null and finished_at is null
    returning id, created_at, order_id
  `;
  if (gone) await noteSpend(gone, ranFor(gone));
}

function overBudget(row, seen) {
  const minutes = Math.round(FOLLOW_BUDGET_MS / 60_000);
  return seen === 'IN_PROGRESS'
    ? `${row.model} started job ${row.job_id} and was still going after ${minutes} minutes, so it `
      + 'was given up. The worker ran and was paid for. Press again to start a new job.'
    : `${row.model} took job ${row.job_id} and nothing started it within ${minutes} minutes. It `
      + `sat ${seen === 'IN_QUEUE' ? 'queued' : `at ${seen.toLowerCase()}`} the whole time, which is `
      + 'what no free worker looks like. Press again to start a new job.';
}

async function track(id) {
  let seen = 'IN_QUEUE';
  let misses = 0;
  for (;;) {
    const [row] = await sql()`
      select id, order_id, slot, model, job_id, kind, created_at, finished_at, gave_up_at
        from drafts where id = ${id}
    `;
    if (!row || row.finished_at || row.gave_up_at || !row.job_id) return;
    if (Date.now() - new Date(row.created_at).getTime() > FOLLOW_BUDGET_MS) {
      await giveUp(row, overBudget(row, seen));
      return;
    }
    let state = null;
    try {
      state = await jobState(row.slot, row.job_id);
      misses = 0;
    } catch (error) {
      misses += 1;
      if (misses >= STATUS_TRIES) {
        await giveUp(row, `${error?.message || error} That was ${misses} checks in a row on job `
          + `${row.job_id} with no answer, so it was given up.`);
        return;
      }
    }
    if (state?.status) seen = state.status;
    if (state?.answer) return settle(row, state.answer);
    if (state?.failure) return giveUp(row, state.failure);
    await new Promise((done) => { setTimeout(done, POLL_EVERY_MS); });
  }
}

export function follow(id) {
  const key = Number(id);
  if (!following.has(key)) {
    const run = track(key)
      .catch((error) => console.error(`[one-percent] draft ${key} wasn't followed: ${error?.message || error}`))
      .finally(() => following.delete(key));
    following.set(key, run);
  }
  return following.get(key);
}

export function settleAll() {
  return Promise.all([...following.values()]);
}

export function forgetFollows() {
  following.clear();
}

export async function sweep() {
  await closeAbandoned();
  await sql()`
    update draft_jobs set result_encrypted = null, context_encrypted = null
     where (result_encrypted is not null or context_encrypted is not null)
       and (created_at < now() - (${KEEP_DAYS} || ' days')::interval
            or used_at < now() - (${USED_KEPT_SECONDS} || ' seconds')::interval)
  `;
  const open = await sql()`
    select id from drafts
     where finished_at is null and gave_up_at is null and job_id is not null
       and created_at > now() - (${RESUME_WITHIN_SECONDS} || ' seconds')::interval
  `;
  const started = open.filter((row) => !following.has(Number(row.id)));
  for (const row of started) follow(row.id);
  return started.length;
}

export function sweepQuietly() {
  sweep().catch((error) => console.error(`[one-percent] drafts weren't swept: ${error?.message || error}`));
}

export async function startJob(row, context) {
  await sql()`
    insert into draft_jobs (draft_id, context_encrypted)
    values (${row.id}, ${encrypt(JSON.stringify(context))})
  `;
  follow(row.id);
  return { draftId: Number(row.id), state: 'running' };
}

export async function markUsed(id, kind) {
  await sql()`
    update draft_jobs j set used_at = now()
      from drafts d
     where d.id = j.draft_id and d.kind is not distinct from ${kind}
       and j.ready_at is not null and j.used_at is null
       and d.order_id in (
         select o.id from orders o
          where o.id = ${id}
             or (o.case_id is not null and o.case_id = (select case_id from orders where id = ${id})))
  `;
}

function shape(row) {
  const out = {
    draftId: Number(row.id),
    kind: row.kind,
    orderId: Number(row.order_id),
    startedAt: row.created_at,
    readyAt: row.ready_at || null,
    model: row.model,
    seconds: row.seconds,
  };
  const stalled = row.finished_at && row.has_job && !row.ready_at
    && Date.now() - new Date(row.finished_at).getTime() > STALLED_SECONDS * 1000;
  if (row.gave_up_at || (row.finished_at && row.failure)) {
    return { ...out, state: 'failed', failure: row.failure || `${row.model} job ${row.job_id} was given up.` };
  }
  if (stalled) {
    return { ...out, state: 'failed',
      failure: `${row.model} finished job ${row.job_id}, and the server stopped before its result was `
        + 'saved. Press again to start a new job.' };
  }
  if (row.ready_at || (row.finished_at && !row.has_job)) {
    return { ...out, state: 'ready',
      payload: row.result_encrypted ? JSON.parse(decrypt(row.result_encrypted)) : null };
  }
  return { ...out, state: 'running' };
}

export async function jobsFor(id, caseId) {
  const rows = await sql()`
    select distinct on (d.kind) d.id, d.kind, d.order_id, d.model, d.seconds, d.job_id, d.failure,
           d.created_at, d.finished_at, d.gave_up_at, true as has_job,
           j.result_encrypted, j.ready_at, j.used_at
      from drafts d
      join orders o on o.id = d.order_id
      join draft_jobs j on j.draft_id = d.id
     where (d.order_id = ${id} or (${caseId}::bigint is not null and o.case_id = ${caseId}))
       and d.created_at > now() - (${KEEP_DAYS} || ' days')::interval
     order by d.kind, d.created_at desc, d.id desc
  `;
  return rows.map((row) => ({ ...shape(row), used: Boolean(row.used_at) }))
    .filter((job) => job.state !== 'ready' || (!job.used && job.payload))
    .map(({ used, ...job }) => job);
}

export async function draftResult(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const id = Number(query(req).get('id'));
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Say which draft to look at.');
  const [row] = await sql()`
    select d.id, d.kind, d.order_id, d.model, d.seconds, d.job_id, d.failure, d.created_at,
           d.finished_at, d.gave_up_at, j.draft_id is not null as has_job,
           j.result_encrypted, j.ready_at
      from drafts d left join draft_jobs j on j.draft_id = d.id
     where d.id = ${id}
  `;
  if (!row) throw new HttpError(404, `No draft ${id}.`);
  const job = shape(row);
  if (job.state === 'running' && row.job_id) follow(id);
  send(res, 200, job);
}
