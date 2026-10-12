import { ensureSchema, findByClaimTokenHash, sql } from '../lib/db.js';
import { underLimit } from '../lib/settings.js';
import { aCallCameBack, reconcileStarts, secondsSpent } from '../lib/calls.js';
import { callerKey, decrypt, keyedHash } from '../lib/crypto.js';
import {
  ASSUME_FULL_AFTER_SECONDS,
  MAX_SESSION_STARTS,
  PAYMENT_METHODS,
  REJECT_REASONS,
  SESSION_BUDGET_SECONDS,
  UNREPORTED_AFTER_SECONDS,
  describeStatus,
} from '../lib/orders.js';
import { HttpError, handle, send } from '../lib/http.js';
import { wiseHandle } from '../lib/sessions.js';

export default handle('GET', async (req, res) => {
  const token = new URL(req.url, 'https://placeholder.invalid').searchParams.get('t');
  if (!token) throw new HttpError(400, 'This link is missing its claim token.');

  await ensureSchema();

  if (!(await underLimit('status', callerKey(req), 120, 3600))) {
    throw new HttpError(429, 'Too many lookups from here in the last hour. Try later.');
  }

  let order = await findByClaimTokenHash(keyedHash(token));
  if (!order) {
    throw new HttpError(
      404,
      'No order matches this link. Check you have the entire address, or recover it with your ' +
        'card code.',
    );
  }

  await reconcileStarts(order.id, UNREPORTED_AFTER_SECONDS);
  order = await findByClaimTokenHash(keyedHash(token));

  let status = describeStatus(order);
  let used = 0;
  if (status === 'confirmed') {
    used = await secondsSpent(
      order.id,
      ASSUME_FULL_AFTER_SECONDS,
      SESSION_BUDGET_SECONDS,
      UNREPORTED_AFTER_SECONDS,
    );
    if (used >= SESSION_BUDGET_SECONDS || (await aCallCameBack(order.id))) status = 'used';
  }

  const spec = PAYMENT_METHODS[order.payment_method] || null;

  const payload = {
    status,
    label: spec ? spec.label : 'Payment',
    method: spec ? order.payment_method : null,
    amount: order.card_amount_cents / 100,
    reference: order.reference_code,
    submitted: order.created_at,
    decided: order.decided_at,
    recommended: Boolean(order.recommendations_written_at),
  };

  if (status === 'used' && !order.client_account_id) {
    const [sheet] = await sql()`
      select recommendations_encrypted from orders where id = ${order.id}
    `;
    payload.steps = sheet?.recommendations_encrypted ? decrypt(sheet.recommendations_encrypted) : null;
    payload.stepsAt = order.recommendations_written_at;
    payload.messages = (await sql()`
      select author, body_encrypted, created_at from messages
       where account_id is null and order_id = ${order.id}
       order by created_at asc limit 200
    `).map((m) => ({ author: m.author, body: decrypt(m.body_encrypted), at: m.created_at }));
  }

  if (status === 'pending' && spec && !spec.needsCode) {
    payload.payTo = await wiseHandle();
  }

  if (status === 'confirmed') {
    payload.startsLeft = Math.max(0, MAX_SESSION_STARTS - Number(order.session_starts || 0));
    payload.minutesLeft = Math.max(0, Math.min(
      ASSUME_FULL_AFTER_SECONDS / 60,
      Math.floor((SESSION_BUDGET_SECONDS - used) / 60),
    ));
  }

  if (status === 'used') {
    const [held] = await sql()`
      select min(started_at) as at, coalesce(sum(seconds), 0)::int as seconds
        from calls where order_id = ${order.id} and transcript_encrypted is not null
    `;
    payload.calledAt = held?.at || order.first_started_at || null;
    payload.callSeconds = Number(held?.seconds || 0);
  }

  if (status === 'rejected') {
    payload.reason = REJECT_REASONS[order.reject_reason] || "This payment didn't check out.";
  }

  send(res, 200, payload);
});
