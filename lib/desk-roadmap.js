import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { caseOf, orderId, record } from './desk-events.js';
import { askAndRecord } from './desk-drafts.js';
import { DROP_REASONS, PLAN_PATHS, SKIP_REASONS, isSkipReason } from './desk.js';
import { questionNotes } from './desk-questions.js';
import { scopeOf } from './chapter-scope.js';
import { prompt } from './prompts.js';
import { activitiesFor, insertActivity, moveActivity } from './desk-activities.js';

export const CHANGES_PER_DRAFT = 6;
const MAX_TITLE = 300;
const OUTCOME_CHARS = 400;

async function planOf(id) {
  const rows = await sql()`
    select p.id, p.path, p.case_id from plans p join orders o on o.case_id = p.case_id
     where o.id = ${id} and p.in_force
  `;
  return rows[0] || null;
}

export function readRoadmap(content, activities) {
  const lines = String(content || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  const summaryLine = lines.find((l) => /^summary\s*:/i.test(l));
  const split = (text) => {
    const at = text.lastIndexOf('|');
    const [title, reason] = at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
    return { title: title.trim().slice(0, MAX_TITLE), reason: reason.trim().slice(0, MAX_TITLE) };
  };
  const changes = [];
  for (const line of lines) {
    if (changes.length === CHANGES_PER_DRAFT) break;
    let m = line.match(/^add\s*:\s*(.+)$/i);
    if (m) {
      const { title, reason } = split(m[1]);
      if (title) changes.push({ op: 'add', title, reason });
      continue;
    }
    m = line.match(/^(move|drop)\s+a\s*(\d+)\b\s*[|:]?\s*(.*)$/i);
    if (!m) continue;
    const verb = m[1].toLowerCase();
    const reason = m[3].replace(/^\|\s*/, '').trim().slice(0, MAX_TITLE);
    const act = activities[Number(m[2]) - 1];
    if (!act) continue;
    if (verb === 'move' && act.state === 'drafted') {
      changes.push({ op: 'move', activityId: Number(act.id), title: decrypt(act.title_encrypted), reason });
    }
    if (verb === 'drop' && ['todo', 'drafted'].includes(act.state)) {
      changes.push({ op: 'drop', activityId: Number(act.id), title: decrypt(act.title_encrypted), reason });
    }
  }
  return {
    summary: summaryLine ? summaryLine.replace(/^summary\s*:\s*/i, '').slice(0, MAX_TITLE) : '',
    changes: changes.map((c) => ({ ...c, state: 'open' })),
  };
}

async function askedQuestions(id) {
  const rows = await sql()`
    select q.body_encrypted, max(a.asked_at) as at
      from question_asks a join questions q on q.id = a.question_id
      join orders o on o.case_id = a.case_id
     where o.id = ${id}
     group by q.id order by at asc
  `;
  return rows.map((r) => decrypt(r.body_encrypted));
}

async function rows(caseId) {
  return sql()`
    select id, title_encrypted, state, source, shown_at, outcome_encrypted, drop_reason, cadence, next_at
      from activities where case_id = ${caseId} order by position asc, id asc
  `;
}

async function skippedBefore(caseId) {
  const drafts = await sql()`
    select r.content_encrypted from roadmap_drafts r join orders o on o.id = r.order_id
     where o.case_id = ${caseId} order by r.created_at desc limit 20
  `;
  const out = [];
  for (const row of drafts) {
    const read = JSON.parse(decrypt(row.content_encrypted));
    for (const change of read.changes || []) {
      if (change.state !== 'skipped') continue;
      out.push(`${change.title}${change.skipReason ? ` · ${SKIP_REASONS[change.skipReason] || change.skipReason}` : ''}`);
    }
  }
  return out;
}

export async function draftRoadmap(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const plan = await planOf(id);
  if (!plan) throw new HttpError(409, 'Set their goal first. The roadmap hangs off it.');
  const caseId = Number(plan.case_id);
  const activities = await rows(caseId);
  const [trade] = await sql()`
    select t.title, t.sector from orders o join trades t on t.id = o.trade_id where o.id = ${id}
  `;
  const { notes, said } = await questionNotes(id, await scopeOf(id));
  const asked = await askedQuestions(id);
  const cut = (v) => (v ? decrypt(v).slice(0, OUTCOME_CHARS) : 'nothing written');

  const roadmap = [];
  const dropped = [];
  activities.forEach((a, i) => {
    const line = `A${i + 1}. ${decrypt(a.title_encrypted)} · ${a.state === 'todo' ? 'to do, on their page' : a.state}`
      + ` · outcome: ${cut(a.outcome_encrypted)}`;
    if (a.state === 'dropped') dropped.push(`${line} · why: ${DROP_REASONS[a.drop_reason] || a.drop_reason || 'not said'}`);
    else roadmap.push(line);
  });
  const skipped = await skippedBefore(caseId);

  const messages = [
    { role: 'system', content: await prompt('roadmap', { changes: CHANGES_PER_DRAFT }) },
    { role: 'user', content: [
      `Goal: ${PLAN_PATHS[plan.path]?.label || plan.path}.`,
      `Job title: ${trade ? `${trade.title} (${trade.sector})` : 'not set'}`,
      '', 'Notes:', ...notes,
      '', 'Conversation:', ...(said.length ? said : ['nothing said yet']),
      '', 'Questions asked:', ...(asked.length ? asked : ['none yet']),
      '', 'Roadmap:', ...(roadmap.length ? roadmap : ['nothing yet']),
      '', 'Dropped, do not propose again:', ...(dropped.length ? dropped : ['nothing']),
      '', 'Skipped from earlier drafts, do not propose again:', ...(skipped.length ? skipped : ['nothing']),
    ].join('\n') },
  ];
  send(res, 202, await askAndRecord(id, messages, 'roadmap', { plan: Number(plan.id), case: caseId }));
}

export async function finishRoadmap(answer, context, done) {
  const read = readRoadmap(answer.content, await rows(Number(context.case)));
  if (!read.changes.length && !read.summary) {
    throw new HttpError(502, 'The model answered without any changes in the shape asked for, '
      + 'so nothing was saved. Press again, or change the roadmap yourself.');
  }
  const [row] = await sql()`
    insert into roadmap_drafts (draft_id, order_id, content_encrypted)
    values (${done.id}, ${done.order_id}, ${encrypt(JSON.stringify({ ...read, plan: context.plan }))})
    returning id
  `;
  await record(Number(done.order_id), 'roadmap.drafted',
    `${read.changes.length} change${read.changes.length === 1 ? '' : 's'} proposed${read.summary ? `: ${read.summary}` : '.'}`);
  return { model: answer.model, seconds: answer.seconds, roadmap: Number(row.id) };
}

async function latestDraft(id) {
  const [row] = await sql()`
    select r.id, r.content_encrypted, r.created_at, d.model
      from roadmap_drafts r join drafts d on d.id = r.draft_id
      join orders o on o.id = r.order_id
     where o.id = ${id} or o.case_id = (select case_id from orders where id = ${id})
     order by r.created_at desc, r.id desc limit 1
  `;
  if (!row) return null;
  return { id: Number(row.id), createdAt: row.created_at, model: row.model, ...JSON.parse(decrypt(row.content_encrypted)) };
}

export async function roadmapFor(id) {
  const plan = await planOf(id);
  if (!plan) return null;
  const draft = await latestDraft(id);
  const current = draft && Number(draft.plan) === Number(plan.id) ? draft : null;
  const [facts] = await sql()`
    select
      (select max(closed_at) from activities where case_id = ${plan.case_id} and state in ('done', 'dropped')) as settled,
      (select count(*)::int from activities where case_id = ${plan.case_id} and state = 'todo') as out,
      (select count(*)::int from activities where case_id = ${plan.case_id} and state = 'drafted') as waiting
  `;
  const lastOutcome = facts.settled ? new Date(facts.settled).getTime() : null;
  let due = null;
  if (current?.changes.some((c) => c.state === 'open')) due = 'review';
  else if (lastOutcome && (!current || lastOutcome > new Date(current.createdAt).getTime())) due = 'redraw';
  else if (!facts.out && facts.waiting) due = 'send';
  return {
    due,
    draft: current && {
      id: current.id, createdAt: current.createdAt, model: current.model,
      summary: current.summary, changes: current.changes,
    },
  };
}

async function apply(id, caseId, change) {
  if (change.op === 'add') {
    const made = await insertActivity(caseId, change.title, { source: 'redraw' });
    await record(id, 'activity.added', change.title);
    return { made };
  }
  const [act] = await sql()`select state from activities where id = ${change.activityId} and case_id = ${caseId}`;
  if (change.op === 'move') {
    if (!act || act.state !== 'drafted') throw new HttpError(409, 'That activity has moved on since the draft. Skip this one.');
    await moveActivity(caseId, change.activityId);
    await record(id, 'activity.moved', change.title);
    return {};
  }
  if (!act || !['todo', 'drafted'].includes(act.state)) {
    throw new HttpError(409, 'That activity has moved on since the draft. Skip this one.');
  }
  await sql()`
    update activities set state = 'dropped', closed_at = now(), next_at = null, drop_reason = 'not-needed',
           outcome_encrypted = ${encrypt(change.reason || 'Taken off by a redraw.')}, updated_at = now()
     where id = ${change.activityId}
  `;
  await record(id, 'activity.dropped', `${change.title}. ${DROP_REASONS['not-needed']}. ${change.reason || ''}`.trim());
  return {};
}

export async function decideRoadmap(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const plan = await planOf(id);
  const draft = await latestDraft(id);
  if (!plan || !draft || draft.id !== Number(body.draft) || Number(draft.plan) !== Number(plan.id)) {
    throw new HttpError(409, 'That draft is not the latest one for this plan. Refresh the record.');
  }
  const caseId = Number(plan.case_id);
  const index = Number(body.index);
  const change = draft.changes[index];
  if (!change || change.state !== 'open') throw new HttpError(409, 'That change is already decided.');
  const accept = body.decision === 'accept';
  if (accept && body.title !== undefined && change.op === 'add') {
    const title = String(body.title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (!title) throw new HttpError(400, 'An empty line is not an activity. Skip it instead.');
    change.title = title;
  }
  const skipReason = String(body.reason || '');
  if (!accept && skipReason && !isSkipReason(skipReason)) {
    throw new HttpError(400, `Pick a reason: ${Object.values(SKIP_REASONS).join(', ')}.`);
  }
  Object.assign(change, accept ? await apply(id, caseId, change) : { skipReason: skipReason || null },
    { state: accept ? 'accepted' : 'skipped' });
  const { id: draftId, createdAt, model, ...content } = draft;
  await sql()`update roadmap_drafts set content_encrypted = ${encrypt(JSON.stringify(content))} where id = ${draftId}`;
  await record(id, accept ? 'roadmap.accepted' : 'roadmap.skipped',
    accept ? change.title : `${change.title}${skipReason ? `. ${SKIP_REASONS[skipReason]}` : ''}`);
  send(res, 200, {
    ok: true, state: change.state,
    send: accept && change.op === 'move' ? { id: change.activityId, title: change.title } : null,
  });
}

export async function roadmapRows(id) {
  const caseId = await caseOf(id);
  return activitiesFor(caseId);
}
