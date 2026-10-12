import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { send } from './http.js';
import {
  BLOCKER_RETURNS_AFTER_DAYS,
  CADENCES,
  REVIEW_PROMISE_HOURS,
  REVIEW_TARGET_HOURS,
} from './desk.js';
import { decrypt } from './crypto.js';
import { approachedNow } from './desk-approached.js';
import { confirmTargetHours, waitingPayments } from './confirm-speed.js';
import { referralLines } from './referrals.js';

export async function today(req, res) {
  requireAdmin(req);
  await ensureSchema();

  const calls = await sql()`
    select count(*) over () as total, o.id, o.case_id, o.reference_code, o.is_demo, o.is_mine,
           (select name_encrypted from cases where id = o.case_id) as name_encrypted,
           (select c.ended_at from calls c
             where c.order_id = o.id and c.transcript_encrypted is not null
             order by c.ended_at desc nulls last limit 1) as called_at
      from orders o
     where o.decision is null
       and exists (select 1 from calls c
                    where c.order_id = o.id and c.transcript_encrypted is not null)
       and coalesce((select p.decision from orders p
                      where o.case_id is not null and p.case_id = o.case_id and p.id < o.id
                        and p.decision is not null
                      order by p.id desc limit 1), '') <> 'go'
     order by called_at asc nulls last
     limit 50
  `;

  const followUps = await sql()`
    select count(*) over () as total, o.id, o.case_id, o.reference_code, o.is_demo, o.is_mine,
           (select name_encrypted from cases where id = o.case_id) as name_encrypted,
           (select c.ended_at from calls c
             where c.order_id = o.id and c.transcript_encrypted is not null
             order by c.ended_at desc nulls last limit 1) as called_at
      from orders o
     where o.decision is null and o.case_id is not null
       and o.recommendations_written_at is null
       and exists (select 1 from calls c
                    where c.order_id = o.id and c.transcript_encrypted is not null)
       and (select p.decision from orders p
             where p.case_id = o.case_id and p.id < o.id and p.decision is not null
             order by p.id desc limit 1) = 'go'
     order by called_at asc nulls last
     limit 50
  `;

  const unread = await sql()`
    select count(*) over () as total, k.id as case_id, o.id as order_id, o.reference_code, o.is_demo, o.is_mine,
           k.name_encrypted, m.at as wrote_at,
           k.blocked_at is not null as was_blocked
      from cases k
      join lateral (
        select max(created_at) as at from messages
         where account_id = k.account_id and author = 'client'
      ) m on true
      join lateral (
        select id, reference_code, is_demo, is_mine, case_id from orders
         where case_id = k.id order by id asc limit 1
      ) o on true
     where m.at is not null
       and (k.messages_read_at is null or m.at > k.messages_read_at)
       and (
         k.blocked_at is null
         or (k.blocked_until is not null and k.blocked_until <= now())
         or (k.blocked_until is null
             and k.blocked_at < now() - (${BLOCKER_RETURNS_AFTER_DAYS} || ' days')::interval)
       )
     order by m.at asc
     limit 50
  `;

  const due = await sql()`
    select count(*) over () as total, a.id as activity_id, a.title_encrypted, a.cadence, a.next_at,
           o.id as order_id, o.case_id, o.reference_code, o.is_demo, o.is_mine,
           (select name_encrypted from cases where id = o.case_id) as name_encrypted
      from activities a
      join lateral (
        select id, reference_code, is_demo, is_mine, case_id from orders
         where case_id = a.case_id order by id asc limit 1
      ) o on true
     where a.state = 'todo' and a.next_at is not null and a.next_at <= now()
     order by a.next_at asc
     limit 50
  `;

  const pivots = await sql()`
    select count(*) over () as total, c.case_id, c.name_encrypted as direction_encrypted, c.started_at,
           k.name_encrypted, o.id, o.reference_code, o.is_demo, o.is_mine
      from chapters c
      join cases k on k.id = c.case_id
      join lateral (select id, reference_code, is_demo, is_mine from orders
                     where case_id = c.case_id and status = 'confirmed' order by id desc limit 1) o on true
     where c.ended_at is null and c.number > 1 and c.decision is null and k.closed_at is null
     order by c.started_at asc
     limit 50
  `;

  const owing = await sql()`
    select count(*) over () as total, w.id as work_id, w.title_encrypted, w.due_at,
           o.id as order_id, o.case_id, o.reference_code, o.is_demo, o.is_mine,
           (select name_encrypted from cases where id = o.case_id) as name_encrypted
      from work w
      join lateral (
        select id, reference_code, is_demo, is_mine, case_id from orders
         where case_id = w.case_id order by id asc limit 1
      ) o on true
     where w.done_at is null and w.state <> 'dropped'
       and w.due_at is not null and w.due_at <= now()
     order by w.due_at asc
     limit 50
  `;

  const [demo] = await sql()`
    select exists(select 1 from orders where is_demo)
        or exists(select 1 from cases where is_demo) as there
  `;

  const now = Date.now();
  const hoursSince = (at) => (at ? (now - new Date(at).getTime()) / 3_600_000 : null);

  const approached = await approachedNow();

  const totalOf = (rows) => Number(rows[0]?.total || 0);

  const caseOf = (r) => (r.case_id === null || r.case_id === undefined ? null : Number(r.case_id));
  const called = (r) => ({
    id: Number(r.id),
    caseId: caseOf(r),
    reference: r.reference_code,
    calledAt: r.called_at,
    hoursWaiting: hoursSince(r.called_at),
    name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
    isDemo: Boolean(r.is_demo),
    isMine: Boolean(r.is_mine),
  });

  const toConfirm = await waitingPayments(now);

  send(res, 200, {
    referrals: await referralLines(),
    totals: {
      toConfirm: toConfirm.total,
      calls: totalOf(calls),
      pivots: totalOf(pivots),
      followUps: totalOf(followUps),
      unread: totalOf(unread),
      owing: totalOf(owing),
      due: totalOf(due),
    },
    approached,
    targetHours: REVIEW_TARGET_HOURS,
    confirmTargetHours: await confirmTargetHours(),
    toConfirm: toConfirm.rows,
    promiseHours: REVIEW_PROMISE_HOURS,
    demoData: Boolean(demo?.there),
    calls: calls.map(called),
    pivots: pivots.map((r) => ({
      id: Number(r.id),
      caseId: caseOf(r),
      reference: r.reference_code,
      direction: r.direction_encrypted ? decrypt(r.direction_encrypted) : 'a new chapter',
      hoursWaiting: hoursSince(r.started_at),
      name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
      isDemo: Boolean(r.is_demo),
      isMine: Boolean(r.is_mine),
    })),
    followUps: followUps.map(called),
    unread: unread.map((r) => ({
      id: Number(r.order_id),
      caseId: caseOf(r),
      reference: r.reference_code,
      wroteAt: r.wrote_at,
      hoursWaiting: hoursSince(r.wrote_at),
      wasBlocked: Boolean(r.was_blocked),
      name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
      isDemo: Boolean(r.is_demo),
      isMine: Boolean(r.is_mine),
    })),
    owing: owing.map((r) => ({
      id: Number(r.order_id),
      caseId: caseOf(r),
      workId: Number(r.work_id),
      reference: r.reference_code,
      title: decrypt(r.title_encrypted),
      dueAt: r.due_at,
      hoursWaiting: hoursSince(r.due_at),
      name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
      isDemo: Boolean(r.is_demo),
      isMine: Boolean(r.is_mine),
    })),
    due: due.map((r) => ({
      id: Number(r.order_id),
      caseId: caseOf(r),
      activityId: Number(r.activity_id),
      reference: r.reference_code,
      title: decrypt(r.title_encrypted),
      cadenceLabel: CADENCES[r.cadence]?.label || r.cadence,
      dueAt: r.next_at,
      hoursWaiting: hoursSince(r.next_at),
      name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
      isDemo: Boolean(r.is_demo),
      isMine: Boolean(r.is_mine),
    })),
  });
}

