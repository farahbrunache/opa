import crypto from 'node:crypto';
import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, query, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { REFERENCE_ALPHABET } from './orders.js';

export const SALES_PAGE = 'https://farahbrunache.com/';
const CODE_LENGTH = 6;
export const CHAINS_PER_PAGE = 10;
export const UNDER_SHOWN = 10;
export const BROUGHT_PER_PAGE = 10;
const WHY_MAX = 500;

export function referralCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === CODE_LENGTH && [...code].every((c) => REFERENCE_ALPHABET.includes(c)) ? code : null;
}

async function people() {
  const rows = await sql()`
    with paid as (
      select o.*, coalesce('case:' || o.case_id, 'order:' || o.id) as who
        from orders o where o.status = 'confirmed'
    )
    select p.who,
           min(p.case_id) as case_id,
           (array_agg(p.id order by p.id desc))[1] as order_id,
           array_agg(p.id) as order_ids,
           (array_agg(p.reference_code order by p.id desc))[1] as reference,
           min(p.decided_at) as paid_at,
           bool_or(p.is_demo) as is_demo,
           (array_agg(p.from_code order by p.created_at asc) filter (where p.from_code is not null))[1] as from_code,
           (array_agg(p.brought_by order by p.id desc) filter (where p.brought_by is not null))[1] as brought_by,
           (array_agg(p.brought_by_order_id order by p.id desc) filter (where p.brought_by is not null))[1] as by_order,
           max(p.flagged_at) as flagged_at,
           (array_agg(p.decision order by p.decision_at desc) filter (where p.decision is not null))[1] as decision,
           bool_or(exists (select 1 from calls c where c.order_id = p.id and c.transcript_encrypted is not null)) as called,
           max(k.name_encrypted) as name_encrypted,
           max(k.referral_code) as referral_code,
           max(k.closed_at) as closed_at,
           bool_or(k.account_id is not null and (
             select m.author from messages m where m.account_id = k.account_id
              order by m.created_at desc limit 1) = 'client') as wrote
      from paid p left join cases k on k.id = p.case_id
     group by p.who
  `;
  const byWho = new Map();
  const byOrder = new Map();
  const byCode = new Map();
  for (const r of rows) {
    const node = {
      who: r.who,
      caseId: r.case_id === null ? null : Number(r.case_id),
      orderId: Number(r.order_id),
      orderIds: r.order_ids.map(Number),
      reference: r.reference,
      name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
      paidAt: r.paid_at,
      isDemo: Boolean(r.is_demo),
      fromCode: r.from_code,
      broughtBy: r.brought_by,
      byOrder: r.by_order === null ? null : Number(r.by_order),
      flaggedAt: r.flagged_at,
      decision: r.decision,
      called: Boolean(r.called),
      status: r.flagged_at ? 'Flagged' : r.closed_at ? 'Closed' : r.wrote ? 'Wrote'
        : r.decision === 'go' ? 'Go' : r.decision === 'no-go' ? 'No-go' : r.called ? 'New call' : 'Paid',
      children: [],
    };
    byWho.set(node.who, node);
    for (const id of node.orderIds) byOrder.set(id, node);
    if (r.referral_code) byCode.set(r.referral_code, node);
  }
  for (const node of byWho.values()) {
    node.how = node.broughtBy === 'person' ? 'set' : node.broughtBy || (node.fromCode && byCode.has(node.fromCode) ? 'link' : 'outreach');
    node.parent = node.broughtBy === 'person' ? byOrder.get(node.byOrder) || null
      : node.broughtBy ? null : byCode.get(node.fromCode) || null;
    if (node.parent === node) node.parent = null;
    if (node.parent) node.parent.children.push(node);
  }
  for (const node of byWho.values()) {
    const seen = new Set([node]);
    let up = node.parent;
    node.flaggedAbove = null;
    while (up && !seen.has(up)) {
      if (up.flaggedAt) {
        node.flaggedAbove = up;
        break;
      }
      seen.add(up);
      up = up.parent;
    }
  }
  return { byWho, byOrder };
}

