import { sql } from './db.js';

export function standingOf(sessions, id) {
  const mine = sessions.find((s) => Number(s.id) === Number(id)) || null;
  const own = { decision: mine?.decision || null, at: mine?.decision_at || null };
  const blank = { followUp: false, inherited: false, earlierNoGoAt: null };
  if (own.decision) return { ...own, ...blank };

  const latest = (list) => list
    .filter((s) => s.decision)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  const earlier = latest(sessions.filter((s) => Number(s.id) < Number(id)));
  if (earlier?.decision === 'go') {
    return { decision: 'go', at: earlier.decision_at, followUp: true, inherited: true, earlierNoGoAt: null };
  }
  if (mine?.called) {
    return { decision: null, at: null, followUp: false, inherited: false,
      earlierNoGoAt: earlier ? earlier.decision_at : null };
  }
  const any = latest(sessions);
  return any
    ? { decision: any.decision, at: any.decision_at, followUp: false, inherited: true, earlierNoGoAt: null }
    : { decision: null, at: null, ...blank };
}

export async function standingFor(id) {
  const sessions = await sql()`
    select o.id, o.decision, o.decision_at,
           exists (select 1 from calls c
                    where c.order_id = o.id and c.transcript_encrypted is not null) as called
      from orders o
     where o.id = ${id}
        or o.case_id = (select case_id from orders where id = ${id})
  `;
  return standingOf(sessions, id);
}
