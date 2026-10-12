import Retell from 'retell-sdk';

import { ensureSchema, findByClaimTokenHash, sql } from '../lib/db.js';
import { underLimit } from '../lib/settings.js';
import { aCallCameBack, abandonCall, reconcileStarts, secondsSpent } from '../lib/calls.js';
import { callerKey, keyedHash } from '../lib/crypto.js';
import {
  ABANDON_WITHIN_SECONDS,
  ASSUME_FULL_AFTER_SECONDS,
  MAX_SESSION_STARTS,
  SESSION_BUDGET_SECONDS,
  UNREPORTED_AFTER_SECONDS,
  SESSION_WINDOW_HOURS,
  describeStatus,
} from '../lib/orders.js';
import { HttpError, handle, readJson, send } from '../lib/http.js';


export default handle('POST', async (req, res) => {
  const body = await readJson(req);
  const token = String(body.t || '').trim();
  if (!token) throw new HttpError(400, 'This link is missing its claim token.');

  const apiKey = process.env.RETELL_SECRET_KEY;
  const agentId = process.env.RETELL_AGENT_ID;
  if (!apiKey || !agentId) {
    throw new HttpError(
      503,
      'Sessions cannot start yet — RETELL_SECRET_KEY or RETELL_AGENT_ID is missing from the ' +
        'project settings.',
    );
  }

  await ensureSchema();

  if (!(await underLimit('call', callerKey(req), 20, 3600))) {
    throw new HttpError(429, 'Too many attempts to start a session from here. Try later.');
  }

  let order = await findByClaimTokenHash(keyedHash(token));
  if (!order) throw new HttpError(404, 'No order matches this link.');

  const action = new URL(req.url, 'https://placeholder.invalid').searchParams.get('action');
  if (action === 'abandon') {
    const closed = await abandonCall(order.id, String(body.callId || ''), ABANDON_WITHIN_SECONDS);
    await sql()`update orders set session_starts = greatest(session_starts - 1, 0) where id = ${order.id}`;
    return send(res, 200, { closed });
  }

  await reconcileStarts(order.id, UNREPORTED_AFTER_SECONDS);
  order = await findByClaimTokenHash(keyedHash(token));

  const status = describeStatus(order);
  if (status === 'pending') {
    throw new HttpError(409, 'This order is still waiting on your payment.');
  }
  if (status === 'rejected') {
    throw new HttpError(409, 'This order did not check out, so no session is open on it.');
  }
  if (status !== 'confirmed') {
    throw new HttpError(409, 'This session has been used. Book another to call again.');
  }

  const used = await secondsSpent(
    order.id,
    ASSUME_FULL_AFTER_SECONDS,
    SESSION_BUDGET_SECONDS,
    UNREPORTED_AFTER_SECONDS,
  );
  if (used >= SESSION_BUDGET_SECONDS) {
    throw new HttpError(409, `This order has used its ${Math.round(SESSION_BUDGET_SECONDS / 60)} minutes. If a call dropped early, write to say so.`);
  }

  if (await aCallCameBack(order.id)) {
    throw new HttpError(409, 'This call already happened. What comes next arrives on this page.');
  }

  const taken = await sql()`
    update orders set
      session_starts = session_starts + 1,
      first_started_at = coalesce(first_started_at, now())
    where id = ${order.id}
      and status = 'confirmed'
      and session_starts < ${MAX_SESSION_STARTS}
      and (
        first_started_at is null
        or first_started_at > now() - ${SESSION_WINDOW_HOURS} * interval '1 hour'
      )
    returning session_starts
  `;
  if (!taken.length) {
    throw new HttpError(409, 'This session has been used. Book another to call again.');
  }

  const release = async () => {
    await sql()`update orders set session_starts = session_starts - 1 where id = ${order.id}`;
  };

  let data;
  try {
    data = await new Retell({ apiKey }).call.createWebCall({
      agent_id: agentId,
      metadata: { reference: order.reference_code, order_id: String(order.id) },
    });
  } catch (error) {
    await release();
    if (error instanceof Retell.APIError) {
      const said = JSON.stringify(error.error ?? error.message).slice(0, 400);
      throw new HttpError(502, `The voice service refused to start a session (${error.status}): ${said}`);
    }
    throw new HttpError(502, `Could not reach the voice service: ${error.message}`);
  }

  const text = JSON.stringify(data);

  const accessToken = data.access_token || data.accessToken;
  if (!accessToken) {
    await release();
    throw new HttpError(
      502,
      `The voice service started a session but returned no access token. It sent: ${text.slice(0, 300)}`,
    );
  }

  const callId = data.call_id || data.callId || null;
  if (callId) {
    const seen = await sql()`
      select exists (
        select 1 from calls c
          join orders o on o.id = c.order_id
         where o.client_account_id is not null
           and o.client_account_id = (select client_account_id from orders where id = ${order.id})
           and c.transcript_encrypted is not null
      ) as before
    `;
    const kind = seen[0]?.before ? 'follow-up' : 'intake';
    await sql()`
      insert into calls (order_id, kind, call_id) values (${order.id}, ${kind}, ${callId})
      on conflict (call_id) do nothing
    `;
  }

  send(res, 200, {
    accessToken,
    callId,
    transport: data.transport || null,
    iceServers: data.ice_servers || null,
    expiresAt: data.expires_at || null,
    remaining: Math.max(0, MAX_SESSION_STARTS - Number(taken[0].session_starts || 0)),
  });
});
