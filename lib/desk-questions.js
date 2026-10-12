import { ensureSchema, sql } from './db.js';
import { prompt } from './prompts.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { readFields, CALL_FIELDS } from './desk-callfields.js';
import { askAndRecord } from './desk-drafts.js';
import { fits, isStage, STAGE_ORDER, STAGES, stageFor } from './questions.js';
import { PASS_REASONS, isPassReason } from './desk.js';
import { standingFor } from './session-decision.js';
import { scopeOf } from './chapter-scope.js';

const MAX_QUESTION = 300;
const MAX_TOPIC = 60;
export const QUESTIONS_PER_ADD = 50;
export const QUESTIONS_TO_PICK = 3;
export const QUESTIONS_A_PAGE = 10;
export const COVERAGE_LOW = 12;

function shape(row) {
  return {
    id: Number(row.id),
    stage: row.stage,
    topic: row.topic_encrypted ? decrypt(row.topic_encrypted) : null,
    body: decrypt(row.body_encrypted),
    sectorId: row.sector_id || null,
    tradeId: row.trade_id || null,
    isDemo: Boolean(row.is_demo),
  };
}

const RANK = { trade: 0, sector: 1, everyone: 2, other: 3 };

function grouped(questions) {
  return [...questions].sort((a, b) =>
    (RANK[a.fit] ?? 0) - (RANK[b.fit] ?? 0)
    || (a.scope || '').localeCompare(b.scope || '')
    || (a.topic === null ? '' : a.topic).localeCompare(b.topic === null ? '' : b.topic) || a.id - b.id);
}

export function linesOf(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

export async function scopes() {
  const rows = await sql()`
    select id, title, sector_id, sector, active from trades
     order by sector_order, sector, title_order, title
  `;
  const trades = new Map();
  const sectors = new Map();
  for (const r of rows) {
    trades.set(r.id, { id: r.id, title: r.title, sectorId: r.sector_id, active: r.active });
    if (!sectors.has(r.sector_id)) sectors.set(r.sector_id, { id: r.sector_id, name: r.sector, trades: [] });
    if (r.active) sectors.get(r.sector_id).trades.push({ id: r.id, title: r.title });
  }
  return { trades, sectors };
}

function scopeLabel(q, { trades, sectors }) {
  if (q.tradeId) return trades.get(q.tradeId)?.title || 'A job title no longer listed';
  if (q.sectorId) return sectors.get(q.sectorId)?.name || 'A sector no longer listed';
  return null;
}

export async function questionsFor(stage, caseId = null, tradeId = null) {
  if (!stage) return [];
  const known = await scopes();
  const sectorId = tradeId ? known.trades.get(tradeId)?.sectorId || null : null;
  const rows = await sql()`
    select q.id, q.stage, q.topic_encrypted, q.body_encrypted, q.sector_id, q.trade_id, q.is_demo,
           max(a.asked_at) as asked_at, count(a.id)::int as asks,
           (select p.reason from question_passes p
             where p.question_id = q.id and p.case_id = ${caseId}
             order by p.passed_at desc limit 1) as pass_reason,
           (select max(p.passed_at) from question_passes p
             where p.question_id = q.id and p.case_id = ${caseId}) as passed_at,
           exists (select 1 from messages m join cases k on k.account_id = m.account_id
                    where k.id = ${caseId} and m.author = 'client'
                      and m.created_at > (select max(x.asked_at) from question_asks x
                                            where x.question_id = q.id and x.case_id = ${caseId})) as answered
      from questions q
      left join question_asks a on a.question_id = q.id and a.case_id = ${caseId}
     group by q.id
     order by q.id
  `;
  const out = [];
  for (const row of rows) {
    const q = shape(row);
    let fit = 'other';
    if (q.tradeId) fit = q.tradeId === tradeId ? 'trade' : 'other';
    else if (q.sectorId) fit = q.sectorId === sectorId ? 'sector' : 'other';
    else fit = 'everyone';
    if (fit === 'other' && !row.asked_at) continue;
    out.push({
      ...q, fit, scope: scopeLabel(q, known), askedAt: row.asked_at || null, asks: Number(row.asks || 0),
      answered: Boolean(row.asked_at) && Boolean(row.answered),
      passedAt: row.passed_at || null,
      passReason: row.pass_reason ? PASS_REASONS[row.pass_reason] || row.pass_reason : null,
    });
  }
  return grouped(out);
}

export function picksFor(questions, stage) {
  return questions
    .filter((q) => q.fit !== 'other' && fits(q, stage) && !q.askedAt && !q.passedAt)
    .slice(0, QUESTIONS_TO_PICK);
}

export async function passQuestion(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const question = questionId(body);
  const reason = String(body.reason || '');
  if (reason && !isPassReason(reason)) {
    throw new HttpError(400, `Pick a reason: ${Object.values(PASS_REASONS).join(', ')}.`);
  }
  const [order] = await sql()`select case_id, is_demo from orders where id = ${id}`;
  if (!order) throw new HttpError(404, 'No order with that number.');
  if (!order.case_id) throw new HttpError(409, 'Nobody has signed in on this order yet, so there is nobody to set it aside for.');
  const rows = await sql()`
    insert into question_passes (case_id, question_id, reason, is_demo)
    select ${order.case_id}, q.id, ${reason || null}, ${order.is_demo} from questions q where q.id = ${question}
    returning id
  `;
  if (!rows.length) throw new HttpError(404, 'No question with that number is on the list.');
  const [q] = await sql()`select body_encrypted from questions where id = ${question}`;
  await record(id, 'question.passed', `${decrypt(q.body_encrypted)}${reason ? ` · ${PASS_REASONS[reason]}` : ''}`);
  send(res, 200, { ok: true });
}

export const ASKED_PER_MESSAGE = 20;

export async function markAsked(id, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, ASKED_PER_MESSAGE);
  if (!wanted.length) return 0;
  const rows = await sql()`
    insert into question_asks (case_id, question_id, asked_at, is_demo)
    select o.case_id, q.id, now(), o.is_demo
      from orders o, questions q
     where o.id = ${id} and o.case_id is not null and q.id = any(${wanted}::bigint[])
    returning question_id
  `;
  if (rows.length) {
    await record(id, 'questions.asked',
      `${rows.length} question${rows.length === 1 ? '' : 's'} asked in a message.`);
  }
  return rows.length;
}

