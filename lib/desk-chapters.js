import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { caseOf, orderId, record } from './desk-events.js';
import { standingFor } from './session-decision.js';
import { CALL_FIELDS } from './desk-callfields.js';
import { markUsed } from './draft-jobs.js';

const NAME_MAX = 120;
const LINE_MAX = 300;
const BRIEF_MAX = 8000;
const SUMMARY_MAX = 4000;

const open = (value) => (value ? decrypt(value) : null);
const words = (text) => (text ? text.trim().split(/\s+/).filter(Boolean).length : 0);

function needsCase(caseId) {
  if (caseId === null) {
    throw new HttpError(409, 'Nobody has signed in against this order yet, so there is no person '
      + 'to start a chapter on. They link it by opening their claim link while signed in.');
  }
  return caseId;
}

export async function chaptersFor(caseId) {
  if (caseId === null || caseId === undefined) return [];
  const rows = await sql()`
    select c.id, c.number, c.name_encrypted, c.started_at, c.ended_at, c.brief_encrypted,
           c.changed_encrypted, c.started_by, c.from_message_id, c.from_call_id, c.summary_encrypted,
           c.decision, c.decision_at, c.closed_with_encrypted, c.fields_encrypted,
           (select count(*)::int from calls x join orders o on o.id = x.order_id
             where o.case_id = c.case_id and x.transcript_encrypted is not null
               and coalesce(x.chapter_id, first.id) = c.id) as calls
      from chapters c
      join chapters first on first.case_id = c.case_id and first.number = 1
     where c.case_id = ${caseId}
     order by c.number
  `;
  return rows.map((c) => ({
    id: c.id,
    number: c.number,
    name: open(c.name_encrypted),
    startedAt: c.started_at,
    endedAt: c.ended_at,
    brief: open(c.brief_encrypted),
    changed: open(c.changed_encrypted),
    startedBy: c.started_by,
    fromMessageId: c.from_message_id,
    fromCallId: c.from_call_id,
    summary: open(c.summary_encrypted),
    summaryWords: words(open(c.summary_encrypted)),
    decision: c.decision,
    decisionAt: c.decision_at,
    closedWith: c.closed_with_encrypted ? JSON.parse(decrypt(c.closed_with_encrypted)) : null,
    fields: c.fields_encrypted ? JSON.parse(decrypt(c.fields_encrypted)) : null,
    calls: c.calls,
  }));
}

async function current(caseId) {
  const [row] = await sql()`
    select id, number, name_encrypted, started_at from chapters
     where case_id = ${caseId} and ended_at is null
     order by number desc limit 1
  `;
  if (!row) throw new HttpError(409, 'This person has no open chapter. Refresh and try again.');
  return row;
}

export async function decideInChapter(id, decision, note) {
  const caseId = await caseOf(id);
  if (caseId === null) return false;
  const now = await current(caseId);
  if (now.number === 1) return false;
  await sql()`update chapters set decision = ${decision}, decision_at = now() where id = ${now.id}`;
  await record(id, 'decided', `${decision}. Chapter ${now.number}. ${String(note || '').trim()}`.trim());
  return true;
}

function startOf(value, after) {
  const today = new Date().toISOString().slice(0, 10);
  const day = String(value || today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'Pick the day the chapter starts.');
  if (day > today) throw new HttpError(400, "A chapter can't start in the future. Pick today or an earlier day.");
  const at = day === today ? new Date() : new Date(`${day}T00:00:00Z`);
  if (at <= new Date(after)) {
    throw new HttpError(400, 'That day is before the current chapter started. Pick a later one.');
  }
  return at;
}

const choice = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

