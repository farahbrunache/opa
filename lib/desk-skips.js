import { ensureSchema, sql } from './db.js';
import { keyedHash } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { caseOf, orderId, record, referenceOf } from './desk-events.js';
import { profileIdFrom } from './desk-directory.js';

export function profileSide(profileId) {
  return `p:${keyedHash(`directory:${profileId}`)}`;
}

export async function pairKey(id, other) {
  if (other.profile) {
    const profile = profileIdFrom(other.profile);
    if (!profile) throw new HttpError(400, 'Which Directory profile?');
    return { key: `o:${id}|${profileSide(profile)}`, otherOrder: null };
  }
  const otherOrder = orderId(other.order);
  if (otherOrder === id) throw new HttpError(400, 'That is the same person.');
  const [mine, theirs] = [await caseOf(id), await caseOf(otherOrder)];
  if (mine && theirs && mine === theirs) throw new HttpError(400, 'Those two sessions are the same person.');
  const [low, high] = id < otherOrder ? [id, otherOrder] : [otherOrder, id];
  return { key: `o:${low}|o:${high}`, otherOrder };
}

export async function skippedOf(keys) {
  if (!keys.length) return new Set();
  const rows = await sql()`select pair_key from pair_skips where pair_key = any(${keys}::text[])`;
  return new Set(rows.map((r) => r.pair_key));
}

async function said(id, otherOrder, what) {
  if (otherOrder) {
    await record(id, what, `With ${await referenceOf(otherOrder)}.`);
    await record(otherOrder, what, `With ${await referenceOf(id)}.`);
  } else {
    await record(id, what, 'With a Directory profile.');
  }
}

export async function skipPair(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const { key, otherOrder } = await pairKey(id, body);
  const rows = await sql()`
    insert into pair_skips (pair_key, order_id, is_demo)
    select ${key}, o.id,
           o.is_demo or coalesce((select o2.is_demo from orders o2 where o2.id = ${otherOrder}), false)
      from orders o
     where o.id = ${id}
    on conflict (pair_key) do nothing
    returning pair_key
  `;
  if (rows.length) await said(id, otherOrder, 'pair.skipped');
  send(res, 200, { ok: true, skipped: rows.length > 0 });
}

export async function unskipPair(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const { key, otherOrder } = await pairKey(id, body);
  const rows = await sql()`delete from pair_skips where pair_key = ${key} returning pair_key`;
  if (rows.length) await said(id, otherOrder, 'pair.unskipped');
  send(res, 200, { ok: true });
}