export async function stageOf(id) {
  const rows = await sql()`
    select o.case_id, o.trade_id, k.first_customer_at
      from orders o left join cases k on k.id = o.case_id
     where o.id = ${id}
  `;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  const [row] = rows;
  const decided = (await standingFor(id)).decision;
  const [plan] = row.case_id
    ? await sql()`select path from plans where case_id = ${row.case_id} and in_force limit 1`
    : await sql()`select path from plans where order_id = ${id} and in_force limit 1`;
  return {
    stage: stageFor({ decision: decided, firstCustomerAt: row.first_customer_at, path: plan?.path }),
    caseId: row.case_id,
    tradeId: row.trade_id,
  };
}

export function coverageOf(rows, known) {
  const perStage = () => Object.fromEntries(STAGE_ORDER.map((stage) => [stage, 0]));
  const groups = new Map([['', { key: '', label: 'Everyone', all: 0, stages: perStage() }]]);
  for (const sector of known.sectors.values()) {
    groups.set(`s:${sector.id}`, { key: `s:${sector.id}`, label: sector.name, all: 0, stages: perStage() });
    for (const trade of sector.trades) {
      groups.set(`t:${trade.id}`, { key: `t:${trade.id}`, label: `${sector.name} · ${trade.title}`, all: 0, stages: perStage() });
    }
  }
  let gone = 0;
  for (const row of rows) {
    const key = row.trade_id ? `t:${row.trade_id}` : row.sector_id ? `s:${row.sector_id}` : '';
    const group = groups.get(key);
    if (!group) { gone += 1; continue; }
    group.all += 1;
    if (group.stages[row.stage] !== undefined) group.stages[row.stage] += 1;
  }
  const out = [...groups.values()].filter((g) => g.all > 0 || !g.key.startsWith('t:'));
  if (gone) out.push({ key: 'gone', label: 'No longer in the taxonomy', all: gone, stages: perStage() });
  return out.map((g) => ({
    ...g,
    low: g.all < COVERAGE_LOW || STAGE_ORDER.filter((st) => st !== 'any').some((st) => g.stages[st] === 0),
  }));
}

