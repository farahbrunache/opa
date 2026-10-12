import { sql } from './db.js';
import { decrypt, encrypt, keyedHash } from './crypto.js';
import { HttpError } from './http.js';
import { record } from './desk-events.js';
import { sheetSteps } from './sheet.js';

const open = (value) => (value ? decrypt(value) : null);

async function currentOf(caseId) {
  const [chapter] = await sql()`
    select id, number, name_encrypted, started_at, steps_encrypted, steps_written_at, steps_posted_hash
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
  const ticks = await sql()`select step from chapter_ticks where chapter_id = ${chapter.id} order by step`;
  return {
    chapter: { number: chapter.number, name: open(chapter.name_encrypted), startedAt: chapter.started_at },
    steps: chapter.steps_encrypted
      ? { text: open(chapter.steps_encrypted), at: chapter.steps_written_at, done: ticks.map((t) => Number(t.step)) }
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

export async function tickChapterStep(account, step, done) {
  const [chapter] = await sql()`
    select c.id, c.number, c.steps_encrypted from chapters c join cases k on k.id = c.case_id
     where k.account_id = ${account} and c.ended_at is null and c.number > 1
     order by c.number desc limit 1
  `;
  if (!chapter?.steps_encrypted) throw new HttpError(409, 'There are no next steps on this direction to mark yet.');
  const count = sheetSteps(decrypt(chapter.steps_encrypted)).steps.length;
  if (!Number.isInteger(step) || step < 1 || step > count) {
    throw new HttpError(400, `Your next steps have ${count} step${count === 1 ? '' : 's'}. Reload the page and try again.`);
  }
  const changed = done
    ? await sql()`insert into chapter_ticks (chapter_id, step) values (${chapter.id}, ${step})
                  on conflict do nothing returning step`
    : await sql()`delete from chapter_ticks where chapter_id = ${chapter.id} and step = ${step} returning step`;
  const [order] = await sql()`select id from orders where client_account_id = ${account} order by id desc limit 1`;
  if (changed.length && order) {
    await record(order.id, done ? 'step.done' : 'step.undone',
      `Step ${step} of Chapter ${chapter.number} ${done ? 'marked done' : 'unmarked'} by the client.`);
  }
  const ticks = await sql()`select step from chapter_ticks where chapter_id = ${chapter.id} order by step`;
  return { chapter: chapter.number, done: ticks.map((t) => Number(t.step)) };
}
