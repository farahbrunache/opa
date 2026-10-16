import { sql } from './db.js';
import { decrypt } from './crypto.js';
import { prompt } from './prompts.js';
import { liveStrategy, strategyLines } from './strategy.js';

const open = (value) => (value ? decrypt(value) : null);
const on = (value) => new Date(value).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const wordsIn = (text) => (text ? String(text).trim().split(/\s+/).filter(Boolean).length : 0);

export async function scopeOf(orderId, { withSummary = false, lead: leads = true } = {}) {
  const [row] = await sql()`select case_id from orders where id = ${orderId}`;
  const caseId = row?.case_id === null || row?.case_id === undefined ? null : Number(row.case_id);
  const chapters = caseId === null ? [] : await sql()`
    select id, number, name_encrypted, started_at, brief_encrypted, summary_encrypted,
           decision, decision_at
      from chapters where case_id = ${caseId} order by number
  `;
  const now = chapters[chapters.length - 1] || null;
  const before = chapters.length > 1 ? chapters[chapters.length - 2] : null;
  const later = Boolean(now && now.number > 1);
  const scope = {
    caseId,
    later,
    chapterId: now ? Number(now.id) : null,
    firstId: chapters.length ? Number(chapters[0].id) : null,
    number: now?.number || 1,
    name: open(now?.name_encrypted),
    startedAt: later ? now.started_at : null,
    brief: open(now?.brief_encrypted),
    strategy: await liveStrategy(orderId),
    decision: later ? now.decision : undefined,
    previous: before ? { number: before.number, name: open(before.name_encrypted), summary: open(before.summary_encrypted) } : null,
    withSummary: Boolean(withSummary),
  };
  scope.holds = (stamp) => !now || Number(stamp ?? scope.firstId) === scope.chapterId;
  scope.since = (at) => !later || new Date(at) >= new Date(now.started_at);

  const lead = [];
  if (later && leads) {
    lead.push(await prompt('chapter', {
      chapter: `Chapter ${scope.number}${scope.name ? `: ${scope.name}` : ''}`, since: on(now.started_at),
    }));
    if (scope.brief) lead.push(`Their starting brief for this chapter:\n${scope.brief}`);
  }
  if (scope.withSummary && scope.previous?.summary) {
    lead.push(`Summary of Chapter ${scope.previous.number}, the direction before this one:\n${scope.previous.summary}`);
  }
  scope.lead = lead;
  return scope;
}

export async function readsFor(orderId, accountId) {
  const scope = await scopeOf(orderId, { lead: false });
  if (!scope.later) return null;
  const messages = accountId ? await sql()`
    select body_encrypted from messages
     where account_id = ${accountId} and created_at >= ${new Date(scope.startedAt).toISOString()}
  ` : [];
  const calls = await sql()`
    select c.transcript_encrypted from calls c join orders o on o.id = c.order_id
     where o.case_id = ${scope.caseId} and c.transcript_encrypted is not null
       and coalesce(c.chapter_id, ${scope.firstId}) = ${scope.chapterId}
  `;
  const words = wordsIn(scope.brief)
    + messages.reduce((n, m) => n + wordsIn(decrypt(m.body_encrypted)), 0)
    + calls.reduce((n, c) => n + wordsIn(decrypt(c.transcript_encrypted)), 0);
  return {
    number: scope.number,
    since: scope.startedAt,
    brief: Boolean(scope.brief),
    messages: messages.length,
    calls: calls.length,
    words,
    previous: scope.previous?.summary
      ? { number: scope.previous.number, words: wordsIn(scope.previous.summary) } : null,
  };
}

export async function chapterInFull(caseId, number) {
  const [chapter] = await sql()`
    select c.id, c.number, c.name_encrypted, c.started_at, c.ended_at, c.brief_encrypted, c.decision,
           k.account_id,
           (select id from chapters where case_id = c.case_id and number = 1) as first_id
      from chapters c join cases k on k.id = c.case_id
     where c.case_id = ${caseId} and c.number = ${number}
  `;
  if (!chapter) return null;
  const ended = chapter.ended_at || new Date().toISOString();
  const lines = [`Chapter ${chapter.number}${chapter.name_encrypted ? `: ${decrypt(chapter.name_encrypted)}` : ''}, `
    + `${on(chapter.started_at)} to ${chapter.ended_at ? on(chapter.ended_at) : 'now'}.`];
  if (chapter.brief_encrypted) lines.push(`Starting brief:\n${decrypt(chapter.brief_encrypted)}`);
  if (chapter.decision) lines.push(`Decision: ${chapter.decision}.`);
  const calls = await sql()`
    select c.transcript_encrypted, c.started_at, o.id as order_id from calls c join orders o on o.id = c.order_id
     where o.case_id = ${caseId} and c.transcript_encrypted is not null
       and coalesce(c.chapter_id, ${chapter.first_id}) = ${chapter.id}
     order by c.started_at
  `;
  for (const call of calls) {
    lines.push(`Call on ${on(call.started_at)}:\n${decrypt(call.transcript_encrypted).slice(0, 6000)}`);
  }
  const order = calls[0]?.order_id ?? (await sql()`select id from orders where case_id = ${caseId} order by id desc limit 1`)[0]?.id;
  const strategy = order ? await liveStrategy(Number(order), { before: ended }) : null;
  if (strategy) lines.push(strategyLines(strategy, 6000).join('\n'));
  const steps = await sql()`
    select title_encrypted, state from activities
     where case_id = ${caseId} and coalesce(chapter_id, ${chapter.first_id}) = ${chapter.id}
     order by position, id
  `;
  for (const step of steps) lines.push(`Activity, ${step.state}: ${decrypt(step.title_encrypted)}`);
  const said = await sql()`
    select author, body_encrypted, created_at from messages
     where account_id = ${chapter.account_id}
       and created_at >= ${new Date(chapter.started_at).toISOString()} and created_at < ${new Date(ended).toISOString()}
     order by created_at desc limit 40
  `;
  for (const m of said.reverse()) {
    lines.push(`${on(m.created_at)} ${m.author === 'client' ? 'them' : 'organizer'}: ${decrypt(m.body_encrypted).slice(0, 800)}`);
  }
  return lines.join('\n\n');
}
