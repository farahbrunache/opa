import { sql } from './db.js';
import { draftCost, endpointRates } from './costs.js';
import { FAMILIES, familyOf } from './desk-drafts.js';
import { pricesSet, ratesNow } from './sessions.js';

export const PRICE_DAYS = 30;
const REVIEW_WINDOW_MINUTES = 30;
const ROUND_TO = 5;

function dollars(raw) {
  const n = Number(String(raw || '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function hourRates() {
  const set = await pricesSet();
  const low = dollars(set.hourLow);
  const high = dollars(set.hourHigh);
  if (low === null || high === null) return null;
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

function median(values) {
  const sorted = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundUp(value) {
  return Math.ceil(value / ROUND_TO) * ROUND_TO;
}

export function priceOf({ minutes, ai, rate }) {
  if (minutes === null || ai === null || rate === null) return null;
  return roundUp((minutes / 60) * rate + ai);
}

export function leftOf({ price, minutes, ai, rate }) {
  if (price === null || minutes === null || ai === null || rate === null) return null;
  return price - ai - (minutes / 60) * rate;
}

export async function priceNow(perSecond) {
  const since = new Date(Date.now() - PRICE_DAYS * 24 * 3_600_000).toISOString();
  const [time] = await sql()`
    select coalesce(sum(t.seconds), 0)::int as seconds, count(distinct coalesce(o.case_id, o.id))::int as clients
      from step_times t join orders o on o.id = t.order_id
     where t.at >= ${since} and not o.is_demo and not o.is_mine
  `;
  const drafts = await sql()`
    select d.id, d.kind, d.slot, d.endpoint_id, d.seconds, d.created_at, d.gave_up_at, d.finished_at,
           d.prompt_tokens, d.completion_tokens
      from drafts d join orders o on o.id = d.order_id
     where d.created_at >= ${since} and not o.is_demo and not o.is_mine
  `;
  const reviews = await sql()`
    select distinct on (d.id) d.id, t.seconds
      from drafts d
      join orders o on o.id = d.order_id
      join step_times t on t.order_id = d.order_id and t.at > d.finished_at
       and t.at <= d.finished_at + (${REVIEW_WINDOW_MINUTES} || ' minutes')::interval
     where d.finished_at >= ${since} and not o.is_demo and not o.is_mine
     order by d.id, t.at
  `;
  const [used] = await sql()`
    select count(*)::int as n from held_sessions where used_at >= ${since} and not is_demo
  `;
  const billedRates = await endpointRates(PRICE_DAYS);
  const reviewOf = new Map(reviews.map((r) => [Number(r.id), Number(r.seconds)]));

  let ai = 0;
  let aiUnknown = 0;
  const buttons = FAMILIES.map(([family, label]) => {
    const rows = drafts.filter((d) => familyOf(d.kind) === family);
    const costs = rows.map((d) => draftCost(d, perSecond, billedRates));
    const known = costs.filter((c) => c !== null);
    return {
      family,
      label,
      presses: rows.length,
      seconds: median(rows.map((d) => (d.seconds === null ? null : Number(d.seconds)))),
      cost: median(known),
      unpriced: costs.length - known.length,
      review: median(rows.map((d) => reviewOf.get(Number(d.id)) ?? null)),
    };
  });
  for (const d of drafts) {
    const cost = draftCost(d, perSecond, billedRates);
    if (cost === null) aiUnknown += 1;
    else ai += cost;
  }

  const clients = Number(time.clients);
  const minutesAClient = clients ? Number(time.seconds) / 60 / clients : null;
  const aiAClient = clients ? ai / clients : null;
  const sessionsAClient = clients ? Number(used.n) / clients : null;
  const perSession = Math.max(1, sessionsAClient || 0);
  const minutesASession = minutesAClient === null ? null : minutesAClient / perSession;
  const aiASession = aiAClient === null ? null : aiAClient / perSession;

  const rates = await hourRates();
  const at = (rate) => ({ minutes: minutesASession, ai: aiASession, rate });
  const suggested = rates && minutesASession !== null
    ? { low: priceOf(at(rates.low)), high: priceOf(at(rates.high)) }
    : null;
  const posted = await ratesNow();
  const leaves = (price) => (rates && minutesASession !== null
    ? { low: leftOf({ price, ...at(rates.high) }), high: leftOf({ price, ...at(rates.low) }) }
    : null);

  return {
    days: PRICE_DAYS,
    clients,
    minutesAClient,
    aiAClient,
    aiUnknown,
    sessionsAClient,
    minutesASession,
    aiASession,
    rates,
    set: await pricesSet(),
    suggested,
    posted: posted ? {
      standard: { price: posted.standard, leaves: leaves(posted.standard) },
      access: { price: posted.access, leaves: leaves(posted.access) },
    } : null,
    buttons,
  };
}