export function browseOf(rows, known, { group = '', stage = '', q = '', page = 1 }) {
  const asked = squash(q);
  const inGroup = (row) => {
    if (group === 'gone') return (row.sector_id && !known.sectors.has(row.sector_id))
      || (row.trade_id && !known.trades.has(row.trade_id));
    if (group.startsWith('t:')) return row.trade_id === group.slice(2);
    if (group.startsWith('s:')) return row.sector_id === group.slice(2) && !row.trade_id;
    return !row.sector_id && !row.trade_id;
  };
  const found = rows.filter(inGroup).map(shape).map((item) => ({ ...item, scope: scopeLabel(item, known) }))
    .filter((item) => (!stage || item.stage === stage) && (!asked || squash(item.body).includes(asked)
      || squash(item.topic || '').includes(asked)))
    .sort((a, b) => b.id - a.id);
  const last = Math.max(1, Math.ceil(found.length / QUESTIONS_A_PAGE));
  const at = Math.min(Math.max(1, Number(page) || 1), last);
  return {
    group, stage, q: String(q || '').slice(0, 80), page: at, last, perPage: QUESTIONS_A_PAGE, total: found.length,
    questions: found.slice((at - 1) * QUESTIONS_A_PAGE, at * QUESTIONS_A_PAGE),
  };
}

export async function listQuestions(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const params = new URL(req.url, 'https://placeholder.invalid').searchParams;
  const rows = await sql()`
    select id, stage, topic_encrypted, body_encrypted, sector_id, trade_id, is_demo from questions order by id
  `;
  const known = await scopes();
  const topics = [];
  for (const row of rows) {
    if (row.topic_encrypted) topics.push(decrypt(row.topic_encrypted));
  }
  const stage = isStage(params.get('stage') || '') ? params.get('stage') : '';
  send(res, 200, {
    stages: STAGE_ORDER.map((stage) => ({ stage, ...STAGES[stage] })),
    sectors: [...known.sectors.values()].filter((s) => s.trades.length),
    total: rows.length,
    coverage: coverageOf(rows, known),
    browse: browseOf(rows, known, {
      group: String(params.get('group') || '').slice(0, 80), stage, q: params.get('q') || '', page: params.get('page'),
    }),
    topics: [...new Set(topics)].sort(),
  });
}

async function scopeOfBody(body) {
  const known = await scopes();
  const tradeId = String(body.trade || '').trim();
  if (tradeId) {
    const trade = known.trades.get(tradeId);
    if (!trade) throw new HttpError(400, 'That job title is not in the copy of the Skills Taxonomy.');
    return { sectorId: trade.sectorId, tradeId };
  }
  const sectorId = String(body.sector || '').trim();
  if (sectorId) {
    if (!known.sectors.has(sectorId)) throw new HttpError(400, 'That sector is not in the copy of the Skills Taxonomy.');
    return { sectorId, tradeId: null };
  }
  return { sectorId: null, tradeId: null };
}

export async function addQuestion(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const stage = String(body.stage || '');
  if (!isStage(stage)) throw new HttpError(400, 'Say which stage the question is for.');
  const lines = linesOf(body.body);
  if (!lines.length) throw new HttpError(400, 'An empty question is not a question.');
  if (lines.length > QUESTIONS_PER_ADD) {
    throw new HttpError(400, `That's ${lines.length} lines. Add up to ${QUESTIONS_PER_ADD} at once.`);
  }
  const long = lines.findIndex((line) => line.length > MAX_QUESTION);
  if (long !== -1) {
    throw new HttpError(400, `Line ${long + 1} is over ${MAX_QUESTION} characters. Shorten it, `
      + 'or split it in two. Nothing was added.');
  }
  const topic = String(body.topic || '').trim().slice(0, MAX_TOPIC);
  const { sectorId, tradeId } = await scopeOfBody(body);

  const ids = [];
  for (const line of lines) {
    const rows = await sql()`
      insert into questions (stage, topic_encrypted, body_encrypted, sector_id, trade_id)
      values (${stage}, ${topic ? encrypt(topic) : null}, ${encrypt(line)}, ${sectorId}, ${tradeId})
      returning id
    `;
    ids.push(Number(rows[0].id));
  }
  send(res, 201, { ids });
}

export const IMPORT_LINES = 3000;

