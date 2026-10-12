import { sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { HttpError } from './http.js';

export function orderId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which person?');
  return id;
}

export async function record(id, kind, detail) {
  const text = String(detail || '').trim().slice(0, 2000);
  await sql()`
    insert into case_events (order_id, case_id, kind, detail_encrypted)
    select ${id}, o.case_id, ${kind}, ${text ? encrypt(text) : null}
      from orders o where o.id = ${id}
  `;
}

export async function caseOf(orderId) {
  const rows = await sql()`select case_id from orders where id = ${orderId}`;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  return rows[0].case_id === null || rows[0].case_id === undefined
    ? null
    : Number(rows[0].case_id);
}

export async function referenceOf(id) {
  const rows = await sql()`select reference_code from orders where id = ${id}`;
  return rows[0]?.reference_code || `order ${id}`;
}

export function readDetail(row) {
  if (!row.detail_encrypted) return null;
  try {
    return decrypt(row.detail_encrypted);
  } catch {
    return null;
  }
}
