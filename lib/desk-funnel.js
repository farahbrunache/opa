import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { send } from './http.js';
import { FUNNEL_STAGES } from './desk.js';
import { approachedNow } from './desk-approached.js';

function rateOf(count, above) {
  if (above === null || above === 0 || count === null) return null;
  return Math.round((count / above) * 100);
}

export async function funnel(req, res) {
  requireAdmin(req);
  await ensureSchema();

  const rows = await sql()`
    with orders_seen as (
      select coalesce('case:' || o.case_id, 'order:' || o.id) as who,
             o.decision = 'go' as go,
             exists (select 1 from calls c
                      where c.order_id = o.id and c.transcript_encrypted is not null) as called,
             o.recommendation_done_at is not null as worked,
             exists (select 1 from held_sessions h where h.case_id = o.case_id) as bought,
             exists (select 1 from introductions i
                      where i.outcome = 'worked'
                        and (i.a_order_id = o.id or i.b_order_id = o.id
                             or (o.case_id is not null
                                 and (i.a_case_id = o.case_id or i.b_case_id = o.case_id)))
                    ) as introduced
        from orders o
       where o.status = 'confirmed' and o.kind = 'call'
         and not o.is_mine
    ),
    people as (
      select who,
             bool_or(worked or bought or introduced) as done,
             bool_or(worked or bought or introduced or go) as go,
             bool_or(worked or bought or introduced or go or called) as called
        from orders_seen
       group by who
    )
    select count(*) as paid,
           count(*) filter (where called) as called,
           count(*) filter (where go) as go,
           count(*) filter (where done) as done
      from people
  `;
  const counts = rows[0] || {};
  const pool = (await approachedNow()).total;

  let above = null;
  const stages = FUNNEL_STAGES.map((stage) => {
    const count = stage.key === 'pool' ? pool : Number(counts[stage.key] || 0);
    const rate = rateOf(count, above);
    above = count;
    return { key: stage.key, label: stage.label, count, rate, entered: Boolean(stage.entered) };
  });

  send(res, 200, { pool, stages });
}