const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function readBank(text, known) {
  const sectorsByName = new Map([...known.sectors.values()].map((s) => [squash(s.name), s]));
  const stagesByName = new Map(STAGE_ORDER.flatMap((k) => [[k, k], [squash(STAGES[k].label), k]]));
  const out = [];
  const unknown = new Set();
  let sector = null;
  let trade = null;
  let stage = 'any';
  let skip = true;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^(#{1,3})\s+(.+)$/);
    if (head) {
      const name = head[2].trim();
      if (head[1] === '#') {
        trade = null;
        stage = 'any';
        if (squash(name) === 'everyone') {
          sector = null;
          skip = false;
        } else {
          sector = sectorsByName.get(squash(name)) || null;
          skip = !sector;
          if (!sector) unknown.add(name);
        }
      } else if (head[1] === '##') {
        stage = 'any';
        if (skip && !sector) continue;
        if (squash(name) === 'any job title') {
          trade = null;
          skip = false;
        } else {
          trade = sector?.trades.find((t) => squash(t.title) === squash(name)) || null;
          skip = !trade;
          if (!trade) unknown.add(`${sector ? sector.name : 'Everyone'} · ${name}`);
        }
      } else {
        stage = stagesByName.get(squash(name)) || stage;
        if (!stagesByName.has(squash(name))) unknown.add(`Stage: ${name}`);
      }
      continue;
    }
    if (skip || !/^\s*(?:[-*\u2022]|\d+[.)])\s+/.test(raw)) continue;
    const [body] = linesOf(line);
    if (!body || body.length > MAX_QUESTION) continue;
    out.push({ stage, body, sectorId: trade ? null : sector?.id || null, tradeId: trade?.id || null });
  }
  for (const q of out) {
    if (q.tradeId) q.sectorId = known.trades.get(q.tradeId)?.sectorId || null;
  }
  return { questions: out, unknown: [...unknown] };
}

export async function importQuestions(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const text = String(body.text || '');
  if (text.split(/\r?\n/).length > IMPORT_LINES) {
    throw new HttpError(400, `Paste up to ${IMPORT_LINES} lines at once. Nothing was added.`);
  }
  const known = await scopes();
  const { questions, unknown } = readBank(text, known);
  if (!questions.length && !unknown.length) {
    throw new HttpError(400, 'No questions found. Each question starts with a dash, under a # heading.');
  }
  const existing = await sql()`select stage, body_encrypted, sector_id, trade_id from questions`;
  const key = (q) => `${q.stage}|${q.sectorId || ''}|${q.tradeId || ''}|${squash(q.body)}`;
  const seen = new Set(existing.map((row) => key(shape(row))));
  let added = 0;
  for (const q of questions) {
    if (seen.has(key(q))) continue;
    seen.add(key(q));
    await sql()`
      insert into questions (stage, body_encrypted, sector_id, trade_id)
      values (${q.stage}, ${encrypt(q.body)}, ${q.sectorId}, ${q.tradeId})
    `;
    added += 1;
  }
  send(res, 200, { added, skipped: questions.length - added, unknown });
}

function questionId(body) {
  const id = Number(body.question);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Say which question.');
  return id;
}

