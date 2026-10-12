import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { HttpError, query, send } from './http.js';
import { orderId } from './desk-events.js';
import { quotesView, sessionsView, threadView } from './client-view.js';

const PARTS = {
  mine: (account, order) => sessionsView(account, account ? null : order),
  thread: (account, order, asked) => threadView(account, asked, account ? null : order),
  quotes: (account) => quotesView(account),
};

export async function clientPreview(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const params = query(req);
  const id = orderId(params.get('id'));
  const read = PARTS[params.get('part') || 'mine'];
  if (!read) throw new HttpError(400, 'The preview reads part=mine, part=thread or part=quotes.');
  const [order] = await sql()`select id, client_account_id from orders where id = ${id}`;
  if (!order) throw new HttpError(404, 'No order with that number.');
  send(res, 200, await read(order.client_account_id || null, Number(order.id), params.get('page')));
}
