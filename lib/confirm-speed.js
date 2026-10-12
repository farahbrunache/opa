import { readChoice } from './settings.js';
import { sql } from './db.js';
import { decrypt } from './crypto.js';
import { PAYMENT_METHODS } from './orders.js';
import { RATE_LABELS } from './desk.js';

export const CONFIRM_TARGET_DEFAULT_HOURS = 12;

export const WAITING_SHOWN = 100;

export const SPEED_ROWS = 30;
export const SPEED_WEEKS = 8;

const WEEK_MS = 7 * 86_400_000;

export async function confirmTargetHours() {
  const n = Number(String((await readChoice('confirm:target-hours')) || '').trim());
  return Number.isFinite(n) && n > 0 ? n : CONFIRM_TARGET_DEFAULT_HOURS;
}

function secondsBetween(from, to) {
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function speedFigures(rows, targetHours) {
  const limit = targetHours * 3600;
  const took = rows
    .filter((r) => r.decidedAt && !r.isDemo && !r.isMine)
    .map((r) => secondsBetween(r.createdAt, r.decidedAt));
  return {
    decided: took.length,
    median: median(took),
    within: took.filter((s) => s <= limit).length,
    slowest: took.length ? Math.max(...took) : null,
  };
}

export function speedWeeks(rows, targetHours, now = Date.now(), weeks = SPEED_WEEKS) {
  const limit = targetHours * 3600;
  const buckets = Array.from({ length: weeks }, () => []);
  for (const r of rows) {
    if (!r.decidedAt || r.isDemo || r.isMine) continue;
    const ago = Math.floor((now - new Date(r.decidedAt).getTime()) / WEEK_MS);
    if (ago >= 0 && ago < weeks) buckets[ago].push(secondsBetween(r.createdAt, r.decidedAt));
  }
  return buckets
    .map((took, ago) => ({
      ago,
      decided: took.length,
      median: median(took),
      past: took.filter((s) => s > limit).length,
    }))
    .filter((w) => w.decided > 0);
}

export function speedRow(r, now = Date.now()) {
  return {
    reference: r.reference,
    status: r.status,
    seconds: r.decidedAt ? secondsBetween(r.createdAt, r.decidedAt) : secondsBetween(r.createdAt, now),
    waiting: !r.decidedAt,
    isDemo: Boolean(r.isDemo),
  };
}

const shape = (r) => ({
  reference: r.reference_code,
  status: r.status,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  isDemo: Boolean(r.is_demo),
  isMine: Boolean(r.is_mine),
});

export async function confirmSpeed(now = Date.now()) {
  const targetHours = await confirmTargetHours();
  const decided = (await sql()`
    select reference_code, status, created_at, decided_at, is_demo, is_mine
      from orders
     where decided_at is not null and not is_demo and not is_mine
     order by decided_at desc
  `).map(shape);
  let recent = (await sql()`
    select reference_code, status, created_at, decided_at, is_demo, is_mine
      from orders
     where (status = 'pending' or decided_at is not null) and not is_demo and not is_mine
     order by created_at desc
     limit ${SPEED_ROWS}
  `).map(shape);
  if (!recent.length) {
    recent = (await sql()`
      select reference_code, status, created_at, decided_at, is_demo, is_mine
        from orders
       where (status = 'pending' or decided_at is not null) and is_demo
       order by created_at desc
       limit ${SPEED_ROWS}
    `).map(shape);
  }
  return {
    targetHours,
    ...speedFigures(decided, targetHours),
    weeks: speedWeeks(decided, targetHours, now),
    rows: recent.map((r) => speedRow(r, now)),
  };
}

export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

export async function waitingPayments(now = Date.now()) {
  const rows = await sql()`
    select count(*) over () as total, o.id, o.payment_method, o.card_amount_cents, o.kind, o.rate,
           o.card_code_encrypted, o.reference_code, o.created_at, o.is_demo,
           o.case_id, k.name_encrypted,
           case when o.case_id is null then null
                else (select count(*)::int from orders p
                       where p.case_id = o.case_id and p.status <> 'rejected' and p.kind = 'call'
                         and (p.created_at, p.id) <= (o.created_at, o.id))
           end as session_number
      from orders o
      left join cases k on k.id = o.case_id
     where o.status = 'pending'
     order by o.created_at asc
     limit ${WAITING_SHOWN}
  `;
  return {
    total: Number(rows[0]?.total || 0),
    rows: rows.map((r) => ({
      id: Number(r.id),
      method: r.payment_method,
      kind: r.kind,
      rate: r.rate,
      rateLabel: r.kind === 'session' ? RATE_LABELS[r.rate] || r.rate : null,
      label: PAYMENT_METHODS[r.payment_method]?.label || 'Payment',
      amount: r.card_amount_cents / 100,
      reference: r.reference_code,
      code: r.card_code_encrypted ? decrypt(r.card_code_encrypted) : null,
      paidAt: r.created_at,
      hoursWaiting: (now - new Date(r.created_at).getTime()) / 3_600_000,
      isDemo: Boolean(r.is_demo),
      linked: r.case_id !== null && r.case_id !== undefined,
      name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
      session: r.session_number === null || r.session_number === undefined
        ? null : Number(r.session_number),
      repeat: r.kind === 'session' ? `Session · ${RATE_LABELS[r.rate] || r.rate}`
        : Number(r.session_number) > 1 ? `${ordinal(Number(r.session_number))} session` : null,
    })),
  };
}