export async function editQuestion(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = questionId(body);
  const stage = String(body.stage || '');
  if (!isStage(stage)) throw new HttpError(400, 'Say which stage the question is for.');
  const text = String(body.body || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new HttpError(400, 'An empty question is not a question. Delete it instead.');
  if (text.length > MAX_QUESTION) {
    throw new HttpError(400, `That's over ${MAX_QUESTION} characters. Shorten it, or add it as two.`);
  }
  const topic = String(body.topic || '').trim().slice(0, MAX_TOPIC);
  const { sectorId, tradeId } = await scopeOfBody(body);
  const rows = await sql()`
    update questions
       set stage = ${stage}, topic_encrypted = ${topic ? encrypt(topic) : null}, body_encrypted = ${encrypt(text)},
           sector_id = ${sectorId}, trade_id = ${tradeId}
     where id = ${id}
     returning id
  `;
  if (!rows.length) throw new HttpError(404, 'No question with that number is on the list.');
  send(res, 200, { ok: true });
}

export async function deleteQuestion(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const id = questionId(await readJson(req));
  const rows = await sql()`delete from questions where id = ${id} returning id`;
  if (!rows.length) throw new HttpError(404, 'No question with that number is on the list.');
  send(res, 200, { ok: true });
}

const TRANSCRIPT_CHARS = 6000;

export function readPicks(content, questions) {
  const lines = String(content || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const summaryLine = lines.find((l) => /^summary\s*:/i.test(l));
  const picks = [];
  for (const line of lines) {
    const m = line.match(/^(?:[-*]\s*)?(\d+)[.):]\s*(?:[^:]*\?\s*[:—-]\s*)?(.+)$/);
    if (!m) continue;
    const question = questions[Number(m[1]) - 1];
    if (!question || picks.some((p) => p.id === question.id)) continue;
    picks.push({ id: question.id, reason: m[2].trim().slice(0, 300) });
    if (picks.length === QUESTIONS_TO_PICK) break;
  }
  return {
    summary: summaryLine ? summaryLine.replace(/^summary\s*:\s*/i, '').slice(0, 300) : '',
    picks,
  };
}

export async function questionNotes(id, given = null) {
  const scope = given || await scopeOf(id);
  const [order] = await sql()`select case_id, client_account_id from orders where id = ${id}`;
  const caseId = order?.case_id ?? null;
  const calls = (await sql()`
    select c.kind, c.transcript_encrypted, c.fields_encrypted, c.chapter_id
      from calls c join orders o on o.id = c.order_id
     where c.transcript_encrypted is not null
       and (o.id = ${id} or (${caseId}::bigint is not null and o.case_id = ${caseId}))
     order by c.started_at desc
  `).filter((call) => scope.holds(call.chapter_id));
  const [decided] = scope.later ? [{ decision: scope.decision }] : await sql()`
    select decision from orders
     where decision is not null
       and (id = ${id} or (${caseId}::bigint is not null and case_id = ${caseId}))
     order by id desc limit 1
  `;
  const notes = [...scope.lead, `Decision: ${decided?.decision || 'not decided yet'}`];
  if (scope.fields) {
    notes.push('', 'Lines saved from the brief:',
      ...CALL_FIELDS.map(([key, label]) => `${label}: ${scope.fields[key] || 'not said'}`));
  }
  calls.forEach((call, i) => {
    const fields = readFields(call.fields_encrypted);
    notes.push('', `Call ${calls.length - i} (${call.kind}):`);
    if (fields) notes.push(...CALL_FIELDS.map(([key, label]) => `${label}: ${fields[key] || 'not said'}`));
    notes.push('Transcript:', decrypt(call.transcript_encrypted).slice(0, TRANSCRIPT_CHARS));
  });
  const thread = order?.client_account_id
    ? await sql()`
        select author, body_encrypted from messages
         where account_id = ${order.client_account_id}
           and created_at >= ${scope.startedAt ? new Date(scope.startedAt).toISOString() : '-infinity'}::timestamptz
         order by created_at desc limit 6
      `
    : [];
  const said = thread.reverse().map((m) =>
    `${m.author === 'client' ? 'Them' : 'You'}: ${decrypt(m.body_encrypted)}`);
  return { calls: calls.length + (scope.later && scope.brief ? 1 : 0), notes, said };
}

export async function draftQuestions(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const { stage, caseId, tradeId } = await stageOf(id);
  if (!stage) throw new HttpError(409, 'A no-go, so there is nothing to ask.');
  const all = await questionsFor(stage, caseId, tradeId);
  const questions = all.filter((q) => q.fit !== 'other' && fits(q, stage) && !q.passedAt);
  const passed = all.filter((q) => q.passedAt);
  if (!questions.length) {
    throw new HttpError(409, 'The question lists are empty. Add a question on Question lists first.');
  }
  const { calls, notes, said } = await questionNotes(id, await scopeOf(id, { withSummary: body.withSummary === true }));
  if (!calls) throw new HttpError(409, 'No call has come back for this person, so there is nothing to read.');

  const asked = [
    { role: 'system', content: await prompt('questions', { picks: QUESTIONS_TO_PICK }) },
    { role: 'user', content: [
      'Notes:', ...notes,
      '', 'Conversation:', ...(said.length ? said : ['nothing said yet']),
      '', 'Questions:', ...questions.map((q, i) => `${i + 1}. [${[q.scope || 'Everyone', q.topic].filter(Boolean).join(' · ')}] `
        + `${q.body}${q.askedAt ? ' (asked)' : ''}`),
      '', 'Set aside, never pick these:', ...(passed.length
        ? passed.map((q) => `${q.body}${q.passReason ? ` · ${q.passReason}` : ''}`) : ['none']),
    ].join('\n') },
  ];
  send(res, 202, await askAndRecord(id, asked, 'questions',
    { ids: questions.map((q) => q.id) }));
}

export async function finishQuestions(answer, context, done) {
  const picked = readPicks(answer.content, (context.ids || []).map((id) => ({ id })));
  await record(Number(done.order_id), 'questions.suggested',
    `${picked.picks.length} picked${picked.summary ? `: ${picked.summary}` : '.'}`);
  return { ...answer, ...picked };
}
