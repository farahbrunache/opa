import { ensureSchema, sql } from './db.js';
import { callerKey, decrypt } from './crypto.js';
import { firstSentence, sheetSteps } from './sheet.js';
import { record } from './desk-events.js';
import { HttpError, readJson, send } from './http.js';
import { underLimit } from './settings.js';
import { requireAccount } from './auth.js';
import { bringFor } from './referrals.js';
import { chapterExtras, tickChapterStep } from './chapter-steps.js';

function open(sealed) {
  if (!sealed) return null;
  try {
    return decrypt(sealed);
  } catch {
    return null;
  }
}

function firstName(full) {
  const word = String(full || '').trim().split(/\s+/)[0];
  return word ? word.slice(0, 40) : null;
}

function otherParty(row) {
  if (row.to_link_encrypted) {
    const link = open(row.to_link_encrypted);
    let host = null;
    try {
      host = new URL(link).hostname.replace(/^www\./, '');
    } catch {
      host = null;
    }
    return {
      initial: host ? host[0].toUpperCase() : '?',
      name: host ? `Someone on ${host}` : 'Someone Farah knows',
      jobTitle: null,
    };
  }
  const name = open(row.other_name_encrypted);
  return {
    initial: name ? name.trim()[0].toUpperCase() : '1%',
    name: name ? name.trim().slice(0, 120) : 'Another One Percent member',
    jobTitle: row.other_job_title || null,
  };
}

const INTRODUCTION_STATUS = { waiting: 'Being introduced', worked: 'Introduced' };

async function introductionsFor(account, caseId) {
  const mine = sql()`select id from orders where client_account_id = ${account}`;
  const ids = (await mine).map((r) => Number(r.id));
  if (!ids.length) return [];
  const rows = await sql()`
    select i.outcome, i.reason_encrypted, i.to_link_encrypted, i.made_at,
           k.name_encrypted as other_name_encrypted,
           (select t.title from orders o2 join trades t on t.id = o2.trade_id
             where (o2.id = x.other_order or (k.id is not null and o2.case_id = k.id))
             order by o2.created_at desc limit 1) as other_job_title
      from introductions i
      cross join lateral (
        select case when i.a_order_id = any(${ids}::bigint[])
                      or (${caseId}::bigint is not null and i.a_case_id = ${caseId})
                    then i.b_order_id else i.a_order_id end as other_order
      ) x
      left join orders o on o.id = x.other_order
      left join cases k on k.id = o.case_id
     where (i.a_order_id = any(${ids}::bigint[]) or i.b_order_id = any(${ids}::bigint[])
            or (${caseId}::bigint is not null and (i.a_case_id = ${caseId} or i.b_case_id = ${caseId})))
       and i.outcome <> 'went nowhere'
     order by i.made_at asc
     limit 50
  `;
  return rows.map((row) => ({
    ...otherParty(row),
    status: INTRODUCTION_STATUS[row.outcome] || 'Being introduced',
    reason: open(row.reason_encrypted),
    at: row.made_at,
  }));
}

const MILESTONE_SAID = {
  planned: ['next', 'Planned'],
  'in progress': ['now', 'In progress'],
  worked: ['done', 'Done'],
  'changed direction': ['done', 'Changed direction'],
  stalled: ['now', 'Stalled'],
  ghosted: ['now', 'Stalled'],
};
const WORK_SAID = {
  'to do': ['next', 'To do'],
  doing: ['now', 'In progress'],
  delivered: ['done', 'Delivered'],
};
const QUOTE_SAID = {
  offered: ['now', 'Offer waiting on you'],
  'changes asked': ['now', 'You asked for a change'],
  agreed: ['now', 'Accepted'],
  paid: ['done', 'Paid'],
  declined: ['done', 'You declined'],
  withdrawn: ['done', 'Withdrawn'],
};

function item(kind, title, [group, said], at, due = null) {
  return { kind, title, group, said, at: at || null, due: due || null };
}