const label = (node) => node.name || node.reference;
const first = (node) => (node.name ? node.name.split(/\s+/)[0] : node.reference);

export async function referralLines() {
  const { byOrder } = await people();
  const out = {};
  for (const [id, node] of byOrder) {
    if (!node.parent && !node.flaggedAbove) continue;
    out[id] = {
      via: node.parent ? first(node.parent) : null,
      viaFlagged: Boolean(node.parent?.flaggedAt),
      check: node.flaggedAbove ? label(node.flaggedAbove) : null,
    };
  }
  return out;
}

export async function broughtByFor(id, askedPage = 1) {
  const { byOrder } = await people();
  const node = byOrder.get(Number(id));
  if (!node) return null;
  const [flag] = await sql()`
    select flag_why_encrypted from orders where id = any(${node.orderIds}) and flagged_at is not null
     order by flagged_at desc limit 1
  `;
  const row = (n) => ({ id: n.orderId, name: n.name, reference: n.reference, paidAt: n.paidAt, decision: n.decision, status: n.status });
  const everyone = node.children.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
  const last = Math.max(1, Math.ceil(everyone.length / BROUGHT_PER_PAGE));
  const wanted = Number.parseInt(askedPage, 10);
  const page = Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), last) : 1;
  return {
    how: node.how,
    by: node.parent ? row(node.parent) : null,
    brought: everyone.slice((page - 1) * BROUGHT_PER_PAGE, page * BROUGHT_PER_PAGE).map(row),
    broughtTotal: everyone.length,
    broughtPage: page,
    broughtLast: last,
    flaggedAt: node.flaggedAt,
    why: flag?.flag_why_encrypted ? decrypt(flag.flag_why_encrypted) : null,
    check: node.flaggedAbove ? { id: node.flaggedAbove.orderId, name: label(node.flaggedAbove) } : null,
    under: countUnder(node),
  };
}

function countUnder(node, seen = new Set()) {
  let n = 0;
  for (const child of node.children) {
    if (seen.has(child)) continue;
    seen.add(child);
    n += 1 + countUnder(child, seen);
  }
  return n;
}

export async function referralTree(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const { byWho } = await people();
  const all = [...byWho.values()];
  const draw = (node, seen) => {
    seen.add(node);
    return {
      id: node.orderId,
      name: node.name,
      reference: node.reference,
      status: node.status,
      flagged: Boolean(node.flaggedAt),
      underFlag: Boolean(node.flaggedAbove),
      unknown: node.how === 'unknown',
      isDemo: node.isDemo,
      brought: node.children.length,
      children: node.children.filter((c) => !seen.has(c))
        .sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt)).slice(0, UNDER_SHOWN).map((c) => draw(c, seen)),
      more: Math.max(0, node.children.length - UNDER_SHOWN),
    };
  };
  const walk = (node, seen = new Set()) => {
    seen.add(node);
    let latest = new Date(node.paidAt || 0).getTime();
    let flagged = Boolean(node.flaggedAt);
    for (const child of node.children) {
      if (seen.has(child)) continue;
      const below = walk(child, seen);
      latest = Math.max(latest, below.latest);
      flagged = flagged || below.flagged;
    }
    return { latest, flagged };
  };
  const chains = all.filter((n) => !n.parent && (n.children.length || n.flaggedAt))
    .map((n) => ({ node: n, ...walk(n) }))
    .sort((a, b) => (b.flagged - a.flagged) || (b.latest - a.latest));
  const last = Math.max(1, Math.ceil(chains.length / CHAINS_PER_PAGE));
  const asked = Number.parseInt(query(req).get('page'), 10);
  const page = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), last) : 1;
  const drawn = new Set();
  send(res, 200, {
    outreach: all.filter((n) => !n.parent && n.how === 'outreach' && n.called).length,
    brought: all.filter((n) => n.parent).length,
    flagged: all.filter((n) => n.flaggedAt).length,
    chains: chains.length,
    page,
    last,
    tree: chains.slice((page - 1) * CHAINS_PER_PAGE, page * CHAINS_PER_PAGE).map((c) => draw(c.node, drawn)),
  });
}