export async function pivot(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));

  const name = String(body.name || '').trim().slice(0, NAME_MAX);
  if (!name) throw new HttpError(400, 'Name the new chapter.');
  const startedBy = 'them';
  const changed = String(body.changed || '').trim().slice(0, LINE_MAX);
  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const summary = String(body.summary || '').trim().slice(0, SUMMARY_MAX);
  const closingName = String(body.closingName || '').trim().slice(0, NAME_MAX);
  const activities = choice(body.activities, ['carry', 'close'], 'close');
  const work = choice(body.work, ['carry', 'close'], 'close');
  const introductions = choice(body.introductions, ['carry', 'leave'], 'carry');
  const decision = choice(body.decision, ['reset', 'keep'], 'reset');
  const contacts = Array.isArray(body.contacts) ? body.contacts.map(Number).filter(Number.isFinite) : [];

  let fromMessageId = null;
  if (body.fromMessageId !== undefined && body.fromMessageId !== null && body.fromMessageId !== '') {
    const [message] = await sql()`
      select m.id from messages m join cases k on k.account_id = m.account_id
       where m.id = ${Number(body.fromMessageId)} and k.id = ${caseId} and m.author = 'client'
    `;
    if (!message) throw new HttpError(400, "That message isn't one of theirs. Start the chapter from one they wrote.");
    fromMessageId = message.id;
  }

  const old = await current(caseId);

  let fromCall = null;
  if (body.fromCallId !== undefined && body.fromCallId !== null && body.fromCallId !== '') {
    if (fromMessageId) throw new HttpError(400, 'Start the chapter from a message or from a call, not both.');
    const [call] = await sql()`
      select x.id, x.order_id from calls x join orders o on o.id = x.order_id
       where x.id = ${Number(body.fromCallId)} and o.case_id = ${caseId}
         and x.transcript_encrypted is not null
         and coalesce(x.chapter_id, ${old.number === 1 ? old.id : null}) = ${old.id}
    `;
    if (!call) throw new HttpError(400, `That call isn't in Chapter ${old.number} of this record. Start from one that is.`);
    fromCall = call;
  }
  const at = startOf(body.startsOn, old.started_at);
  const kept = decision === 'keep'
    ? (old.number === 1 ? (await standingFor(id)).decision : (await sql()`
        select decision from chapters where id = ${old.id}`)[0].decision)
    : null;

  const [next] = await sql()`
    insert into chapters (case_id, number, name_encrypted, started_at, brief_encrypted,
                          changed_encrypted, started_by, from_message_id, from_call_id, decision, decision_at)
    values (${caseId}, ${old.number + 1}, ${encrypt(name)}, ${at.toISOString()},
            ${brief ? encrypt(brief) : null}, ${changed ? encrypt(changed) : null}, ${startedBy},
            ${fromMessageId}, ${fromCall ? fromCall.id : null}, ${kept}, ${kept ? new Date().toISOString() : null})
    returning id, number
  `;

  const carried = ['sessions', 'skills profile'];

  if (fromCall) {
    await sql()`update calls set chapter_id = ${next.id} where id = ${fromCall.id}`;
    await sql()`update call_gaps set chapter_id = ${next.id} where call_id = ${fromCall.id}`;
    await sql()`
      update recaps set chapter_id = ${next.id}
       where order_id = ${fromCall.order_id} and (chapter_id = ${old.id} or chapter_id is null)
    `;
    carried.push('the call it started from');
  }
  const closed = { activities: [], work: [] };

  if (contacts.length) {
    const moved = await sql()`
      update contacts set chapter_id = ${next.id}
       where case_id = ${caseId} and id = any(${contacts})
         and (chapter_id = ${old.id} or chapter_id is null)
      returning id
    `;
    if (moved.length) carried.push(`${moved.length} ${moved.length === 1 ? 'person' : 'people'} to approach`);
  }

  if (introductions === 'carry') {
    const a = await sql()`
      update introductions set a_chapter_id = ${next.id}
       where a_case_id = ${caseId} and outcome = 'waiting'
         and (a_chapter_id = ${old.id} or a_chapter_id is null)
      returning id
    `;
    const b = await sql()`
      update introductions set b_chapter_id = ${next.id}
       where b_case_id = ${caseId} and outcome = 'waiting'
         and (b_chapter_id = ${old.id} or b_chapter_id is null)
      returning id
    `;
    const n = a.length + b.length;
    if (n) carried.push(`${n} waiting ${n === 1 ? 'introduction' : 'introductions'}`);
  }

  const [plan] = await sql()`select id from plans where case_id = ${caseId} and in_force`;
  if (activities === 'carry') {
    if (plan) {
      await sql()`update plans set chapter_id = ${next.id} where id = ${plan.id}`;
      carried.push('the goal');
    }
    const moved = await sql()`
      update activities set chapter_id = ${next.id}
       where case_id = ${caseId} and state in ('todo', 'drafted')
      returning id
    `;
    if (moved.length) carried.push(`${moved.length} open ${moved.length === 1 ? 'activity' : 'activities'}`);
  } else {
    const shut = await sql()`
      update activities set state = 'dropped', drop_reason = 'changed-direction', closed_at = now(),
             next_at = null, updated_at = now()
       where case_id = ${caseId} and state in ('todo', 'drafted')
      returning title_encrypted
    `;
    closed.activities = shut.map((m) => decrypt(m.title_encrypted));
    if (plan) await sql()`update plans set in_force = false where id = ${plan.id}`;
  }

  if (work === 'carry') {
    const w = await sql()`
      update work set chapter_id = ${next.id}
       where case_id = ${caseId} and done_at is null and state <> 'dropped'
      returning id
    `;
    if (w.length) carried.push(`${w.length} open ${w.length === 1 ? 'piece' : 'pieces'} of work`);
  } else {
    const left = await sql()`
      select id, title_encrypted, note_encrypted from work
       where case_id = ${caseId} and done_at is null and state <> 'dropped'
    `;
    const line = `Dropped when Chapter ${next.number} started.`;
    for (const p of left) {
      const note = p.note_encrypted ? `${decrypt(p.note_encrypted)}\n${line}` : line;
      await sql()`
        update work set state = 'dropped', note_encrypted = ${encrypt(note)}, updated_at = now()
         where id = ${p.id}
      `;
      closed.work.push(decrypt(p.title_encrypted));
    }
  }

  const frozen = old.number === 1 ? await standingFor(id) : null;
  await sql()`
    update chapters set
      ended_at = ${at.toISOString()},
      name_encrypted = coalesce(name_encrypted, ${closingName ? encrypt(closingName) : null}),
      summary_encrypted = coalesce(${summary ? encrypt(summary) : null}, summary_encrypted),
      decision = coalesce(decision, ${frozen?.decision || null}),
      decision_at = coalesce(decision_at, ${frozen?.at ? new Date(frozen.at).toISOString() : null}),
      closed_with_encrypted = ${encrypt(JSON.stringify(closed))}
     where id = ${old.id}
  `;

  const shut = [];
  if (closed.activities.length) {
    shut.push(`${closed.activities.length} ${closed.activities.length === 1 ? 'activity' : 'activities'} dropped as changed direction`);
  }
  if (closed.work.length) shut.push(`${closed.work.length} ${closed.work.length === 1 ? 'piece' : 'pieces'} of work dropped`);
  if (summary) await markUsed(id, 'summary');
  await record(id, 'pivot', [
    `Chapter ${next.number} started: ${name}.`,
    `Carried: ${carried.join(', ')}.`,
    shut.length ? `Closed: ${shut.join(', ')}.` : null,
    `Decision ${kept ? `kept (${kept})` : 'reset'}.`,
    summary ? `Chapter ${old.number} summary saved, ${words(summary)} words.` : null,
  ].filter(Boolean).join(' '));

  send(res, 201, { ok: true, number: next.number });
}

