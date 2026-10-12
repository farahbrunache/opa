import { ensureSchema, sql } from './db.js';
import { readChoice, underLimit, writeChoice } from './settings.js';
import { decrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import {
  DRAFTS_PER_ORDER,
  DRAFT_WINDOW_SECONDS,
  SLOTS,
  configuredSlots,
  draft as submitJob,
  models,
  resolve,
} from './draft.js';
import { orderId } from './desk-events.js';
import { chapterInFull, scopeOf } from './chapter-scope.js';
import { prompt, sheetPrompt } from './prompts.js';
import { RESUME_WITHIN_SECONDS, closeAbandoned, follow, startJob } from './draft-jobs.js';

export const FAMILIES = [
  ['sheet', 'Draft from the call', 'C'],
  ['roadmap', 'Redraw the roadmap', 'C'],
  ['reply', 'Draft a reply', 'B'],
  ['gaps', 'Find the gaps', 'B'],
  ['questions', 'Pick what to ask next', 'B'],
  ['matches', 'Find matches', 'B'],
  ['recap', 'Catch me up', 'A'],
  ['summary', 'Write the summary', 'A'],
  ['fields', 'Fill from the call', 'A'],
];

export function familyOf(kind) {
  return String(kind || '').split(':')[0] || 'sheet';
}

export function isFamily(value) {
  return FAMILIES.some(([family]) => family === value);
}

export async function slotFor(family) {
  const tier = FAMILIES.find(([name]) => name === family)?.[2] || 'C';
  return (await readChoice(`slot:${family}`)) || tier;
}

export async function familiesNow() {
  const out = [];
  const set = (await configuredSlots()).length > 0;
  for (const [family, label, tier] of FAMILIES) {
    const chosen = await slotFor(family);
    out.push({ family, label, tier, chosen, inUse: set ? (await resolve(chosen)).slot : null });
  }
  return out;
}

export async function chooseModel(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const family = String(body.for || 'sheet');
  if (!isFamily(family)) throw new HttpError(400, `No button is called ${family}.`);
  const slot = String(body.slot || '').toUpperCase();
  if (!SLOTS.includes(slot)) {
    throw new HttpError(400, `The slots are ${SLOTS.slice(0, -1).join(', ')} and ${SLOTS.at(-1)}. That was ${slot || 'empty'}.`);
  }
  const offered = (await models()).map((m) => m.slot);
  if (!offered.includes(slot)) {
    throw new HttpError(409, `Slot ${slot} has no RunPod endpoint yet. Pick one for it under Models first.`);
  }
  await writeChoice(`slot:${family}`, slot);
  send(res, 200, { ok: true, chosen: slot, for: family });
}

export async function askAndRecord(id, said, kind = null, context = {}) {
  const slot = await slotFor(familyOf(kind));
  await closeAbandoned(id);

  const [inFlight] = await sql()`
    select id from drafts
     where order_id = ${id} and finished_at is null and gave_up_at is null
       and job_id is not null and kind is not distinct from ${kind}
       and created_at > now() - (${RESUME_WITHIN_SECONDS} || ' seconds')::interval
     order by created_at desc limit 1
  `;
  if (inFlight) {
    follow(inFlight.id);
    return { draftId: Number(inFlight.id), state: 'running' };
  }

  if (!(await underLimit('draft', String(id), DRAFTS_PER_ORDER, DRAFT_WINDOW_SECONDS))) {
    throw new HttpError(
      429,
      `That is ${DRAFTS_PER_ORDER} drafts against this order today, which is the limit. Write `
        + 'this one, or come back tomorrow.',
    );
  }

  const { job, model } = await submitJob(said, slot);
  const [made] = await sql()`
    insert into drafts (order_id, slot, model, job_id, kind, endpoint_id)
    values (${id}, ${model.slot}, ${model.name}, ${job}, ${kind}, ${model.endpointId})
    returning id
  `;
  return startJob(made, { ...context, fellBack: model.fellBack });
}

export async function writeDraft(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);

  const rows = await sql()`select id, client_account_id from orders where id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  const scope = await scopeOf(id, { withSummary: body.withSummary === true });
  const lead = scope.lead.length ? [{ role: 'system', content: scope.lead.join('\n\n') }] : [];

  if (String(body.of || '') === 'summary') {
    if (scope.caseId === null) throw new HttpError(409, 'Nobody has signed in on this order, so it has no chapters.');
    const text = await chapterInFull(scope.caseId, Number(body.number) || scope.number);
    if (!text) throw new HttpError(404, 'No chapter with that number on this person.');
    const asked = [{ role: 'system', content: await prompt('summary') }, { role: 'user', content: text }];
    return send(res, 202, await askAndRecord(id, asked, 'summary',
      { number: Number(body.number) || scope.number }));
  }

  if (String(body.of || '') === 'recap') {
    const { recapFacts } = await import('./draft-recap.js');
    const record = await recapFacts(id, scope);
    if (!record || record.caseId === null) {
      throw new HttpError(409, 'This order has no case open against it yet, so there is nothing '
        + 'to recap. Record a decision first.');
    }
    if (record.lines.length < 3) {
      throw new HttpError(409, 'There is almost nothing in this record yet — a recap of it would '
        + 'be shorter than reading it. Come back when there is a plan and some work against it.');
    }
    const asked = [
      { role: 'system', content: await prompt('recap', { shared: await prompt('shared') }) },
      { role: 'user', content: record.lines.join('\n') },
    ];
    return send(res, 202, await askAndRecord(id, asked, 'recap'));
  }

  if (String(body.of || '') === 'reply') {
    const account = rows[0].client_account_id;
    if (!account) {
      throw new HttpError(409, 'Nobody has linked an account to this order, so there is no ' +
        'conversation to answer.');
    }
    const since = scope.startedAt ? new Date(scope.startedAt).toISOString() : '-infinity';
    const thread = await sql()`
      select author, body_encrypted from messages
        where account_id = ${account} and created_at >= ${since}::timestamptz
        order by created_at desc
        limit 20
    `;
    if (!thread.length) {
      throw new HttpError(409, 'The conversation has nothing in it yet, so there is nothing ' +
        'to answer.');
    }
    const said = [
      { role: 'system', content: await prompt('reply', { shared: await prompt('shared') }) },
      ...lead,
      ...thread.reverse().map((m) => ({
        role: m.author === 'client' ? 'user' : 'assistant',
        content: decrypt(m.body_encrypted),
      })),
    ];
    return send(res, 202, await askAndRecord(id, said, 'reply'));
  }

  const called = (await sql()`
    select transcript_encrypted, chapter_id from calls
     where order_id = ${id} and transcript_encrypted is not null
     order by ended_at desc nulls last
  `).filter((c) => scope.holds(c.chapter_id)).slice(0, 3);
  if (!called.length && scope.later && scope.brief) {
    const fromBrief = [{ role: 'system', content: await sheetPrompt() }, { role: 'user', content: scope.lead.join('\n\n') }];
    return send(res, 202, await askAndRecord(id, fromBrief));
  }
  if (!called.length) {
    throw new HttpError(
      409,
      'No call against this order has a transcript yet, so there is nothing to write next steps ' +
        'from. Keep the call record first, or wait for the hourly job to take it.',
    );
  }

  const messages = [
    { role: 'system', content: await sheetPrompt() },
    ...lead.map((m) => ({ ...m, role: 'user' })),
    ...called
      .reverse()
      .map((c) => ({ role: 'user', content: decrypt(c.transcript_encrypted) })),
  ];

  send(res, 202, await askAndRecord(id, messages));
}
