import { ensureSchema, sql } from './db.js';
import { callerKey, decrypt } from './crypto.js';
import { record } from './desk-events.js';
import { HttpError, readJson, send } from './http.js';
import { underLimit } from './settings.js';
import { requireAccount } from './auth.js';
import { bringFor } from './referrals.js';
import { chapterExtras } from './chapter-steps.js';
import { nextDueAt } from './desk.js';

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

async function roadmapFor(caseId) {
  if (!caseId) return [];
  const [now] = await sql()`
    select id, number, (select id from chapters where case_id = ${caseId} and number = 1) as first_id
      from chapters where case_id = ${caseId} and ended_at is null order by number desc limit 1
  `;
  const later = Boolean(now && now.number > 1);
  const current = (stamp) => !later || Number(stamp ?? now.first_id) === Number(now.id);
  const rows = await sql()`
    select a.id, a.title_encrypted, a.state, a.shown_at, a.next_at, a.closed_at, a.chapter_id,
           a.step_order_id is not null or a.step_chapter_id is not null as from_steps,
           exists (select 1 from projects w where w.activity_id = a.id
                    and w.delivered_at is null and w.state <> 'dropped') as yours
      from activities a
     where a.case_id = ${caseId} and a.state in ('todo', 'done')
     order by a.position asc, a.id asc
  `;
  return rows.map((a) => ({
    id: Number(a.id),
    title: open(a.title_encrypted),
    group: a.state,
    fromCall: Boolean(a.from_steps),
    since: a.shown_at,
    due: a.state === 'todo' ? a.next_at : null,
    at: a.state === 'done' ? a.closed_at : null,
    yours: Boolean(a.yours),
    current: current(a.chapter_id),
  })).filter((i) => i.title);
}

async function roadmapAndChapter(caseId) {
  const all = await roadmapFor(caseId);
  const extras = await chapterExtras(caseId);
  const strip = ({ current, ...rest }) => rest;
  return {
    ...extras,
    roadmap: all.filter((i) => i.current).map(strip),
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
    ...(await roadmapAndChapter(caseId)),
    bring: await bringFor(caseId),
  };
}

export async function tickActivity(req, res) {
  const account = requireAccount(req);
  await ensureSchema();
  if (!(await underLimit('client-step', callerKey(req), 120, 3600))) {
    throw new HttpError(429, "That's a lot of taps in an hour. Try again later.");
  }
  const body = await readJson(req);
  const activityId = Number(body.activity);
  if (!Number.isInteger(activityId) || activityId < 1) throw new HttpError(400, 'Which one? Reload the page and try again.');
  const done = body.done !== false;
  const [item] = await sql()`
    select a.id, a.state, a.cadence, a.title_encrypted, k.id as case_id, k.is_demo
      from activities a join cases k on k.id = a.case_id
     where a.id = ${activityId} and k.account_id = ${account}
  `;
  if (!item) throw new HttpError(404, "That isn't on your roadmap.");
  if (!['todo', 'done'].includes(item.state)) throw new HttpError(409, "That one isn't on your roadmap any more.");
  const changed = done
    ? await sql()`
        update activities set state = 'done', closed_at = now(), next_at = null, updated_at = now()
         where id = ${item.id} and state = 'todo' returning id
      `
    : await sql()`
        update activities set state = 'todo', closed_at = null, next_at = ${nextDueAt(item.cadence)}, updated_at = now()
         where id = ${item.id} and state = 'done' returning id
      `;
  if (changed.length) {
    const [order] = await sql()`select id from orders where case_id = ${item.case_id} order by id desc limit 1`;
    if (order) {
      await record(Number(order.id), done ? 'step.done' : 'step.undone',
        `${decrypt(item.title_encrypted)} ${done ? 'marked done' : 'put back to To do'} by the client.`);
    }
  }
  send(res, 200, { roadmap: await roadmapFor(Number(item.case_id)) });
}
