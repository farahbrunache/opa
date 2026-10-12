import { ensureSchema, sql } from '../lib/db.js';
import { confirmSpeed } from '../lib/confirm-speed.js';
import { requireAdmin } from '../lib/auth.js';
import { PAYMENT_METHODS, REJECT_REASONS, normalizeReference } from '../lib/orders.js';
import { HttpError, handle, readJson, send } from '../lib/http.js';

async function list(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const counts = await sql()`
    select status, count(*)::int as n from orders group by status
  `;
  send(res, 200, {
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    speed: await confirmSpeed(),
  });
}

const PER_PAGE = 25;

async function history(req, res) {
  await requireAdmin(req);
  await ensureSchema();
  const params = new URL(req.url, 'https://placeholder.invalid').searchParams;
  const reference = normalizeReference(params.get('q'));
  const page = Math.max(1, Number(params.get('page')) || 1);
  const offset = (page - 1) * PER_PAGE;

  const [rows, totals] = reference
    ? await Promise.all([
        sql()`
          select id, reference_code, payment_method, card_amount_cents, status, reject_reason,
                 created_at, decided_at, session_starts, first_started_at, is_demo, is_mine,
                 exists (select 1 from calls c
                          where c.order_id = orders.id
                            and c.transcript_encrypted is not null) as has_transcript,
                 (select c.seconds from calls c
                   where c.order_id = orders.id and c.transcript_encrypted is not null
                   order by c.ended_at desc nulls last limit 1) as call_seconds
            from orders where reference_code = ${reference}
           order by created_at desc limit ${PER_PAGE} offset ${offset}
        `,
        sql()`select count(*)::int as n from orders where reference_code = ${reference}`,
      ])
    : await Promise.all([
        sql()`
          select id, reference_code, payment_method, card_amount_cents, status, reject_reason,
                 created_at, decided_at, session_starts, first_started_at, is_demo, is_mine,
                 exists (select 1 from calls c
                          where c.order_id = orders.id
                            and c.transcript_encrypted is not null) as has_transcript,
                 (select c.seconds from calls c
                   where c.order_id = orders.id and c.transcript_encrypted is not null
                   order by c.ended_at desc nulls last limit 1) as call_seconds
            from orders
           order by created_at desc limit ${PER_PAGE} offset ${offset}
        `,
        sql()`select count(*)::int as n from orders`,
      ]);
  send(res, 200, {
    page,
    perPage: PER_PAGE,
    total: totals[0]?.n || 0,
    searched: reference || null,
    orders: rows.map((r) => ({
      id: r.id,
      reference: r.reference_code,
      method: r.payment_method,
      label: PAYMENT_METHODS[r.payment_method]?.label || 'Payment',
      amount: r.card_amount_cents / 100,
      status: r.status,
      rejectReason: r.reject_reason ? REJECT_REASONS[r.reject_reason] || r.reject_reason : null,
      submitted: r.created_at,
      decided: r.decided_at,
      sessionStarts: r.session_starts,
      firstStarted: r.first_started_at,
      hasTranscript: r.has_transcript,
      callSeconds: r.call_seconds,
      isDemo: Boolean(r.is_demo),
      isMine: Boolean(r.is_mine),
    })),
  });
}

function timesOf(row) {
  return { paidAt: row.created_at, decidedAt: row.decided_at };
}

async function decide(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which order?');

  if (body.decision === 'reject') {
    const reason = String(body.reason || 'invalid');
    if (!REJECT_REASONS[reason]) {
      throw new HttpError(400, `Pick a reason: ${Object.keys(REJECT_REASONS).join(', ')}.`);
    }
    const done = await sql()`
      update orders set
        status = 'rejected',
        reject_reason = ${reason},
        card_code_encrypted = null,
        decided_at = now()
      where id = ${id} and status = 'pending'
      returning created_at, decided_at
    `;
    if (!done.length) throw new HttpError(409, 'That order was already decided.');
    return send(res, 200, { ok: true, status: 'rejected', ...timesOf(done[0]) });
  }

  if (body.decision !== 'confirm') {
    throw new HttpError(400, 'The decision is either confirm or reject.');
  }

  const done = await sql()`
    update orders set
      status = 'confirmed',
      card_code_encrypted = null,
      decided_at = now()
    where id = ${id} and status = 'pending'
    returning created_at, decided_at
  `;
  if (!done.length) throw new HttpError(409, 'That order was already decided.');
  send(res, 200, { ok: true, status: 'confirmed', ...timesOf(done[0]) });
}

export default handle(['GET', 'POST'], async (req, res) => {
  const action = new URL(req.url, 'https://placeholder.invalid').searchParams.get('action');

  if (req.method === 'GET' && action === 'list') return list(req, res);
  if (req.method === 'GET' && action === 'history') return history(req, res);
  if (req.method === 'POST' && action === 'decide') return decide(req, res);

  throw new HttpError(400, 'Use action=list, action=history or action=decide.');
});
