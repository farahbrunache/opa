import { sql } from './db.js';
import { decrypt, encrypt, keyedHash } from './crypto.js';
import { record } from './desk-events.js';

const open = (value) => (value ? decrypt(value) : null);

const NEXT = { go: 'roadmap', 'no-go': 'call' };
export const nextMoveOf = (decision) => NEXT[decision] || null;

async function currentOf(caseId) {
  const [chapter] = await sql()`
    select id, number, name_encrypted, started_at, steps_encrypted, steps_written_at, steps_posted_hash, decision
      from chapters where case_id = ${caseId} and ended_at is null
     order by number desc limit 1
  `;
  return chapter || null;
}

export async function recommendInChapter(id, text) {
  const [order] = await sql()`select case_id, client_account_id from orders where id = ${id}`;
  if (!order?.case_id) return false;
  const chapter = await currentOf(order.case_id);
  if (!chapter || chapter.number < 2) return false;
  await sql()`
    update chapters set steps_encrypted = ${encrypt(text)}, steps_written_at = now() where id = ${chapter.id}
  `;
  await record(id, 'recommended', `Written for Chapter ${chapter.number}.`);
  const [talking] = await sql()`
    select 1 from orders where case_id = ${order.case_id} and approved_as_client_at is not null limit 1
  `;
  const hash = keyedHash(`steps:${chapter.id}:${text}`);
  if (talking && order.client_account_id && chapter.steps_posted_hash !== hash) {
    await sql()`
      insert into messages (account_id, author, body_encrypted)
      values (${order.client_account_id}, 'operator', ${encrypt(text)})
    `;
    await sql()`update chapters set steps_posted_hash = ${hash} where id = ${chapter.id}`;
    await record(id, 'steps.posted', 'Posted as a message from you.');
  }
  return true;
}

export async function stepsForRecord(caseId) {
  if (!caseId) return null;
  const chapter = await currentOf(caseId);
  if (!chapter || chapter.number < 2) return null;
  return { text: open(chapter.steps_encrypted), at: chapter.steps_written_at };
}

export async function chapterExtras(caseId) {
  if (!caseId) return { chapter: null, steps: null };
  const chapter = await currentOf(caseId);
  if (!chapter || chapter.number < 2) return { chapter: null, steps: null };
  return {
    chapter: {
      number: chapter.number, name: open(chapter.name_encrypted), startedAt: chapter.started_at, next: nextMoveOf(chapter.decision),
    },
    steps: chapter.steps_encrypted
      ? { text: open(chapter.steps_encrypted), at: chapter.steps_written_at }
      : null,
  };
}

export async function directionsFor(account) {
  const rows = await sql()`
    select c.started_at, c.name_encrypted from chapters c join cases k on k.id = c.case_id
     where k.account_id = ${account} and c.number > 1 order by c.started_at
  `;
  return rows.map((r) => ({ at: r.started_at, name: open(r.name_encrypted) }));
}