export async function bringFor(caseId) {
  if (caseId === null || caseId === undefined) return null;
  const [standing] = await sql()`
    select decision from orders where case_id = ${caseId} and decision is not null
     order by decision_at desc limit 1
  `;
  if (standing?.decision !== 'go') return null;
  let [row] = await sql()`select referral_code from cases where id = ${caseId}`;
  for (let attempt = 0; attempt < 8 && !row?.referral_code; attempt += 1) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) code += REFERENCE_ALPHABET[crypto.randomInt(0, REFERENCE_ALPHABET.length)];
    try {
      [row] = await sql()`
        update cases set referral_code = coalesce(referral_code, ${code}) where id = ${caseId}
        returning referral_code
      `;
    } catch {
      row = null;
    }
  }
  if (!row?.referral_code) return null;
  const { byWho } = await people();
  const node = byWho.get(`case:${caseId}`);
  return { link: `${SALES_PAGE}?from=${row.referral_code}`, brought: node ? node.children.length : 0 };
}

export async function setBroughtBy(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const how = String(body.how || '');
  if (!['person', 'outreach', 'unknown'].includes(how)) {
    throw new HttpError(400, 'Pick one: a person, your outreach, or not known.');
  }
  const { byOrder } = await people();
  const node = byOrder.get(id);
  if (!node) throw new HttpError(409, "This order isn't paid, so nobody brought anybody yet.");

  let by = null;
  if (how === 'person') {
    const reference = String(body.reference || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const [match] = await sql()`
      select id from orders where status = 'confirmed'
         and replace(reference_code, '-', '') = ${reference}
    `;
    const parent = match ? byOrder.get(Number(match.id)) : null;
    if (!parent) throw new HttpError(404, 'No paid order has that code. Type the 10-character code of whoever brought them.');
    if (parent === node) throw new HttpError(400, "Somebody can't bring themselves.");
    for (let up = parent, seen = new Set(); up && !seen.has(up); seen.add(up), up = up.parent) {
      if (up === node) throw new HttpError(400, `${label(parent)} is somebody this person brought, so they can't have brought them.`);
    }
    by = parent;
  }
  await sql()`update orders set brought_by = null, brought_by_order_id = null where id = any(${node.orderIds})`;
  await sql()`
    update orders set brought_by = ${how}, brought_by_order_id = ${by ? by.orderId : null} where id = ${id}
  `;
  await record(id, 'brought-by.changed', how === 'person' ? `Brought by ${label(by)}.`
    : how === 'outreach' ? 'Brought by your outreach.' : "Who brought them isn't known.");
  send(res, 200, { ok: true });
}

export async function flag(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const why = String(body.why || '').trim().slice(0, WHY_MAX);
  const done = await sql()`
    update orders set flagged_at = now(), flag_why_encrypted = ${why ? encrypt(why) : null}
     where id = ${id} and status = 'confirmed'
    returning id
  `;
  if (!done.length) throw new HttpError(409, "This order isn't paid, so there's nobody to flag yet.");
  const { byOrder } = await people();
  const under = countUnder(byOrder.get(id));
  await record(id, 'flagged', `Flagged. ${under} ${under === 1 ? 'person' : 'people'} down their chain marked to check.`);
  send(res, 200, { ok: true, under });
}

export async function unflag(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const { byOrder } = await people();
  const node = byOrder.get(id);
  if (!node?.flaggedAt) throw new HttpError(409, "This person isn't flagged.");
  await sql()`update orders set flagged_at = null, flag_why_encrypted = null where id = any(${node.orderIds})`;
  await record(id, 'unflagged', 'Flag removed.');
  send(res, 200, { ok: true });
}
