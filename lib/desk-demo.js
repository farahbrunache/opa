import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { clearDemo, seedDemo } from './demo.js';
import { orderId, record } from './desk-events.js';

export async function markMine(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);

  const rows = await sql()`select is_demo, is_mine from orders where id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  if (rows[0].is_mine) throw new HttpError(409, "That one's already marked as yours.");
  if (rows[0].is_demo) {
    throw new HttpError(409, "That's a demo record. It already counts no revenue.");
  }

  await sql()`update orders set is_mine = true where id = ${id}`;
  await sql()`update spend set was_demo = true where order_id = ${id}`;
  await record(id, 'mine', "No revenue counted, and its costs are the project's.");
  send(res, 200, { ok: true });
}

export async function demoSeed(req, res) {
  requireAdmin(req);
  await ensureSchema();
  send(res, 201, { made: await seedDemo() });
}

export async function demoClear(req, res) {
  requireAdmin(req);
  await ensureSchema();
  send(res, 200, await clearDemo());
}
