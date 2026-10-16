import { sql } from './db.js';
import { decrypt } from './crypto.js';

export const STRATEGY_MAX = 20000;
export const TAKEAWAYS_MAX = 4000;
export const CHANGED_MAX = 300;
export const STRATEGIES_PER_PAGE = 10;

const open = (value) => (value ? decrypt(value) : null);

export function readTakeaways(text) {
  return String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

function shape(row) {
  return {
    version: Number(row.version),
    body: decrypt(row.body_encrypted),
    takeaways: JSON.parse(decrypt(row.takeaways_encrypted)),
    changed: open(row.changed_encrypted),
    at: row.created_at,
  };
}

async function personOf(id) {
  const [row] = await sql()`select case_id from orders where id = ${id}`;
  return row?.case_id === null || row?.case_id === undefined ? null : Number(row.case_id);
}

export async function liveStrategy(id, { before = null } = {}) {
  const caseId = await personOf(id);
  const upTo = before ? new Date(before).toISOString() : 'infinity';
  const [row] = await sql()`
    select version, body_encrypted, takeaways_encrypted, changed_encrypted, created_at from strategies
     where ((${caseId}::bigint is not null and case_id = ${caseId})
            or (${caseId}::bigint is null and order_id = ${id}))
       and created_at <= ${upTo}::timestamptz
     order by version desc, id desc limit 1
  `;
  return row ? shape(row) : null;
}

export function strategyLines(strategy, cut = STRATEGY_MAX) {
  if (!strategy) return [];
  return [
    `Strategy, version ${strategy.version}:`,
    strategy.body.slice(0, cut),
    '',
    'Key takeaways:',
    ...(strategy.takeaways.length ? strategy.takeaways.map((t) => `- ${t}`) : ['none written']),
  ];
}

export async function strategiesFor(id, asked) {
  const caseId = await personOf(id);
  const [{ n }] = await sql()`
    select count(*)::int as n from strategies
     where (${caseId}::bigint is not null and case_id = ${caseId})
        or (${caseId}::bigint is null and order_id = ${id})
  `;
  const last = Math.max(1, Math.ceil(n / STRATEGIES_PER_PAGE));
  const wanted = Number.parseInt(asked, 10);
  const page = Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), last) : 1;
  const rows = await sql()`
    select version, body_encrypted, takeaways_encrypted, changed_encrypted, created_at from strategies
     where (${caseId}::bigint is not null and case_id = ${caseId})
        or (${caseId}::bigint is null and order_id = ${id})
     order by version desc, id desc
     limit ${STRATEGIES_PER_PAGE} offset ${(page - 1) * STRATEGIES_PER_PAGE}
  `;
  const live = page === 1 && rows.length ? shape(rows[0]) : await liveStrategy(id);
  const versions = rows.map(shape).filter((v) => !live || v.version !== live.version);
  return { live, versions, count: n, page, last };
}
