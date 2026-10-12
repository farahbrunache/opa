import { ensureSchema, sql } from './db.js';
import { decrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { QUOTE_ANSWERS_WAITING, isQueueState } from './desk.js';
import { query, send } from './http.js';
import { approachedNow } from './desk-approached.js';
import { referralLines } from './referrals.js';

const PER_PAGE = 15;

const MILESTONES_PAST = ['worked', 'changed direction'];

export async function queue(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const params = query(req);
  const state = isQueueState(params.get('state')) ? params.get('state') : 'waiting';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const offset = (page - 1) * PER_PAGE;

  const asked = (params.get('q') || '').trim().toLowerCase().slice(0, 80);
  let matches = [];
  let matchedCases = [];
  if (asked) {
    const all = await sql()`
      select o.id, o.case_id, o.reference_code, k.name_encrypted
        from orders o
        left join cases k on k.id = o.case_id
       where exists (select 1 from calls c
                      where c.order_id = o.id and c.transcript_encrypted is not null)
    `;
    const found = all
      .filter((r) => String(r.reference_code || '').toLowerCase().includes(asked)
        || (r.name_encrypted && decrypt(r.name_encrypted).toLowerCase().includes(asked)));
    matches = found.map((r) => Number(r.id));
    matchedCases = found.filter((r) => r.case_id !== null).map((r) => Number(r.case_id));
  }

  const rows = await sql()`
      with base as (
        select o.id, o.reference_code, d.decision, d.follow_up,
               o.recommendations_written_at,
               coalesce(o.decision_at, case when d.follow_up then earlier.decision_at end) as decision_at,
               o.client_account_id is not null as linked, o.is_demo, o.is_mine,
               o.client_account_id as account_id, o.case_id, k.closed_at,
               k.name_encrypted,
               p.id as plan_id,
               (select c.ended_at from calls c
                 where c.order_id = o.id and c.transcript_encrypted is not null
                 order by c.ended_at desc nulls last limit 1) as called_at,
               (select c.seconds from calls c
                 where c.order_id = o.id and c.transcript_encrypted is not null
                 order by c.ended_at desc nulls last limit 1) as seconds,
               exists (select 1 from quotes q
                        where q.account_id = o.client_account_id
                          and q.status = any(${QUOTE_ANSWERS_WAITING})) as quote_waiting,
               d.decision is null as in_waiting,
               (exists (select 1 from orders a
                         where a.client_account_id = o.client_account_id
                           and a.approved_as_client_at is not null)
                  or exists (select 1 from quotes q
                              where q.account_id = o.client_account_id))
                 and coalesce((select m.author from messages m
                                where m.account_id = o.client_account_id
                                order by m.created_at desc limit 1) = 'client', false)
                 as in_replies,
               (d.decision = 'go'
                  or exists (select 1 from quotes q where q.account_id = o.client_account_id))
                 and k.closed_at is null as in_active,
               k.closed_at is not null
                 or (d.decision is not null
                     and not (d.decision = 'go'
                              or exists (select 1 from quotes q
                                          where q.account_id = o.client_account_id)))
                 as in_closed
          from orders o
          left join cases k on k.id = o.case_id
          left join lateral (
            select id from plans
             where in_force
               and (order_id = o.id or (o.case_id is not null and case_id = o.case_id))
             limit 1
          ) p on true
          left join lateral (
            select e.decision, e.decision_at from orders e
             where o.case_id is not null and e.case_id = o.case_id and e.id < o.id
               and e.decision is not null
             order by e.id desc limit 1
          ) earlier on true
          cross join lateral (
            select coalesce(o.decision, case when earlier.decision = 'go' then 'go' end) as decision,
                   o.decision is null and coalesce(earlier.decision = 'go', false) as follow_up
          ) d
         where exists (select 1 from calls c
                        where c.order_id = o.id and c.transcript_encrypted is not null)
           and (o.case_id is null
                or o.id = (select max(l.id) from orders l
                            where l.case_id = o.case_id
                              and exists (select 1 from calls c
                                           where c.order_id = l.id
                                             and c.transcript_encrypted is not null)))
      ),
      counts as (
        select count(*) filter (where in_waiting)::int as waiting,
               count(*) filter (where in_replies)::int as replies,
               count(*) filter (where in_active)::int as active,
               count(*) filter (where in_closed)::int as closed
          from base
      )
      select shown.*, to_json(counts.*) as counts, facts.*,
             intro.id is not null as intro_waiting,
             io.reference_code as intro_reference, ik.name_encrypted as intro_name_encrypted
        from counts
        left join (
          select base.*, count(*) over () as total
            from base
           where case when ${Boolean(asked)}
                        then base.id = any(${matches}::bigint[])
                          or base.case_id = any(${matchedCases}::bigint[])
                      else case ${state}
                             when 'waiting' then in_waiting
                             when 'replies' then in_replies
                             when 'active'  then in_active
                             else                in_closed
                           end
                 end
           order by base.id desc
           limit ${PER_PAGE} offset ${offset}
        ) shown on true
        left join lateral (
          select
            exists (select 1 from calls c where c.order_id = shown.id
                     and c.fields_encrypted is not null) as call_read,
            (select max(m.created_at) from messages m
              where m.account_id = shown.account_id and m.author = 'client') as wrote_at,
            (select max(m.created_at) from messages m
              where m.account_id = shown.account_id
                and m.author in ('client', 'operator')) as last_contact_at,
            (select count(*)::int from milestones m where m.plan_id = shown.plan_id) as milestones,
            (select count(*)::int from milestones m
              where m.plan_id = shown.plan_id
                and m.status = any(${MILESTONES_PAST})) as milestones_past,
            (select sum(q.amount_cents)::int from quotes q
              where q.account_id = shown.account_id and q.status = 'agreed' and q.paid_at is null
                and q.due_at is not null and q.due_at <= now()) as late_cents,
            (select min(q.due_at) from quotes q
              where q.account_id = shown.account_id and q.status = 'agreed' and q.paid_at is null
                and q.due_at is not null and q.due_at <= now()) as late_due_at,
            (select min(w.due_at) from projects w
              where w.case_id = shown.case_id and w.delivered_at is null and w.state <> 'dropped'
                and w.due_at is not null and w.due_at <= now()) as work_due_at,
            (select q.amount_cents from quotes q
              where q.account_id = shown.account_id and q.status = 'offered'
              order by q.created_at desc limit 1) as offer_cents,
            (select min(a.next_at) from action_items a
               join milestones m on m.id = a.milestone_id
              where m.plan_id = shown.plan_id and a.status = 'open'
                and a.next_at is not null) as reminder_at
        ) facts on shown.id is not null
        left join lateral (
          select i.id,
                 case when i.a_order_id = shown.id
                        or (shown.case_id is not null and i.a_case_id = shown.case_id)
                      then i.b_order_id else i.a_order_id end as other_id
            from introductions i
           where i.outcome = 'waiting'
             and (i.a_order_id = shown.id or i.b_order_id = shown.id
                  or (shown.case_id is not null
                      and (i.a_case_id = shown.case_id or i.b_case_id = shown.case_id)))
           order by i.made_at desc
           limit 1
        ) intro on shown.id is not null
        left join orders io on io.id = intro.other_id
        left join cases ik on ik.id = io.case_id
       order by shown.id desc
    `;

  const counts = rows[0].counts;
  const people = rows.filter((r) => r.id !== null);

  const [paid] = await sql()`
    select count(distinct coalesce('case:' || case_id, 'order:' || id))::int as people
      from orders where status = 'confirmed' and not is_mine
  `;

  const undecided = await sql()`
    select o.id, c.name_encrypted from chapters c join orders o on o.case_id = c.case_id
     where c.ended_at is null and c.number > 1 and c.decision is null
  `;
  const pivots = Object.fromEntries(undecided.map((r) => [r.id, r.name_encrypted ? decrypt(r.name_encrypted) : 'a new chapter']));

  send(res, 200, {
    pivots,
    referrals: await referralLines(),
    state,
    page,
    asked,
    counts,
    approached: (await approachedNow()).total,
    paid: Number(paid?.people || 0),
    perPage: PER_PAGE,
    total: Number(people[0]?.total || 0),
    people: people.map((r) => ({
      id: r.id,
      reference: r.reference_code,
      name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
      calledAt: r.called_at,
      seconds: r.seconds,
      decision: r.decision,
      followUp: Boolean(r.follow_up),
      recommendedAt: r.recommendations_written_at,
      linked: r.linked,
      quoteWaiting: Boolean(r.quote_waiting),
      isDemo: Boolean(r.is_demo),
      isMine: Boolean(r.is_mine),
      group: r.in_waiting ? 'waiting' : r.in_replies ? 'replies' : r.in_active ? 'active' : 'closed',
      callRead: Boolean(r.call_read),
      wroteAt: r.wrote_at,
      lastContactAt: r.last_contact_at || r.decision_at,
      closedAt: r.closed_at || r.decision_at,
      milestones: Number(r.milestones || 0),
      milestonesPast: Number(r.milestones_past || 0),
      lateAmount: r.late_cents === null ? null : Number(r.late_cents) / 100,
      lateDueAt: r.late_due_at,
      workDueAt: r.work_due_at,
      offerAmount: r.offer_cents === null ? null : Number(r.offer_cents) / 100,
      reminderAt: r.reminder_at,
      introWaiting: Boolean(r.intro_waiting),
      introWith: r.intro_name_encrypted ? decrypt(r.intro_name_encrypted) : r.intro_reference || null,
    })),
  });
}
