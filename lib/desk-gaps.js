import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { readFields, CALL_FIELDS } from './desk-callfields.js';
import { askAndRecord } from './desk-drafts.js';
import { prompt } from './prompts.js';

export const GAPS_TO_FIND = 5;
const MAX_LINE = 300;
const TRANSCRIPT_CHARS = 12000;

function callOf(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Say which call to read.');
  return id;
}

function summaryText(stored) {
  if (!stored) return null;
  try {
    const s = JSON.parse(decrypt(stored));
    if (typeof s === 'string') return s;
    return typeof s?.call_summary === 'string' ? s.call_summary : null;
  } catch {
    return null;
  }
}

export async function gapNotes(id, call) {
  const [row] = await sql()`
    select c.transcript_encrypted, c.summary_encrypted, c.fields_encrypted, o.case_id
      from calls c join orders o on o.id = c.order_id
     where c.id = ${call} and c.order_id = ${id} and c.transcript_encrypted is not null
  `;
  if (!row) return null;
  const [trade] = await sql()`
    select t.title from orders o join trades t on t.id = o.trade_id
     where o.id = ${id} or (${row.case_id}::bigint is not null and o.case_id = ${row.case_id})
     order by (o.id = ${id}) desc, o.id desc limit 1
  `;
  const fields = readFields(row.fields_encrypted);
  return [
    `Job title: ${trade?.title || 'not set'}`,
    `Summary: ${summaryText(row.summary_encrypted) || 'none'}`,
    ...CALL_FIELDS.map(([key, label]) => `${label}: ${fields?.[key] || 'not set'}`),
    '',
    'Transcript:',
    decrypt(row.transcript_encrypted).slice(0, TRANSCRIPT_CHARS),
  ];
}

export function readGaps(content) {
  const out = [];
  for (const raw of String(content || '').replace(/\*/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const why = line.match(/^(?:[-•]\s*)?(?:why|reason)\s*:\s*(.+)$/i);
    if (why && out.length && !out[out.length - 1].reason) {
      out[out.length - 1].reason = why[1].trim().slice(0, MAX_LINE);
      continue;
    }
    const m = line.match(/^(?:[-•]\s*)?\d+[.)]\s*(.+)$/);
    if (!m) continue;
    if (out.length === GAPS_TO_FIND) break;
    const [question, inline] = m[1].split(/\s+(?:[—-]\s*)?why\s*:\s*/i);
    out.push({ question: question.trim().slice(0, MAX_LINE), reason: (inline || '').trim().slice(0, MAX_LINE) });
  }
  return out.filter((q) => q.question);
}

function shape(row) {
  let questions = [];
  try {
    questions = JSON.parse(decrypt(row.content_encrypted));
  } catch {
    questions = [];
  }
  return {
    id: Number(row.id), callId: Number(row.call_id), at: row.created_at,
    model: row.model, seconds: row.seconds, questions,
  };
}

export async function gapsFor(id, caseId) {
  const rows = await sql()`
    select g.id, g.call_id, g.content_encrypted, g.created_at, d.model, d.seconds
      from call_gaps g join drafts d on d.id = g.draft_id join orders o on o.id = g.order_id
     where g.order_id = ${id} or (${caseId}::bigint is not null and o.case_id = ${caseId})
     order by g.created_at desc, g.id desc
  `;
  return rows.map(shape);
}

export async function findGaps(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const call = callOf(body.call);
  const notes = await gapNotes(id, call);
  if (!notes) {
    throw new HttpError(409, 'That call has no transcript on this session, so there\'s nothing to read for gaps.');
  }
  const asked = [
    { role: 'system', content: await prompt('gaps', { gaps: GAPS_TO_FIND }) },
    { role: 'user', content: notes.join('\n') },
  ];
  send(res, 202, await askAndRecord(id, asked, `gaps:${call}`, { call }));
}

export async function finishGaps(answer, context, done) {
  const questions = readGaps(answer.content);
  if (!questions.length) {
    throw new HttpError(502, 'The model answered without any questions in the shape asked for, '
      + 'so nothing was saved. Press again, or read the call yourself.');
  }
  const [row] = await sql()`
    insert into call_gaps (draft_id, order_id, call_id, content_encrypted)
    values (${done.id}, ${done.order_id}, ${context.call}, ${encrypt(JSON.stringify(questions))})
    returning id, call_id, content_encrypted, created_at
  `;
  const set = shape({ ...row, model: answer.model, seconds: answer.seconds });
  await record(Number(done.order_id), 'call.gaps', `${set.questions.length} questions on a call.`);
  return { model: answer.model, seconds: answer.seconds, set };
}
