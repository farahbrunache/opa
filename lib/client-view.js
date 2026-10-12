import { sql } from './db.js';
import { decrypt } from './crypto.js';
import { conversationIsOpen, pageOf } from './desk.js';
import { HttpError } from './http.js';
import { pageExtras } from './client-page.js';
import { directionsFor } from './chapter-steps.js';
import { accessNow, heldFor, pendingSessionOrders, ratesNow, requestsFor } from './sessions.js';

function shape(rows) {
  return rows.map((r) => ({
    reference: r.reference_code,
    approved: Boolean(r.approved_as_client_at),
    approvedAt: r.approved_as_client_at,
    paidAt: r.created_at,
    calledAt: r.called_at || r.first_started_at,
    callSeconds: Number(r.call_seconds || 0),
    callKind: r.call_kind || null,
    sessionStarts: r.session_starts,
    hasCall: Boolean(r.has_call),
    hasTranscript: Boolean(r.has_transcript),
    recommendations: r.recommendations_encrypted ? decrypt(r.recommendations_encrypted) : null,
    recommendedAt: r.recommendations_written_at,
  }));
}

export async function sessionsView(account, unlinkedOrder = null) {
  const rows = await sql()`
    select id, reference_code, created_at, approved_as_client_at, first_started_at,
           session_starts, recommendations_encrypted, recommendations_written_at,
           exists (select 1 from calls c
                    where c.order_id = orders.id
                      and c.transcript_encrypted is not null) as has_transcript,
           exists (select 1 from calls c where c.order_id = orders.id) as has_call,
           heard.called_at, heard.call_seconds, heard.call_kind
      from orders
      left join lateral (
        select min(c.started_at) as called_at, sum(c.seconds)::int as call_seconds,
               min(c.kind) as call_kind
          from calls c
         where c.order_id = orders.id
           and (c.transcript_encrypted is not null
                or not exists (select 1 from calls t
                                where t.order_id = orders.id
                                  and t.transcript_encrypted is not null))
      ) heard on true
     where kind = 'call'
       and ((${account}::text is not null and client_account_id = ${account})
            or (${account}::text is null and orders.id = ${unlinkedOrder}::bigint))
     order by created_at desc
     limit 50
  `;
  const sessions = shape(rows);
  return {
    account,
    sessions,
    approved: sessions.some((s) => s.approved),
    ...(await pageExtras(account)),
  };
}

export async function requireClient(account) {
  const approved = await sql()`
    select 1 from orders
     where client_account_id = ${account} and approved_as_client_at is not null
     limit 1
  `;
  if (!conversationIsOpen({ approvedAt: approved.length })) {
    throw new HttpError(403, 'There is no conversation on this account yet.');
  }
}

async function unlinkedThread(order, asked) {
  const [found] = await sql()`
    select approved_as_client_at from orders where id = ${order} and client_account_id is null
  `;
  if (!found?.approved_as_client_at) {
    throw new HttpError(403, 'There is no conversation on this account yet.');
  }
  const [{ count }] = await sql()`
    select count(*)::int as count from messages where account_id is null and order_id = ${order}
  `;
  const { page, perPage } = pageOf(asked, count);
  const rows = await sql()`
    select author, body_encrypted, created_at from messages
     where account_id is null and order_id = ${order}
     order by created_at asc
     limit ${perPage} offset ${(page - 1) * perPage}
  `;
  return {
    page,
    perPage,
    total: count,
    readOnly: true,
    directions: [],
    messages: rows.map((r) => ({ author: r.author, body: decrypt(r.body_encrypted), at: r.created_at })),
  };
}

export async function threadView(account, asked, unlinkedOrder = null) {
  if (!account && unlinkedOrder) return unlinkedThread(unlinkedOrder, asked);
  await requireClient(account);
  const [{ count }] = await sql()`
    select count(*)::int as count from messages where account_id = ${account}
  `;
  const { page, perPage } = pageOf(asked, count);
  const rows = await sql()`
    select author, body_encrypted, created_at from messages
     where account_id = ${account}
     order by created_at asc
     limit ${perPage} offset ${(page - 1) * perPage}
  `;
  return {
    page,
    perPage,
    total: count,
    directions: await directionsFor(account),
    messages: rows.map((r) => ({
      author: r.author,
      body: decrypt(r.body_encrypted),
      at: r.created_at,
    })),
  };
}

export async function cardView(account) {
  const [person] = account
    ? await sql()`select id from cases where account_id = ${account}`
    : [];
  const caseId = person ? Number(person.id) : null;
  const rates = ratesNow();
  const access = await accessNow();
  const held = caseId ? await heldFor(caseId) : [];
  const requests = caseId ? await requestsFor(caseId) : [];
  const latest = requests[0] || null;
  const pending = caseId ? await pendingSessionOrders(caseId) : [];
  const openRequest = latest && (!latest.grantedAt || !latest.orderReference || latest.orderStatus === 'pending')
    ? latest : null;
  return {
    rates: rates ? { standard: rates.standard, access: rates.access } : null,
    access: access ? {
      left: access.left, cap: access.cap, monthName: access.monthName, nextMonthName: access.nextMonthName,
    } : null,
    held: held.map((h) => ({
      rate: h.rate, rateLabel: h.rateLabel, boughtAt: h.boughtAt, usedAt: h.usedAt, usedFor: h.usedFor,
    })),
    request: openRequest ? {
      granted: Boolean(openRequest.grantedAt),
      monthName: openRequest.monthName,
      requestedAt: openRequest.requestedAt,
      toPay: Boolean(openRequest.grantedAt) && (!openRequest.orderReference || openRequest.orderStatus === 'pending'),
    } : null,
    pending: pending.map((p) => ({ reference: p.reference, rate: p.rate, rateLabel: p.rateLabel, amount: p.amount })),
  };
}
