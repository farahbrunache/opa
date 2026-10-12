import { sql } from './db.js';

import { noteCallSpend } from './spend.js';

export async function aCallCameBack(orderId) {
  const rows = await sql()`
    select 1 from calls
     where order_id = ${orderId} and transcript_encrypted is not null
     limit 1
  `;
  return rows.length > 0;
}

export async function secondsSpent(orderId, assumeFullAfter, budget, unreportedAfter) {
  for (const [name, value] of [
    ['assumeFullAfter', assumeFullAfter],
    ['budget', budget],
    ['unreportedAfter', unreportedAfter],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`secondsSpent needs ${name} as a number, and was given ${value}.`);
    }
  }

  const rows = await sql()`
    select coalesce(sum(
      case
        when seconds is not null then seconds
        when started_at < now() - ${unreportedAfter} * interval '1 second' then 0
        when started_at < now() - ${assumeFullAfter} * interval '1 second' then ${assumeFullAfter}
        else ${budget}
      end
    ), 0)::int as used
      from calls where order_id = ${orderId}
  `;
  return Number(rows[0]?.used || 0);
}

export async function reconcileStarts(orderId, unreportedAfter) {
  await sql()`
    update orders o set
      session_starts = coalesce(counted.attempts, 0),
      first_started_at = counted.began
    from (
      select
        count(*)::int as attempts,
        min(started_at) as began
      from calls
       where order_id = ${orderId}
         and (seconds is null or seconds > 0)
         and started_at > now() - ${unreportedAfter} * interval '1 second'
    ) as counted
    where o.id = ${orderId}
  `;
}

export async function keepRecord(callId, record) {
  const rows = await sql()`
    update calls set record_encrypted = ${record}, record_taken_at = now()
      where call_id = ${callId}
    returning id
  `;
  if (!rows.length) return false;

  await noteCallSpend(callId);
  return true;
}

export async function abandonCall(orderId, callId, withinSeconds) {
  const rows = await sql()`
    update calls set seconds = 0, ended_at = now()
      where order_id = ${orderId}
        and call_id = ${callId}
        and seconds is null
        and transcript_encrypted is null
        and started_at > now() - ${withinSeconds} * interval '1 second'
    returning id
  `;
  return rows.length > 0;
}
