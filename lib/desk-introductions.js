import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { INTRODUCTION_OUTCOMES, isIntroductionOutcome } from './desk.js';
import { normalizeReference } from './orders.js';
import { caseOf, orderId, record, referenceOf } from './desk-events.js';

export async function introduce(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const reference = normalizeReference(body.reference);
  const link = profileLink(body.link);
  if (reference && link) {
    throw new HttpError(400, 'One or the other: their reference, or a profile link. Not both.');
  }
  if (!reference && !link) throw new HttpError(400, 'Who are they introduced to? A reference, or a profile link.');

  const reason = String(body.reason || '').trim().slice(0, 2000);
  const mine = await caseOf(id);

  if (link) {
    const own = await sql()`
      select to_link_encrypted from introductions
       where to_link_encrypted is not null
         and (a_order_id = ${id} or (${mine}::bigint is not null and a_case_id = ${mine}))
    `;
    if (own.some((r) => decrypt(r.to_link_encrypted) === link)) {
      throw new HttpError(409, "They've already been introduced to that profile.");
    }
    await sql()`
      insert into introductions (a_order_id, a_case_id, to_link_encrypted, reason_encrypted)
      values (${id}, ${mine}, ${encrypt(link)}, ${reason ? encrypt(reason) : null})
    `;
    await record(id, 'introduction.made', `To ${link}. ${reason}`.trim());
    return send(res, 201, { ok: true });
  }

  const them = await sql()`select id from orders where reference_code = ${reference}`;
  if (!them.length) throw new HttpError(404, `No order here carries the reference ${reference}.`);
  const otherId = Number(them[0].id);
  if (otherId === id) throw new HttpError(400, 'That is the same person.');

  const theirs = await caseOf(otherId);
  if (mine && theirs && mine === theirs) {
    throw new HttpError(400, 'That reference belongs to the same person.');
  }

  const already = mine && theirs
    ? await sql()`
        select id from introductions
         where (a_case_id = ${mine} and b_case_id = ${theirs})
            or (a_case_id = ${theirs} and b_case_id = ${mine})
         limit 1
      `
    : await sql()`
        select id from introductions
         where (a_order_id = ${id} and b_order_id = ${otherId})
            or (a_order_id = ${otherId} and b_order_id = ${id})
         limit 1
      `;
  if (already.length) throw new HttpError(409, 'These two have already been introduced.');

  await sql()`
    insert into introductions (a_order_id, b_order_id, a_case_id, b_case_id, reason_encrypted)
    values (${id}, ${otherId}, ${mine}, ${theirs}, ${reason ? encrypt(reason) : null})
  `;
  await record(id, 'introduction.made', `To ${reference}. ${reason}`.trim());
  await record(otherId, 'introduction.made', `To ${await referenceOf(id)}. ${reason}`.trim());
  send(res, 201, { ok: true });
}

function profileLink(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol) || text.length > 500) {
    throw new HttpError(400, 'A profile link starts with https:// and is the address of their '
      + 'profile page, on Skills Economy, Quora, or wherever they are.');
  }
  return text;
}

export async function recordIntroduction(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const introId = orderId(body.introductionId);
  const outcome = String(body.outcome || '');
  if (!isIntroductionOutcome(outcome)) {
    throw new HttpError(400, `Pick one: ${INTRODUCTION_OUTCOMES.join(', ')}.`);
  }
  const note = String(body.note || '').trim().slice(0, 2000);

  const done = await sql()`
    update introductions set
      outcome = ${outcome},
      outcome_encrypted = ${note ? encrypt(note) : null},
      updated_at = now()
     where id = ${introId} and (a_order_id = ${id} or b_order_id = ${id})
     returning a_order_id, b_order_id
  `;
  if (!done.length) throw new HttpError(404, 'No introduction with that number involving them.');
  await record(id, 'introduction.recorded', `${outcome}. ${note}`.trim());
  send(res, 200, { ok: true, outcome });
}
