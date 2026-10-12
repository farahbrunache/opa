import { ensureSchema, sql } from './db.js';
import { readChoice } from './settings.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { askAndRecord, MODEL_CHOICE } from './desk-drafts.js';
import { scopeOf } from './chapter-scope.js';
import { markUsed } from './draft-jobs.js';
import { prompt } from './prompts.js';

export const CALL_FIELDS = [
  ['trade', 'Job title'],
  ['rate', 'Rate'],
  ['inTheWay', "What's in the way"],
  ['firstCustomer', 'First customer'],
];
const MAX_FIELD = 300;

export function readFields(stored) {
  if (!stored) return null;
  try {
    const raw = JSON.parse(decrypt(stored));
    return Object.fromEntries(CALL_FIELDS.map(([key]) => [key, String(raw[key] || '')]));
  } catch {
    return null;
  }
}

function callId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Say which call these are for.');
  return id;
}

export async function saveCallFields(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const call = callId(body.call);
  const fields = Object.fromEntries(CALL_FIELDS.map(([key]) =>
    [key, String(body.fields?.[key] || '').trim().slice(0, MAX_FIELD)]));
  const empty = CALL_FIELDS.every(([key]) => !fields[key]);
  const saved = await sql()`
    update calls set fields_encrypted = ${empty ? null : encrypt(JSON.stringify(fields))}
     where id = ${call} and order_id = ${id}
     returning id
  `;
  if (!saved.length) throw new HttpError(404, 'That call isn\'t on this order.');
  await markUsed(id, `fields:${call}`);
  await record(id, 'call-fields', empty ? 'Cleared the four lines on a call.' : 'Saved the four lines on a call.');
  send(res, 200, { fields: empty ? null : fields });
}

export function parseFields(text) {
  const labels = { trade: 'trade', rate: 'rate', inTheWay: 'in the way', firstCustomer: 'first customer' };
  const out = {};
  for (const [key, label] of Object.entries(labels)) {
    const plain = String(text || '').replace(/\*/g, '');
    const found = plain.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'));
    out[key] = found ? found[1].trim().slice(0, MAX_FIELD) : '';
  }
  return out;
}

export async function draftCallFields(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  let words;
  if (body.brief === true) {
    const scope = await scopeOf(id);
    if (!scope.later || !scope.brief) {
      throw new HttpError(409, 'This chapter has no starting brief, so there\'s nothing to read the four lines from.');
    }
    words = scope.brief;
  } else {
    const call = callId(body.call);
    const rows = await sql()`
      select transcript_encrypted from calls
       where id = ${call} and order_id = ${id} and transcript_encrypted is not null
    `;
    if (!rows.length) {
      throw new HttpError(409, 'That call has no transcript, so there\'s nothing to read the four lines from.');
    }
    words = decrypt(rows[0].transcript_encrypted);
  }
  const messages = [
    { role: 'system', content: await prompt('fields') },
    { role: 'user', content: words },
  ];
  send(res, 202, await askAndRecord(id, messages, await readChoice(MODEL_CHOICE),
    body.brief === true ? 'fields:brief' : `fields:${body.call}`));
}

export function finishFields(answer) {
  return { fields: parseFields(answer.content), model: answer.model, seconds: answer.seconds };
}
