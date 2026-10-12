import { sql } from './db.js';
import { decrypt } from './crypto.js';
import { callCostOf, draftSeconds, isSeededRecord } from './costs.js';

export async function recordSpend({ kind, source, amountCents, seconds, wasDemo, orderId, at }) {
  await sql()`
    insert into spend (kind, source, amount_cents, seconds, was_demo, order_id, at)
    values (${kind}, ${source}, ${amountCents ?? null}, ${seconds ?? null},
            ${Boolean(wasDemo)}, ${orderId ?? null}, ${at || new Date().toISOString()})
    on conflict (source) do nothing
  `;
}

export async function recordMeteredSpend({ kind, source, amountCents, wasDemo, at, endpointId = null, seconds = null }) {
  await sql()`
    insert into spend (kind, source, amount_cents, was_demo, at, endpoint_id, seconds)
    values (${kind}, ${source}, ${amountCents}, ${Boolean(wasDemo)}, ${at}, ${endpointId}, ${seconds})
    on conflict (source) do update set amount_cents = excluded.amount_cents, seconds = excluded.seconds
  `;
}

export async function noteCallSpend(callId) {
  const [kept] = await sql()`
    select c.id, c.record_encrypted, c.started_at, o.id as order_id, o.is_demo, o.is_mine
      from calls c join orders o on o.id = c.order_id
     where c.call_id = ${callId}
  `;
  if (!kept?.record_encrypted) return;
  let held;
  try {
    held = decrypt(kept.record_encrypted);
  } catch {
    return;
  }
  if (isSeededRecord(held)) return;
  const cost = callCostOf(held);
  if (cost === null) return;
  await recordSpend({
    kind: 'call',
    source: `voice:${kept.id}`,
    amountCents: Math.round(cost * 100),
    wasDemo: kept.is_demo || kept.is_mine,
    orderId: Number(kept.order_id),
    at: kept.started_at,
  });
}

export async function backfillSpend() {
  const calls = await sql()`
    select c.id, c.record_encrypted, c.started_at, o.id as order_id, o.is_demo, o.is_mine
      from calls c join orders o on o.id = c.order_id
     where c.record_encrypted is not null
       and not exists (select 1 from spend s where s.source = 'voice:' || c.id)
  `;
  for (const call of calls) {
    let held;
    try {
      held = decrypt(call.record_encrypted);
    } catch {
      continue;
    }
    if (isSeededRecord(held)) continue;
    const cost = callCostOf(held);
    if (cost === null) continue;
    await recordSpend({
      kind: 'call',
      source: `voice:${call.id}`,
      amountCents: Math.round(cost * 100),
      wasDemo: call.is_demo || call.is_mine,
      orderId: Number(call.order_id),
      at: call.started_at,
    });
  }

  const drafts = await sql()`
    select d.id, d.seconds, d.created_at, d.gave_up_at, o.id as order_id, o.is_demo, o.is_mine
      from drafts d join orders o on o.id = d.order_id
     where not exists (select 1 from spend s where s.source = 'draft:' || d.id)
  `;
  for (const row of drafts) {
    const seconds = draftSeconds(row);
    if (seconds === null) continue;
    await recordSpend({
      kind: 'draft',
      source: `draft:${row.id}`,
      seconds,
      wasDemo: row.is_demo || row.is_mine,
      orderId: Number(row.order_id),
      at: row.created_at,
    });
  }
}
