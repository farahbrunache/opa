import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { askAndRecord } from './desk-drafts.js';
import { markUsed } from './draft-jobs.js';
import { scopeOf } from './chapter-scope.js';
import { prompt } from './prompts.js';
import {
  CHANGED_MAX, STRATEGY_MAX, TAKEAWAYS_MAX, liveStrategy, readTakeaways, strategyLines,
} from './strategy.js';

const TRANSCRIPT_CHARS = 12000;
const MESSAGES_SINCE = 40;
const OUTCOMES_SINCE = 20;

export function readStrategy(content) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  let changed = '';
  const kept = [];
  for (const line of lines) {
    const m = line.replace(/\*/g, '').match(/^\s*#*\s*what changed\s*:\s*(.+)$/i);
    if (m && !changed) changed = m[1].trim().slice(0, CHANGED_MAX);
    else kept.push(line);
  }
  const at = kept.findIndex((l) => /^\s*#*\s*\**\s*key takeaways\s*\**\s*:?\s*\**\s*$/i.test(l));
  const body = (at === -1 ? kept : kept.slice(0, at)).join('\n').trim().slice(0, STRATEGY_MAX);
  const takeaways = at === -1 ? [] : readTakeaways(kept.slice(at + 1).join('\n').replace(/\*\*/g, ''));
  return { body, takeaways, changed };
}

async function since(id, at) {
  const [order] = await sql()`select case_id, client_account_id from orders where id = ${id}`;
  const caseId = order?.case_id ?? null;
  const stamp = new Date(at).toISOString();
  const calls = await sql()`
    select c.transcript_encrypted, c.ended_at from calls c join orders o on o.id = c.order_id
     where c.transcript_encrypted is not null and coalesce(c.ended_at, c.started_at) > ${stamp}::timestamptz
       and (o.id = ${id} or (${caseId}::bigint is not null and o.case_id = ${caseId}))
     order by c.ended_at asc nulls last
  `;
  const said = order?.client_account_id ? await sql()`
    select author, body_encrypted from messages
     where account_id = ${order.client_account_id} and created_at > ${stamp}::timestamptz
     order by created_at desc limit ${MESSAGES_SINCE}
  ` : [];
  const outcomes = caseId === null ? [] : await sql()`
    select title_encrypted, state, outcome_encrypted from activities
     where case_id = ${caseId} and outcome_encrypted is not null
       and coalesce(closed_at, updated_at) > ${stamp}::timestamptz
     order by coalesce(closed_at, updated_at) desc limit ${OUTCOMES_SINCE}
  `;
  return {
    count: calls.length + said.length + outcomes.length,
    lines: [
      '', 'Calls since:', ...(calls.length
        ? calls.map((c) => decrypt(c.transcript_encrypted).slice(0, TRANSCRIPT_CHARS)) : ['none']),
      '', 'Messages since:', ...(said.length
        ? said.reverse().map((m) => `${m.author === 'client' ? 'Them' : 'You'}: ${decrypt(m.body_encrypted)}`)
        : ['none']),
      '', 'Roadmap outcomes since:', ...(outcomes.length
        ? outcomes.map((a) => `${decrypt(a.title_encrypted)} · ${a.state} · ${decrypt(a.outcome_encrypted)}`)
        : ['none']),
    ],
  };
}

export async function draftStrategy(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const [order] = await sql()`select id from orders where id = ${id}`;
  if (!order) throw new HttpError(404, 'No order with that number.');
  const scope = await scopeOf(id, { withSummary: body.withSummary === true });
  const live = await liveStrategy(id);
  const system = { role: 'system', content: await prompt('strategy') };

  if (live) {
    const fresh = await since(id, live.at);
    if (!fresh.count) {
      throw new HttpError(409, `Nothing has come in since version ${live.version}: no call, message `
        + 'or roadmap outcome. Change it by hand instead.');
    }
    const asked = [system, { role: 'user', content: [
      ...scope.lead, ...(scope.lead.length ? [''] : []),
      'The current strategy. Revise it rather than start over.', '',
      ...strategyLines(live), ...fresh.lines,
    ].join('\n') }];
    return send(res, 202, await askAndRecord(id, asked, 'strategy', { after: live.version }));
  }

  const called = (await sql()`
    select transcript_encrypted, chapter_id from calls
     where order_id = ${id} and transcript_encrypted is not null
     order by ended_at desc nulls last
  `).filter((c) => scope.holds(c.chapter_id)).slice(0, 3);
  if (!called.length && !(scope.later && scope.brief)) {
    throw new HttpError(409, 'No call on this order has a transcript yet, and there\'s no brief to '
      + 'write the strategy from.');
  }
  const asked = [
    system,
    ...(scope.lead.length ? [{ role: 'user', content: scope.lead.join('\n\n') }] : []),
    ...called.reverse().map((c) => ({ role: 'user', content: decrypt(c.transcript_encrypted) })),
  ];
  send(res, 202, await askAndRecord(id, asked, 'strategy', { after: 0 }));
}

export function finishStrategy(answer, context) {
  const read = readStrategy(answer.content);
  if (!read.body) {
    throw new HttpError(502, 'The model answered with no strategy in it, so there is nothing to '
      + 'show. Press again, or write it yourself.');
  }
  return { ...read, after: context.after ?? 0, model: answer.model, seconds: answer.seconds };
}

export async function saveStrategy(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const text = String(body.body || '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new HttpError(400, 'An empty strategy can\'t be saved.');
  if (text.length > STRATEGY_MAX) throw new HttpError(400, `That's over ${STRATEGY_MAX} characters.`);
  const listed = Array.isArray(body.takeaways) ? body.takeaways.join('\n') : String(body.takeaways || '');
  if (listed.length > TAKEAWAYS_MAX) throw new HttpError(400, `The takeaways are over ${TAKEAWAYS_MAX} characters.`);
  const takeaways = readTakeaways(listed);
  const changed = String(body.changed || '').replace(/\s+/g, ' ').trim().slice(0, CHANGED_MAX);

  const [order] = await sql()`select id, case_id from orders where id = ${id}`;
  if (!order) throw new HttpError(404, 'No order with that number.');
  const live = await liveStrategy(id);
  const after = Number(body.after) || 0;
  if ((live?.version || 0) !== after) {
    throw new HttpError(409, `Version ${live?.version} was saved since this page was drawn. Refresh, `
      + 'then make the change again.');
  }
  if (live && live.body === text && JSON.stringify(live.takeaways) === JSON.stringify(takeaways)) {
    throw new HttpError(409, `That's the same as version ${live.version}. Nothing was saved.`);
  }
  const [made] = await sql()`
    insert into strategies (order_id, case_id, version, body_encrypted, takeaways_encrypted, changed_encrypted)
    values (${id}, ${order.case_id}, ${after + 1}, ${encrypt(text)}, ${encrypt(JSON.stringify(takeaways))},
            ${changed ? encrypt(changed) : null})
    returning version, created_at
  `;
  await markUsed(id, 'strategy');
  await record(id, 'strategy', `Version ${made.version}${changed ? `: ${changed}` : '.'}`);
  send(res, 201, { ok: true, version: Number(made.version), at: made.created_at });
}