export async function editChapter(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = needsCase(await caseOf(id));
  const [chapter] = await sql()`
    select id, number, ended_at from chapters where case_id = ${caseId} and number = ${Number(body.number)}
  `;
  if (!chapter) throw new HttpError(404, 'No chapter with that number on this person.');

  const field = String(body.field || '');
  if (field === 'fields') {
    if (chapter.ended_at) throw new HttpError(409, `Chapter ${chapter.number} is history, so its lines stay as they were.`);
    const fields = Object.fromEntries(CALL_FIELDS.map(([key]) =>
      [key, String(body.fields?.[key] || '').trim().slice(0, LINE_MAX)]));
    const empty = CALL_FIELDS.every(([key]) => !fields[key]);
    await sql()`update chapters set fields_encrypted = ${empty ? null : encrypt(JSON.stringify(fields))} where id = ${chapter.id}`;
    await markUsed(id, 'fields:brief');
    await record(id, 'chapter.edited', `Chapter ${chapter.number} lines from the brief ${empty ? 'cleared' : 'saved'}.`);
    send(res, 200, { ok: true, fields: empty ? null : fields });
    return;
  }
  const limits = { name: NAME_MAX, brief: BRIEF_MAX, summary: SUMMARY_MAX };
  if (!limits[field]) throw new HttpError(400, 'Pick what to change: name, brief, summary or the lines from the brief.');
  if (field === 'brief' && chapter.ended_at) {
    throw new HttpError(409, `Chapter ${chapter.number} is history, so its brief stays as it was.`);
  }
  if (field === 'summary' && !chapter.ended_at) {
    throw new HttpError(409, 'A summary is written when a chapter closes. This one is still open.');
  }
  const text = String(body.text || '').trim().slice(0, limits[field]);
  if (field === 'name' && !text) throw new HttpError(400, 'A chapter needs a name.');
  const sealed = text ? encrypt(text) : null;
  if (field === 'name') await sql()`update chapters set name_encrypted = ${sealed} where id = ${chapter.id}`;
  if (field === 'brief') await sql()`update chapters set brief_encrypted = ${sealed} where id = ${chapter.id}`;
  if (field === 'summary') {
    await sql()`update chapters set summary_encrypted = ${sealed} where id = ${chapter.id}`;
    await markUsed(id, 'summary');
  }
  await record(id, 'chapter.edited', `Chapter ${chapter.number} ${field}${text ? '' : ' cleared'}.`);
  send(res, 200, { ok: true });
}