async function pathFor(account, caseId) {
  const items = [];
  const [now] = caseId ? await sql()`
    select id, number, (select id from chapters where case_id = ${caseId} and number = 1) as first_id
      from chapters where case_id = ${caseId} and ended_at is null order by number desc limit 1
  ` : [];
  const later = Boolean(now && now.number > 1);
  const current = (stamp) => !later || Number(stamp ?? now.first_id) === Number(now.id);
  if (caseId) {
    const milestones = await sql()`
      select m.title_encrypted, m.status, m.updated_at, m.chapter_id, p.in_force
        from milestones m join plans p on p.id = m.plan_id
       where p.case_id = ${caseId} and (p.in_force or ${later}) and m.shown_at is not null
       order by p.created_at asc, m.position asc
    `;
    for (const m of milestones) {
      if (!m.in_force && current(m.chapter_id)) continue;
      const said = MILESTONE_SAID[m.status] || MILESTONE_SAID.planned;
      items.push({ ...item('Milestone', open(m.title_encrypted), said,
        said[0] === 'done' ? m.updated_at : null), current: current(m.chapter_id) });
    }
    const work = await sql()`
      select title_encrypted, state, due_at, delivered_at, chapter_id from projects
       where case_id = ${caseId} and state <> 'dropped'
       order by created_at asc
    `;
    for (const w of work) {
      const said = WORK_SAID[w.state] || WORK_SAID['to do'];
      items.push({ ...item('Work', open(w.title_encrypted), said, w.delivered_at, w.due_at), current: current(w.chapter_id) });
    }
  }
  const quotes = await sql()`
    select scope_encrypted, status, created_at, answered_at, chapter_id from quotes
     where account_id = ${account} order by created_at asc limit 50
  `;
  for (const q of quotes) {
    const said = QUOTE_SAID[q.status] || QUOTE_SAID.offered;
    const scope = open(q.scope_encrypted) || '';
    const title = firstSentence(scope)[0].trim().slice(0, 160);
    items.push({ ...item('Offer', title, said, said[0] === 'done' ? q.answered_at || q.created_at : null),
      current: current(q.chapter_id) });
  }
  return items.filter((i) => i.title);
}

async function pathAndChapter(account, caseId) {
  const all = await pathFor(account, caseId);
  const extras = await chapterExtras(caseId);
  const strip = ({ current, ...rest }) => rest;
  return {
    ...extras,
    path: all.filter((i) => i.current).map(strip),
    earlier: extras.chapter ? all.filter((i) => !i.current).map(strip) : [],
  };
}

export async function pageExtras(account) {
  const [person] = await sql()`
    select id, name_encrypted, first_customer_at from cases where account_id = ${account}
  `;
  const caseId = person ? Number(person.id) : null;
  return {
    firstName: firstName(open(person?.name_encrypted)),
    firstCustomerAt: person?.first_customer_at || null,
    introductions: await introductionsFor(account, caseId),
    ...(await pathAndChapter(account, caseId)),
    bring: await bringFor(caseId),
  };
}

export async function ticksFor(orderIds) {
  if (!orderIds.length) return new Map();
  const rows = await sql()`
    select order_id, step from step_ticks
     where order_id = any(${orderIds}::bigint[]) order by step asc
  `;
  const out = new Map();
  for (const row of rows) {
    const key = Number(row.order_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(Number(row.step));
  }
  return out;
}

export async function tickStep(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  if (!(await underLimit('client-step', callerKey(req), 120, 3600))) {
    throw new HttpError(429, "That's a lot of taps in an hour. Try again later.");
  }
  const body = await readJson(req);
  const step = Number(body.step);
  const done = body.done !== false;
  if (body.chapter) {
    const ticked = await tickChapterStep(account, step, done);
    return send(res, 200, { chapter: ticked.chapter, stepsDone: ticked.done });
  }
  const reference = String(body.reference || '').trim();
  if (!reference) throw new HttpError(400, 'Which session? The reference code is missing.');

  const [order] = await sql()`
    select id, recommendations_encrypted, is_demo from orders
     where reference_code = ${reference} and client_account_id = ${account}
  `;
  if (!order) throw new HttpError(404, "That session isn't one linked to your account.");
  const count = sheetSteps(open(order.recommendations_encrypted)).steps.length;
  if (!Number.isInteger(step) || step < 1 || step > count) {
    throw new HttpError(400, count
      ? `Your next steps have ${count} step${count === 1 ? '' : 's'}. Reload the page and try again.`
      : "There are no next steps on that session yet.");
  }

  const changed = done
    ? await sql()`
        insert into step_ticks (order_id, step, is_demo)
        values (${order.id}, ${step}, ${order.is_demo})
        on conflict (order_id, step) do nothing
        returning step
      `
    : await sql()`
        delete from step_ticks where order_id = ${order.id} and step = ${step} returning step
      `;
  if (changed.length) {
    await record(order.id, done ? 'step.done' : 'step.undone',
      `Step ${step} ${done ? 'marked done' : 'unmarked'} by the client.`);
  }
  const ticks = await ticksFor([Number(order.id)]);
  send(res, 200, { reference, stepsDone: ticks.get(Number(order.id)) || [] });
}
