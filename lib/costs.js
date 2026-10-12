import { sql } from './db.js';
import { decrypt } from './crypto.js';
import { SESSION_PRICE_CENTS } from './orders.js';

export const COST_UNITS = ['month', 'draft-second'];

export function isCostUnit(value) {
  return COST_UNITS.includes(value);
}

export function lineCost(line) {
  const share = Number(line.share_percent ?? line.sharePercent ?? 100);
  const amount = Number(line.amount_cents ?? line.amountCents ?? 0) / 100;
  if (!Number.isFinite(share) || !Number.isFinite(amount)) return 0;
  return amount * (Math.max(0, Math.min(100, share)) / 100);
}

export async function costLines() {
  const rows = await sql()`
    select l.id, l.name, l.amount_cents, l.share_percent, l.every, l.note,
           l.order_id, o.reference_code
      from cost_lines l
      left join orders o on o.id = l.order_id
     order by l.every asc, l.name asc
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    amount: Number(r.amount_cents) / 100,
    sharePercent: Number(r.share_percent),
    every: r.every,
    note: r.note,
    forReference: r.reference_code || null,
    costs: lineCost(r),
  }));
}

export function callCostOf(record) {
  if (!record) return null;
  let held;
  try {
    held = JSON.parse(record);
  } catch {
    return null;
  }
  if (held?.demo === true) return null;
  const cents = held?.call_cost?.combined_cost;
  if (cents === null || cents === undefined || cents === '') return null;
  return Number.isFinite(Number(cents)) ? Number(cents) / 100 : null;
}

export function isSeededRecord(record) {
  if (!record) return false;
  try {
    return JSON.parse(record)?.demo === true;
  } catch {
    return false;
  }
}

export function draftSeconds(row) {
  if (row.seconds !== null && row.seconds !== undefined && Number.isFinite(Number(row.seconds))) {
    return Number(row.seconds);
  }
  const from = row.created_at ? new Date(row.created_at).getTime() : null;
  const to = row.gave_up_at ? new Date(row.gave_up_at).getTime() : null;
  if (!from || !to || to < from) return null;
  return Math.round((to - from) / 1000);
}

export function costOfOrder(order, perSecond) {
  const unknown = [];

  let calls = 0;
  for (const call of order.calls) {
    const cost = callCostOf(call.record);
    if (cost === null) {
      if (!isSeededRecord(call.record)) {
        unknown.push(call.hasRecord
          ? 'a call record with no cost in it'
          : 'a call with no record kept');
      }
      continue;
    }
    calls += cost;
  }

  let drafts = 0;
  let draftedSeconds = 0;
  for (const row of order.drafts) {
    const seconds = draftSeconds(row);
    if (seconds === null) {
      unknown.push('a draft with no time against it');
      continue;
    }
    draftedSeconds += seconds;
    if (perSecond !== null) drafts += seconds * perSecond;
  }
  if (draftedSeconds > 0 && perSecond === null) {
    unknown.push(`No line says what a second of drafting costs, so ${draftedSeconds} seconds of `
      + 'it is not priced');
  }

  const spent = calls + drafts;
  const tookIn = order.paid ? (order.kind === 'session' ? order.amountCents : SESSION_PRICE_CENTS) / 100 : 0;
  const counted = order.isDemo || order.isMine ? 0 : tookIn;
  return {
    id: order.id,
    reference: order.reference,
    isDemo: order.isDemo,
    isMine: Boolean(order.isMine),
    paid: order.paid,
    tookIn,
    counted,
    calls,
    drafts,
    draftedSeconds,
    spent,
    left: tookIn - spent,
    unknown,
  };
}

export const WINDOW_DAYS = 7;
export const DAYS_IN_A_MONTH = 30;

export const VERDICT_DAYS = 30;

async function windowOf(days, monthlyFixed, perSecond) {
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();

  const [row] = await sql()`
    select
      (select coalesce(count(*), 0)::int from orders
        where status = 'confirmed' and kind = 'call' and is_demo = false and is_mine = false
          and created_at >= ${since}) as sessions,
      (select coalesce(count(*), 0)::int from orders
        where (is_demo or is_mine) and kind = 'call' and created_at >= ${since}) as demo_sessions,
      (select coalesce(sum(card_amount_cents), 0)::bigint from orders
        where status = 'confirmed' and kind = 'session' and is_demo = false and is_mine = false
          and decided_at >= ${since}) as bought_cents
  `;

  const ledger = await sql()`
    select kind, was_demo,
           coalesce(sum(amount_cents), 0)::bigint as cents,
           coalesce(sum(seconds), 0)::bigint as seconds
      from spend where at >= ${since}
     group by kind, was_demo
  `;
  const pick = (kind, isDemo, field) =>
    Number(ledger.find((r) => r.kind === kind && Boolean(r.was_demo) === isDemo)?.[field] || 0);

  const clientCalls = pick('call', false, 'cents') / 100;
  const projectCalls = pick('call', true, 'cents') / 100;
  const clientSeconds = pick('draft', false, 'seconds');
  const projectSeconds = pick('draft', true, 'seconds');
  const priced = (seconds) => (perSecond === null ? 0 : seconds * perSecond);

  const billed = pick('drafting', true, 'cents') / 100;
  const billRead = ledger.some((r) => r.kind === 'drafting');
  const draftingCost = billRead ? billed : priced(clientSeconds) + priced(projectSeconds);

  const [attached] = await sql()`
    select
      coalesce(sum(case when order_id is null then 0 else amount_cents * share_percent / 100.0 end), 0)
        as client_cents,
      coalesce(sum(case when order_id is null then amount_cents * share_percent / 100.0 else 0 end), 0)
        as product_cents
      from cost_lines where every = 'month'
  `;
  const attachedToClients = Number(attached.client_cents) / 100;

  const sessions = Number(row.sessions);
  const tookIn = sessions * (SESSION_PRICE_CENTS / 100) + Number(row.bought_cents) / 100;

  const fixedShare = monthlyFixed === null
    ? null
    : (monthlyFixed * days) / DAYS_IN_A_MONTH;

  const servingClients = clientCalls
    + (billRead ? 0 : priced(clientSeconds))
    + (attachedToClients * days) / DAYS_IN_A_MONTH;
  const runningTheProject = projectCalls
    + (billRead ? draftingCost : priced(projectSeconds))
    + (fixedShare ?? 0);
  const spent = servingClients + runningTheProject;

  return {
    days,
    since,
    sessions,
    demoSessions: Number(row.demo_sessions),
    tookIn,
    servingClients,
    runningTheProject,
    clientCalls,
    clientSeconds,
    clientDrafts: billRead ? 0 : priced(clientSeconds),
    billRead,
    drafting: draftingCost,
    projectCalls,
    projectSeconds,
    projectDrafts: billRead ? draftingCost : priced(projectSeconds),
    fixedShare,
    spent,
    left: tookIn - spent,
  };
}

export const WEEKS_BACK = 8;

async function weeks(monthlyFixed, perSecond) {
  const span = WINDOW_DAYS * 24 * 3_600_000;
  const since = new Date(Date.now() - WEEKS_BACK * span).toISOString();
  const bucketOf = (at) => Math.floor((Date.now() - new Date(at).getTime()) / span);

  const empty = () => ({
    tookIn: 0, servingClients: 0, runningTheProject: 0, demoSessions: 0, sessions: 0,
  });
  const weekly = Array.from({ length: WEEKS_BACK }, empty);
  const into = (at) => {
    const bucket = bucketOf(at);
    return bucket >= 0 && bucket < WEEKS_BACK ? weekly[bucket] : null;
  };

  const sold = await sql()`
    select created_at, decided_at, kind, card_amount_cents, is_demo, is_mine from orders
     where status = 'confirmed' and coalesce(case when kind = 'session' then decided_at end, created_at) >= ${since}
  `;
  for (const order of sold) {
    if (order.kind === 'session') {
      const week = into(order.decided_at);
      if (week && !order.is_demo && !order.is_mine) week.tookIn += Number(order.card_amount_cents) / 100;
      continue;
    }
    const week = into(order.created_at);
    if (!week) continue;
    if (order.is_demo || order.is_mine) week.demoSessions += 1;
    else {
      week.sessions += 1;
      week.tookIn += SESSION_PRICE_CENTS / 100;
    }
  }

  const ledger = await sql()`
    select at, kind, was_demo, amount_cents, seconds from spend where at >= ${since}
  `;
  for (const line of ledger) {
    const week = into(line.at);
    if (!week) continue;
    let cost = null;
    if (line.kind === 'call') {
      cost = Number(line.amount_cents || 0) / 100;
    } else if (line.kind === 'draft' && perSecond !== null) {
      cost = Number(line.seconds || 0) * perSecond;
    }
    if (cost === null) continue;
    if (line.was_demo) week.runningTheProject += cost;
    else week.servingClients += cost;
  }

  const share = monthlyFixed === null ? 0 : (monthlyFixed * WINDOW_DAYS) / DAYS_IN_A_MONTH;
  return weekly.map((week, i) => {
    const spent = week.servingClients + week.runningTheProject + share;
    return {
      endedDaysAgo: i * WINDOW_DAYS,
      ...week,
      fixedShare: monthlyFixed === null ? null : share,
      spent,
      left: week.tookIn - spent,
    };
  });
}

export function whatClosesTheGap(window, sessionPrice, monthlyFixed) {
  const short = -window.left;
  if (short <= 0) return null;
  return {
    short,
    perSessionLeft: window.sessions > 0
      ? sessionPrice - window.servingClients / window.sessions
      : null,
    sessions: window.sessions > 0
      ? Math.ceil(short / Math.max(0.01, sessionPrice - window.servingClients / window.sessions))
      : null,
    perMonth: monthlyFixed === null ? null : (short * DAYS_IN_A_MONTH) / window.days,
  };
}

export async function costsNow() {
  const lines = await costLines();
  const perSecondLine = lines.find((l) => l.every === 'draft-second');
  const draftPerSecond = perSecondLine ? perSecondLine.costs : null;
  const monthly = lines.filter((l) => l.every === 'month' && !l.forReference);
  const monthlyFixed = monthly.length
    ? monthly.reduce((sum, l) => sum + l.costs, 0)
    : null;

  const rows = await sql()`
    select o.id, o.reference_code, o.is_demo, o.is_mine, o.status, o.kind, o.card_amount_cents,
           coalesce(
             (select json_agg(json_build_object(
                'record', c.record_encrypted, 'hasRecord', c.record_encrypted is not null))
                from calls c where c.order_id = o.id), '[]') as calls,
           coalesce(
             (select json_agg(json_build_object(
                'seconds', d.seconds, 'created_at', d.created_at, 'gave_up_at', d.gave_up_at))
                from drafts d where d.order_id = o.id), '[]') as drafts
      from orders o
     order by o.id desc
     limit 500
  `;

  const read = (value) => (typeof value === 'string' ? JSON.parse(value) : value) || [];
  const orders = rows.map((r) => costOfOrder({
    id: Number(r.id),
    reference: r.reference_code,
    isDemo: Boolean(r.is_demo),
    isMine: Boolean(r.is_mine),
    paid: r.status === 'confirmed',
    kind: r.kind,
    amountCents: Number(r.card_amount_cents),
    calls: read(r.calls).map((c) => ({
      record: c.record ? decrypt(c.record) : null,
      hasRecord: Boolean(c.hasRecord),
    })),
    drafts: read(r.drafts),
  }, draftPerSecond));

  const verdict = await windowOf(VERDICT_DAYS, monthlyFixed, draftPerSecond);

  const [boughtRows] = await sql()`
    select coalesce(sum(card_amount_cents), 0)::bigint as cents, count(*)::int as n
      from orders where status = 'confirmed' and kind = 'session' and not is_demo and not is_mine
  `;

  const sold = orders.filter((o) => o.paid && o.kind !== 'session' && !o.isDemo && !o.isMine);
  const demo = orders.filter((o) => o.kind !== 'session' && (o.isDemo || o.isMine));
  const total = (rows, pick) => rows.reduce((sum, o) => sum + pick(o), 0);
  const sessionsIn = total(sold, (o) => o.counted);
  const boughtIn = Number(boughtRows.cents) / 100;
  const spent = total(sold, (o) => o.spent);
  const demoSpent = total(demo, (o) => o.spent);

  const unknown = [...new Set(sold.flatMap((o) => o.unknown))];
  if (monthlyFixed === null) {
    unknown.push('Nothing is listed as a monthly cost, so what the servers cost is not in this');
  }

  return {
    sessions: sold.length,
    sessionsIn,
    bought: boughtRows.n,
    boughtIn,
    tookIn: sessionsIn + boughtIn,
    spent,
    monthlyFixed,
    lines,
    lastSeven: await windowOf(WINDOW_DAYS, monthlyFixed, draftPerSecond),
    verdict,
    closes: whatClosesTheGap(verdict, SESSION_PRICE_CENTS / 100, monthlyFixed),
    weeks: await weeks(monthlyFixed, draftPerSecond),
    perSession: sold.length ? spent / sold.length : null,
    demoSessions: demo.length,
    demoSpent,
    sessionPrice: SESSION_PRICE_CENTS / 100,
    unknown,
    orders: orders.slice(0, 50),
  };
}
