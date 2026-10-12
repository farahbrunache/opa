import { sql } from './db.js';
import { decrypt, encrypt, keyedHash } from './crypto.js';
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
  await syncStepsFor(id);
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
    chapter: { number: chapter.number, name: open(chapter.name_encrypted), startedAt: chapter.started_at },
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

const STEP_TITLE = 300;

function stepTitles(text) {
  return sheetSteps(text).steps.map((step) => step.replace(/\s+/g, ' ').trim().slice(0, STEP_TITLE));
}

async function writeSteps(caseId, titles, { orderId = null, chapterId = null, planId = null, ticked = [] }) {
  const held = orderId
    ? await sql()`select id, step_number, state from activities where step_order_id = ${orderId} order by step_number`
    : await sql()`select id, step_number, state from activities where step_chapter_id = ${chapterId} order by step_number`;
  const byNumber = new Map(held.map((a) => [Number(a.step_number), a]));
  const [{ n: next }] = await sql()`
    select coalesce(max(position), 0) + 1 as n from activities where case_id = ${caseId}
  `;
  let position = Number(next);
  for (const [i, title] of titles.entries()) {
    const number = i + 1;
    const was = byNumber.get(number);
    if (was) {
      await sql()`update activities set title_encrypted = ${encrypt(title)}, updated_at = now() where id = ${was.id}`;
      continue;
    }
    const done = ticked.includes(number);
    await sql()`
      insert into activities (case_id, plan_id, position, title_encrypted, state, source, step_order_id,
                              step_chapter_id, step_number, shown_at, closed_at)
      values (${caseId}, ${planId}, ${position}, ${encrypt(title)}, ${done ? 'done' : 'todo'}, 'steps',
              ${orderId}, ${chapterId}, ${number}, now(), ${done ? new Date().toISOString() : null})
    `;
    position += 1;
  }
  for (const a of held) {
    if (Number(a.step_number) <= titles.length || a.state !== 'todo') continue;
    await sql()`delete from activities where id = ${a.id}`;
  }
}

async function approvedCase(caseId) {
  const [row] = await sql()`
    select 1 from orders where case_id = ${caseId} and approved_as_client_at is not null limit 1
  `;
  return Boolean(row);
}

async function planOf(caseId) {
  const [plan] = await sql()`select id from plans where case_id = ${caseId} and in_force`;
  return plan ? Number(plan.id) : null;
}

export async function syncStepsFor(id, ticked = []) {
  const [order] = await sql()`
    select o.id, o.case_id, o.recommendations_encrypted from orders o where o.id = ${id}
  `;
  if (!order?.case_id) return;
  const caseId = Number(order.case_id);
  if (!(await approvedCase(caseId))) return;
  const chapter = await currentOf(caseId);
  const planId = await planOf(caseId);
  if (chapter && chapter.number > 1) {
    if (chapter.steps_encrypted) {
      await writeSteps(caseId, stepTitles(decrypt(chapter.steps_encrypted)), { chapterId: Number(chapter.id), planId });
      await sql()`update chapters set steps_synced_at = now() where id = ${chapter.id}`;
    }
    return;
  }
  if (!order.recommendations_encrypted) return;
  await writeSteps(caseId, stepTitles(decrypt(order.recommendations_encrypted)),
    { orderId: Number(order.id), planId, ticked });
  await sql()`update orders set steps_synced_at = now() where id = ${order.id}`;
}

async function hasTable(name) {
  const [row] = await sql()`select 1 from information_schema.tables where table_name = ${name}`;
  return Boolean(row);
}

export async function syncEveryStep() {
  const orders = await sql()`
    select o.id from orders o
     where o.case_id is not null and o.recommendations_encrypted is not null and o.steps_synced_at is null
       and exists (select 1 from orders a where a.case_id = o.case_id and a.approved_as_client_at is not null)
     order by o.id
  `;
  const stepTicks = await hasTable('step_ticks');
  for (const order of orders) {
    const ticked = stepTicks
      ? (await sql()`select step from step_ticks where order_id = ${order.id}`).map((r) => Number(r.step))
      : [];
    await syncStepsFor(Number(order.id), ticked);
  }
  const chapterTicks = await hasTable('chapter_ticks');
  const chapters = await sql()`
    select c.id, c.case_id, c.steps_encrypted from chapters c
     where c.ended_at is null and c.number > 1 and c.steps_encrypted is not null and c.steps_synced_at is null
       and exists (select 1 from orders a where a.case_id = c.case_id and a.approved_as_client_at is not null)
  `;
  for (const chapter of chapters) {
    const ticked = chapterTicks
      ? (await sql()`select step from chapter_ticks where chapter_id = ${chapter.id}`).map((r) => Number(r.step))
      : [];
    await writeSteps(Number(chapter.case_id), stepTitles(decrypt(chapter.steps_encrypted)),
      { chapterId: Number(chapter.id), planId: await planOf(Number(chapter.case_id)), ticked });
    await sql()`update chapters set steps_synced_at = now() where id = ${chapter.id}`;
  }
  await sql()`drop table if exists step_ticks`;
  await sql()`drop table if exists chapter_ticks`;
}

export async function stepsSummary(caseId, orderId) {
  const rows = orderId === null
    ? await sql()`
        select state from activities a join chapters c on c.id = a.step_chapter_id
         where a.case_id = ${caseId} and c.ended_at is null
      `
    : await sql()`select state from activities where step_order_id = ${orderId}`;
  const counted = rows.filter((r) => r.state !== 'dropped');
  return { steps: counted.length, done: counted.filter((r) => r.state === 'done').length };
}
