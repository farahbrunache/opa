import { ensureSchema, sql } from './db.js';
import { encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { CONTACT_PAID, CONTACT_STATUSES, isContactStatus } from './desk.js';
import { caseOf, orderId, record } from './desk-events.js';
import { profileIdFrom } from './desk-directory.js';

function needsCase(caseId) {
  if (caseId === null) {
    throw new HttpError(
      409,
      'Nobody has signed in against this order yet, so there is no case to hang a contact on. '
        + 'They link it by opening their claim link while signed in.',
    );
  }
  return caseId;
}

async function contactUnder(caseId, contactId) {
  const rows = await sql()`
    select id, status from contacts where id = ${contactId} and case_id = ${caseId}
  `;
  if (!rows.length) throw new HttpError(404, 'No contact with that number for this person.');
  return rows[0];
}

export async function addContact(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const profileId = profileIdFrom(body.directory);
  const name = String(body.name || '').trim().slice(0, 200);
  if (!name && !profileId) {
    throw new HttpError(400, 'Who is it? A name, or whatever they are known as, or their Directory link.');
  }

  await sql()`
    insert into contacts (case_id, name_encrypted, where_encrypted, why_encrypted, directory_profile_encrypted)
    values (${caseId}, ${encrypt(name)},
            ${String(body.where || '').trim().slice(0, 200) ? encrypt(String(body.where).trim().slice(0, 200)) : null},
            ${String(body.why || '').trim().slice(0, 500) ? encrypt(String(body.why).trim().slice(0, 500)) : null},
            ${profileId ? encrypt(profileId) : null})
  `;
  await record(id, 'contact.added', name || 'Somebody from the Directory');
  send(res, 201, { ok: true });
}

export async function reachOut(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const contact = await contactUnder(caseId, orderId(body.contactId));

  const said = String(body.said || '').trim().slice(0, 2000);
  const back = String(body.back || '').trim().slice(0, 2000);
  const channel = String(body.channel || '').trim().slice(0, 100);
  if (!said && !back) {
    throw new HttpError(400, 'Write what was said, what came back, or both.');
  }

  await sql()`
    insert into outreach (contact_id, said_encrypted, back_encrypted, channel_encrypted)
    values (${contact.id}, ${said ? encrypt(said) : null}, ${back ? encrypt(back) : null},
            ${channel ? encrypt(channel) : null})
  `;

  if (contact.status === 'to approach') {
    await sql()`update contacts set status = 'reached out', updated_at = now() where id = ${contact.id}`;
  } else {
    await sql()`update contacts set updated_at = now() where id = ${contact.id}`;
  }

  await record(id, 'contact.reached', [channel, said, back].filter(Boolean).join(' — '));
  send(res, 201, { ok: true });
}

export async function moveContact(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const contact = await contactUnder(caseId, orderId(body.contactId));

  const status = String(body.status || '');
  if (!isContactStatus(status)) {
    throw new HttpError(400, `Pick a status: ${CONTACT_STATUSES.join(', ')}.`);
  }

  await sql()`update contacts set status = ${status}, updated_at = now() where id = ${contact.id}`;

  let firstCustomerAt = null;
  if (status === CONTACT_PAID) {
    const [row] = await sql()`
      update cases set first_customer_at = coalesce(first_customer_at, now())
       where id = ${caseId}
      returning first_customer_at
    `;
    firstCustomerAt = row?.first_customer_at ?? null;
  }

  await record(id, 'contact.moved', status);
  send(res, 200, { ok: true, status, firstCustomerAt });
}
