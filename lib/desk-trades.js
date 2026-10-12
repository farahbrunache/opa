import { ensureSchema, sql } from './db.js';
import { decrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { pairsToIntroduce, refreshTrades } from './trades.js';

export async function setTrade(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const trade = body.trade ? String(body.trade) : null;
  let title = null;
  if (trade) {
    const found = await sql()`select title from trades where id = ${trade}`;
    if (!found.length) throw new HttpError(404, "That job title isn't in the copied Skills Taxonomy. Copy it again and pick it there.");
    title = found[0].title;
  }
  const done = await sql()`update orders set trade_id = ${trade} where id = ${id} returning id`;
  if (!done.length) throw new HttpError(404, 'No order with that number.');
  await record(id, 'trade', title ? `Job title: ${title}.` : 'Job title cleared.');
  send(res, 200, { trade, title });
}

export async function copyTrades(req, res) {
  requireAdmin(req);
  send(res, 200, await refreshTrades());
}

const named = (sealed, reference) => (sealed ? decrypt(sealed) : reference);

export async function pairs(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const rows = await pairsToIntroduce();
  send(res, 200, {
    pairs: rows.map((r) => ({
      sector: r.sector,
      isDemo: Boolean(r.is_demo),
      a: { id: Number(r.a_id), reference: r.a_ref, name: named(r.a_name, r.a_ref), title: r.a_title },
      b: { id: Number(r.b_id), reference: r.b_ref, name: named(r.b_name, r.b_ref), title: r.b_title },
    })),
  });
}
