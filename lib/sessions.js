import { sql } from './db.js';
import { decrypt } from './crypto.js';
import { RATE_LABELS } from './desk.js';
import { record } from './desk-events.js';
import { readChoice, writeChoice } from './settings.js';

export const OWNER_OFFSET_HOURS = -4;

function dollars(raw) {
  const n = Number(String(raw || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function whole(raw) {
  const n = Number(String(raw || '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const PRICES = {
  hourLow: 'price:hour-low',
  hourHigh: 'price:hour-high',
  standard: 'price:standard',
  access: 'price:access',
  aMonth: 'price:access-a-month',
};

export async function pricesSet() {
  const out = {};
  for (const [key, name] of Object.entries(PRICES)) out[key] = await readChoice(name);
  return out;
}

export async function savePrices(given) {
  const read = {
    hourLow: dollars(given.hourLow),
    hourHigh: dollars(given.hourHigh),
    standard: dollars(given.standard),
    access: dollars(given.access),
    aMonth: whole(given.aMonth),
  };
  for (const key of Object.keys(PRICES)) {
    const raw = String(given[key] ?? '').trim();
    if (raw && read[key] === null) return key;
  }
  for (const [key, name] of Object.entries(PRICES)) {
    await writeChoice(name, read[key] === null ? '' : String(read[key]));
  }
  return null;
}

export async function ratesNow() {
  const set = await pricesSet();
  const standard = dollars(set.standard);
  const access = dollars(set.access);
  const aMonth = whole(set.aMonth);
  if (standard === null || access === null || aMonth === null) return null;
  return { standard, access, aMonth };
}

export function monthOf(at = Date.now()) {
  const shifted = new Date(new Date(at).getTime() + OWNER_OFFSET_HOURS * 3_600_000);
  return shifted.toISOString().slice(0, 7);
}

export function monthAfter(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

async function latestOrder(caseId) {
  const [row] = await sql()`select id from orders where case_id = ${caseId} order by id desc limit 1`;
  return row ? Number(row.id) : null;
}

async function given(month) {
  const [row] = await sql()`
    select count(*)::int as n from access_requests where month = ${month} and granted_at is not null
  `;
  return Number(row.n);
}

export async function grantDue(now = Date.now()) {
  const rates = await ratesNow();
  if (!rates) return 0;
  const month = monthOf(now);
  let left = rates.aMonth - await given(month);
  if (left <= 0) return 0;
  const waiting = await sql()`
    select id, case_id from access_requests
     where granted_at is null and month <= ${month}
     order by requested_at asc, id asc
     limit ${left}
  `;
  for (const row of waiting) {
    await sql()`update access_requests set granted_at = now(), month = ${month} where id = ${row.id}`;
    const order = await latestOrder(Number(row.case_id));
    if (order) await record(order, 'access.given', `For ${monthName(month)}, off the list.`);
    left -= 1;
  }
  return waiting.length;
}

export async function accessNow(now = Date.now()) {
  const rates = await ratesNow();
  if (!rates) return null;
  await grantDue(now);
  const month = monthOf(now);
  const next = monthAfter(month);
  const got = await given(month);
  const [waiting] = await sql()`
    select count(*)::int as n from access_requests where granted_at is null
  `;
  return {
    month,
    monthName: monthName(month),
    nextMonthName: monthName(next),
    cap: rates.aMonth,
    given: got,
    left: Math.max(0, rates.aMonth - got),
    waiting: Number(waiting.n),
  };
}

export async function requestsFor(caseId) {
  const rows = await sql()`
    select r.id, r.month, r.requested_at, r.granted_at, r.order_id, o.reference_code, o.status
      from access_requests r left join orders o on o.id = r.order_id
     where r.case_id = ${caseId}
     order by r.requested_at desc, r.id desc
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    month: r.month,
    monthName: monthName(r.month),
    requestedAt: r.requested_at,
    grantedAt: r.granted_at,
    orderReference: r.reference_code || null,
    orderStatus: r.status || null,
  }));
}

export async function requestAccess(caseId, isDemo = false, now = Date.now()) {
  const access = await accessNow(now);
  if (!access) return null;
  const [open] = await sql()`
    select id from access_requests
     where case_id = ${caseId} and (granted_at is null or order_id is null
            or exists (select 1 from orders o where o.id = order_id and o.status = 'pending'))
     limit 1
  `;
  if (open) return { already: true };
  const order = await latestOrder(caseId);
  if (access.left > 0) {
    const [made] = await sql()`
      insert into access_requests (case_id, month, granted_at, is_demo)
      values (${caseId}, ${access.month}, now(), ${isDemo}) returning id
    `;
    if (order) {
      await record(order, 'access.requested', `For ${access.monthName}.`);
      await record(order, 'access.given', `${access.given + 1} of ${access.cap} this month.`);
    }
    return { granted: true, id: Number(made.id) };
  }
  const next = monthAfter(access.month);
  const [made] = await sql()`
    insert into access_requests (case_id, month, is_demo) values (${caseId}, ${next}, ${isDemo}) returning id
  `;
  const [ahead] = await sql()`
    select count(*)::int as n from access_requests where granted_at is null and id < ${made.id}
  `;
  if (order) {
    await record(order, 'access.requested', `For ${monthName(next)}.`);
    await record(order, 'access.listed', `${Number(ahead.n) + 1} on the ${monthName(next)} list.`);
  }
  return { granted: false, id: Number(made.id), position: Number(ahead.n) + 1, month: next };
}

export async function heldFor(caseId) {
  const rows = await sql()`
    select h.id, h.rate, h.bought_at, h.used_at, h.activity_id, h.is_demo, a.title_encrypted,
           o.reference_code
      from held_sessions h
      left join activities a on a.id = h.activity_id
      left join orders o on o.id = h.order_id
     where h.case_id = ${caseId}
     order by h.bought_at asc, h.id asc
  `;
  return rows.map((h) => ({
    id: Number(h.id),
    rate: h.rate,
    rateLabel: RATE_LABELS[h.rate] || h.rate,
    boughtAt: h.bought_at,
    usedAt: h.used_at,
    activityId: h.activity_id === null || h.activity_id === undefined ? null : Number(h.activity_id),
    usedFor: h.title_encrypted ? decrypt(h.title_encrypted) : null,
    reference: h.reference_code || null,
  }));
}

export async function sessionBought(orderId) {
  const [order] = await sql()`
    select id, case_id, kind, rate, is_demo from orders where id = ${orderId} and status = 'confirmed'
  `;
  if (!order || order.kind !== 'session' || !order.case_id) return false;
  const made = await sql()`
    insert into held_sessions (case_id, order_id, rate, is_demo)
    values (${order.case_id}, ${order.id}, ${order.rate || 'standard'}, ${order.is_demo})
    on conflict do nothing
    returning id
  `;
  if (made.length) await record(Number(order.id), 'session.bought', RATE_LABELS[order.rate] || order.rate || 'Standard rate');
  return made.length > 0;
}

export async function pendingSessionOrders(caseId) {
  const rows = await sql()`
    select id, reference_code, rate, card_amount_cents, payment_method, created_at from orders
     where case_id = ${caseId} and kind = 'session' and status = 'pending'
     order by created_at asc
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    reference: r.reference_code,
    rate: r.rate,
    rateLabel: RATE_LABELS[r.rate] || r.rate,
    amount: r.card_amount_cents / 100,
    method: r.payment_method,
    paidAt: r.created_at,
  }));
}
