import { ensureSchema, sql } from './db.js';
import { readChoice } from './settings.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { askAndRecord, MODEL_CHOICE } from './desk-drafts.js';
import { nextDueAt, PLAN_PATHS } from './desk.js';
import { questionNotes } from './desk-questions.js';
import { scopeOf } from './chapter-scope.js';
import { prompt } from './prompts.js';

export const CHANGES_PER_DRAFT = 6;
const MAX_TITLE = 300;
const OUTCOME_CHARS = 400;

async function planOf(id) {
  const rows = await sql()`
    select p.id, p.path from plans p join orders o on o.case_id = p.case_id
     where o.id = ${id} and p.in_force
  `;
  return rows[0] || null;
}

async function roadmapRows(planId) {
  const milestones = await sql()`
    select id, position, title_encrypted, status, outcome_encrypted, shown_at
      from milestones where plan_id = ${planId} order by position asc
  `;
  const actions = await sql()`
    select a.id, a.milestone_id, a.title_encrypted, a.status, a.outcome_encrypted, a.shown_at
      from action_items a join milestones m on m.id = a.milestone_id
     where m.plan_id = ${planId}
     order by m.position asc, a.position asc
  `;
  return { milestones, actions };
}

export function readRoadmap(content, { milestones, actions }) {
  const lines = String(content || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  const summaryLine = lines.find((l) => /^summary\s*:/i.test(l));
  const split = (text) => {
    const at = text.lastIndexOf('|');
    const [title, reason] = at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
    return { title: title.trim().slice(0, MAX_TITLE), reason: reason.trim().slice(0, MAX_TITLE) };
  };
  const changes = [];
  const added = [];
  for (const line of lines) {
    if (changes.length === CHANGES_PER_DRAFT) break;
    let m = line.match(/^add\s+milestone\s*:\s*(.+)$/i);
    if (m) {
      const { title, reason } = split(m[1]);
      if (!title) continue;
      added.push(changes.length);
      changes.push({ op: 'add-milestone', title, reason });
      continue;
    }
    m = line.match(/^add\s+action\s+under\s+(m|new)\s*(\d+)\s*:\s*(.+)$/i);
    if (m) {
      const { title, reason } = split(m[3]);
      const n = Number(m[2]);
      if (!title) continue;
      if (m[1].toLowerCase() === 'm') {
        const step = milestones[n - 1];
        if (step) changes.push({ op: 'add-action', title, reason, milestoneId: Number(step.id), under: decrypt(step.title_encrypted) });
      } else if (added[n - 1] !== undefined) {
        changes.push({ op: 'add-action', title, reason, change: added[n - 1], under: changes[added[n - 1]].title });
      }
      continue;
    }
    m = line.match(/^(show)\s+m\s*(\d+)\b\s*[|:]?\s*(.*)$/i) || line.match(/^(send|drop)\s+a\s*(\d+)\b\s*[|:]?\s*(.*)$/i);
    if (!m) continue;
    const verb = m[1].toLowerCase();
    const reason = m[3].replace(/^\|\s*/, '').trim().slice(0, MAX_TITLE);
    if (verb === 'show') {
      const step = milestones[Number(m[2]) - 1];
      if (step && !step.shown_at) {
        changes.push({ op: 'show-milestone', milestoneId: Number(step.id), title: decrypt(step.title_encrypted), reason });
      }
    } else {
      const act = actions[Number(m[2]) - 1];
      if (act && !act.shown_at && act.status === 'open') {
        changes.push({ op: `${verb}-action`, actionId: Number(act.id), title: decrypt(act.title_encrypted), reason });
      }
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

export async function draftRoadmap(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const plan = await planOf(id);
  if (!plan) throw new HttpError(409, 'Set their goal first. The roadmap hangs off it.');
  const { milestones, actions } = await roadmapRows(plan.id);
  const [trade] = await sql()`
    select t.title, t.sector from orders o join trades t on t.id = o.trade_id where o.id = ${id}
  `;
  const { notes, said } = await questionNotes(id, await scopeOf(id));
  const asked = await askedQuestions(id);
  const cut = (v) => (v ? decrypt(v).slice(0, OUTCOME_CHARS) : 'nothing written');

  const roadmap = [];
  milestones.forEach((m, i) => {
    roadmap.push(`M${i + 1}. ${decrypt(m.title_encrypted)} · ${m.status} · `
      + `${m.shown_at ? 'on their page' : 'not on their page'} · outcome: ${cut(m.outcome_encrypted)}`);
    actions.forEach((a, j) => {
      if (String(a.milestone_id) !== String(m.id)) return;
      roadmap.push(`  A${j + 1}. ${decrypt(a.title_encrypted)} · ${a.status} · `
        + `${a.shown_at ? 'sent to them' : 'not sent'} · outcome: ${cut(a.outcome_encrypted)}`);
    });
  });

  const messages = [
    { role: 'system', content: await prompt('roadmap', { changes: CHANGES_PER_DRAFT }) },
    { role: 'user', content: [
      `Goal: ${PLAN_PATHS[plan.path]?.label || plan.path}.`,
      `Job title: ${trade ? `${trade.title} (${trade.sector})` : 'not set'}`,
      '', 'Notes:', ...notes,
      '', 'Conversation:', ...(said.length ? said : ['nothing said yet']),
      '', 'Questions asked:', ...(asked.length ? asked : ['none yet']),
      '', 'Roadmap:', ...(roadmap.length ? roadmap : ['nothing yet']),
    ].join('\n') },
  ];
  send(res, 202, await askAndRecord(id, messages, await readChoice(MODEL_CHOICE), 'roadmap', { plan: Number(plan.id) }));
}

export async function finishRoadmap(answer, context, done) {
  const rows = await roadmapRows(context.plan);
  const read = readRoadmap(answer.content, rows);
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
      (select max(greatest(a.closed_at, a.updated_at)) from action_items a join milestones m on m.id = a.milestone_id
        where m.plan_id = ${plan.id} and a.status <> 'open') as acted,
      (select max(updated_at) from milestones
        where plan_id = ${plan.id} and status not in ('planned', 'in progress')) as settled,
      (select count(*)::int from action_items a join milestones m on m.id = a.milestone_id
        where m.plan_id = ${plan.id} and a.status = 'open' and a.shown_at is not null) as out,
      (select count(*)::int from action_items a join milestones m on m.id = a.milestone_id
        where m.plan_id = ${plan.id} and a.status = 'open' and a.shown_at is null) as waiting
  `;
  const latest = [facts.acted, facts.settled].filter(Boolean).map((d) => new Date(d).getTime());
  const lastOutcome = latest.length ? Math.max(...latest) : null;
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

async function milestoneOf(id, milestoneId) {
  const plan = await planOf(id);
  const rows = plan
    ? await sql()`select id, title_encrypted, shown_at from milestones where id = ${milestoneId} and plan_id = ${plan.id}`
    : [];
  if (!rows.length) throw new HttpError(404, 'No milestone with that number under this person\'s current plan.');
  return rows[0];
}

export async function showMilestone(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const step = await milestoneOf(id, orderId(body.milestoneId));
  const shown = body.shown !== false;
  await sql()`update milestones set shown_at = ${shown ? new Date().toISOString() : null} where id = ${step.id}`;
  await record(id, shown ? 'milestone.shown' : 'milestone.hidden', decrypt(step.title_encrypted));
  send(res, 200, { ok: true, shown });
}

export const SENT_PER_MESSAGE = 10;

export async function markSent(id, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, SENT_PER_MESSAGE);
  if (!wanted.length) return 0;
  const plan = await planOf(id);
  if (!plan) return 0;
  const rows = await sql()`
    select a.id, a.cadence, a.title_encrypted from action_items a join milestones m on m.id = a.milestone_id
     where m.plan_id = ${plan.id} and a.id = any(${wanted}::bigint[]) and a.shown_at is null and a.status = 'open'
  `;
  for (const row of rows) {
    await sql()`
      update action_items set shown_at = now(), next_at = ${nextDueAt(row.cadence)}, updated_at = now()
       where id = ${row.id}
    `;
    await record(id, 'action.sent', decrypt(row.title_encrypted));
  }
  return rows.length;
}

async function apply(id, plan, draft, change) {
  if (change.op === 'add-milestone') {
    const [next] = await sql()`select coalesce(max(position), 0) + 1 as n from milestones where plan_id = ${plan.id}`;
    const [made] = await sql()`
      insert into milestones (plan_id, position, title_encrypted)
      values (${plan.id}, ${next.n}, ${encrypt(change.title)}) returning id
    `;
    await record(id, 'milestone.added', change.title);
    return { made: Number(made.id) };
  }
  if (change.op === 'add-action') {
    const milestoneId = change.change === undefined ? change.milestoneId : draft.changes[change.change]?.made;
    if (!milestoneId) throw new HttpError(409, 'Accept the milestone it goes under first.');
    const step = await milestoneOf(id, milestoneId);
    const [next] = await sql()`select coalesce(max(position), 0) + 1 as n from action_items where milestone_id = ${step.id}`;
    const [made] = await sql()`
      insert into action_items (milestone_id, position, title_encrypted)
      values (${step.id}, ${next.n}, ${encrypt(change.title)}) returning id
    `;
    await record(id, 'action.added', change.title);
    return { made: Number(made.id) };
  }
  if (change.op === 'show-milestone') {
    const step = await milestoneOf(id, change.milestoneId);
    await sql()`update milestones set shown_at = coalesce(shown_at, now()) where id = ${step.id}`;
    await record(id, 'milestone.shown', change.title);
    return {};
  }
  const [act] = await sql()`
    select a.id, a.status, a.shown_at from action_items a join milestones m on m.id = a.milestone_id
     where a.id = ${change.actionId} and m.plan_id = ${plan.id}
  `;
  if (!act || act.shown_at || act.status !== 'open') {
    throw new HttpError(409, 'That action has moved on since the draft. Skip this one.');
  }
  if (change.op === 'drop-action') {
    await sql()`
      update action_items set status = 'dropped', closed_at = now(), next_at = null, updated_at = now(),
             outcome_encrypted = ${encrypt('Taken off the roadmap.')}
       where id = ${act.id}
    `;
    await record(id, 'action.recorded', 'dropped. Taken off the roadmap.');
  }
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
  const index = Number(body.index);
  const change = draft.changes[index];
  if (!change || change.state !== 'open') throw new HttpError(409, 'That change is already decided.');
  const accept = body.decision === 'accept';
  if (accept && body.title !== undefined && change.op.startsWith('add-')) {
    const title = String(body.title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (!title) throw new HttpError(400, 'An empty line is not a step. Skip it instead.');
    change.title = title;
  }
  Object.assign(change, accept ? await apply(id, plan, draft, change) : {}, { state: accept ? 'accepted' : 'skipped' });
  const { id: draftId, createdAt, model, ...content } = draft;
  await sql()`update roadmap_drafts set content_encrypted = ${encrypt(JSON.stringify(content))} where id = ${draftId}`;
  await record(id, accept ? 'roadmap.accepted' : 'roadmap.skipped', change.title);
  send(res, 200, {
    ok: true, state: change.state,
    send: accept && change.op === 'send-action' ? { id: change.actionId, title: change.title } : null,
  });
}
