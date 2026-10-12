import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, query, readJson, send } from './http.js';
import { SLOTS, settingsFor } from './draft.js';
import { sweepQuietly } from './draft-jobs.js';
import { familiesNow } from './desk-drafts.js';

export const PRESSES_PER_PAGE = 20;
const HEALTH_MS = 8000;

const KINDS = {
  reply: 'Draft a reply',
  recap: 'Catch me up',
  summary: 'Chapter summary',
  questions: 'Pick what to ask',
  matches: 'Find matches',
  roadmap: 'Redraw the roadmap',
  'fields:brief': 'Call lines from the brief',
};

export function kindLabel(kind) {
  if (!kind) return 'Next steps';
  if (KINDS[kind]) return KINDS[kind];
  if (kind.startsWith('fields:')) return 'Call lines from a call';
  if (kind.startsWith('gaps')) return 'Find the gaps';
  return kind;
}

export const CHECKS = [
  { button: 'Draft from the call', action: 'draft', on: 'DEMO4-EEEEE', body: {} },
  { button: 'Fill from the call', action: 'call-fields-draft', on: 'DEMO4-EEEEE', body: {}, call: true },
  { button: 'Find the gaps', action: 'call-gaps', on: 'DEMO4-EEEEE', body: {}, call: true },
  { button: 'Pick what to ask next', action: 'questions-draft', on: 'DEMO4-EEEEE', body: {} },
  { button: 'Find matches', action: 'find-matches', on: 'DEMO4-EEEEE', body: {} },
  { button: 'Redraw the roadmap', action: 'roadmap-draft', on: 'DEMO4-EEEEE', body: {} },
  { button: 'Draft a reply', action: 'draft', on: 'DEMO8-JJJJJ', body: { of: 'reply' } },
  { button: 'Catch me up', action: 'draft', on: 'DEMO8-JJJJJ', body: { of: 'recap' } },
  { button: 'Write the summary', action: 'draft', on: 'DEMOP-PPPPP', body: { of: 'summary', number: 1 } },
  { button: 'Fill call lines from it', action: 'call-fields-draft', on: 'DEMOP-PPPPP', body: { brief: true } },
];

async function health(slot) {
  const model = settingsFor(slot);
  const out = { slot, name: model.name, set: Boolean(model.url && model.key) };
  if (!out.set) return out;
  try {
    const response = await fetch(`${model.url}/health`, {
      headers: { authorization: `Bearer ${model.key}` },
      signal: AbortSignal.timeout(HEALTH_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      out.said = `RunPod answered ${response.status} to the health check: ${text.slice(0, 200) || 'no reason given'}.`;
      return out;
    }
    const data = JSON.parse(text);
    out.workers = data.workers || {};
    out.jobs = data.jobs || {};
  } catch (error) {
    out.said = `The health check didn't come back within ${HEALTH_MS / 1000} seconds or wasn't readable: ${error.message}.`;
  }
  return out;
}

async function targets() {
  const refs = [...new Set(CHECKS.map((c) => c.on))];
  const rows = await sql()`
    select distinct on (o.reference_code) o.id, o.reference_code,
           (select c.id from calls c where c.order_id = o.id and c.transcript_encrypted is not null
             order by c.id desc limit 1) as call_id
      from orders o
     where o.is_demo and o.reference_code = any(${refs})
     order by o.reference_code, o.id desc
  `;
  const byRef = new Map(rows.map((r) => [r.reference_code, r]));
  return CHECKS.map((check) => {
    const row = byRef.get(check.on);
    if (!row) return { button: check.button, action: check.action, on: check.on, missing: `No ${check.on} in the demo data.` };
    if (check.call && !row.call_id) {
      return { button: check.button, action: check.action, on: check.on, missing: `${check.on} has no call with a transcript.` };
    }
    const body = { ...check.body, id: Number(row.id), ...(check.call ? { call: Number(row.call_id) } : {}) };
    return { button: check.button, action: check.action, on: check.on, body };
  });
}

function outcome(r) {
  if (r.gave_up_at || r.failure) return { state: 'Failed', said: r.failure || '' };
  if (r.finished_at) return { state: 'Finished', said: '' };
  return { state: 'Running', said: '' };
}

export async function aiCheck(req, res) {
  requireAdmin(req);
  await ensureSchema();
  sweepQuietly();
  const asked = Number.parseInt(query(req).get('page'), 10);
  const [{ n }] = await sql()`select count(*)::int as n from drafts`;
  const last = Math.max(1, Math.ceil(n / PRESSES_PER_PAGE));
  const page = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), last) : 1;
  const rows = await sql()`
    select d.id, d.kind, d.slot, d.model, d.seconds, d.created_at, d.finished_at, d.gave_up_at,
           d.failure, o.id as order_id, o.reference_code, o.is_demo
      from drafts d join orders o on o.id = d.order_id
     order by d.created_at desc, d.id desc
     limit ${PRESSES_PER_PAGE} offset ${(page - 1) * PRESSES_PER_PAGE}
  `;
  const [run] = await sql()`select max(run_at) as at from ai_checks`;
  const ran = run?.at ? await sql()`
    select a.button, a.ok, a.seconds, a.said_encrypted, a.created_at, o.reference_code
      from ai_checks a left join orders o on o.id = a.order_id
     where a.run_at = ${run.at} order by a.id
  ` : [];
  send(res, 200, {
    slots: await Promise.all(SLOTS.map(health)),
    buttons: await familiesNow(),
    checks: await targets(),
    run: run?.at ? {
      at: run.at,
      results: ran.map((r) => ({
        button: r.button, ok: r.ok, seconds: r.seconds, reference: r.reference_code,
        said: r.said_encrypted ? decrypt(r.said_encrypted) : '', at: r.created_at,
      })),
    } : null,
    presses: rows.map((r) => ({
      id: Number(r.id),
      button: kindLabel(r.kind),
      orderId: Number(r.order_id),
      reference: r.reference_code,
      isDemo: r.is_demo,
      slot: r.slot,
      model: r.model,
      seconds: r.seconds,
      at: r.created_at,
      ...outcome(r),
    })),
    page,
    last,
  });
}

export async function aiCheckSave(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const at = new Date(body.run);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'A check result needs the time its run started.');
  const button = String(body.button || '').trim().slice(0, 80);
  if (!CHECKS.some((c) => c.button === button)) throw new HttpError(400, `${button || 'That'} isn't one of the buttons a check runs.`);
  const order = Number(body.orderId);
  const id = Number.isInteger(order) && order > 0 ? order : null;
  if (id) {
    const [demo] = await sql()`select is_demo from orders where id = ${id}`;
    if (!demo?.is_demo) throw new HttpError(400, 'A check runs only against demo data, and that order isn\'t demo.');
  }
  const said = String(body.said || '').slice(0, 2000);
  const seconds = Number.isFinite(Number(body.seconds)) ? Math.round(Number(body.seconds)) : null;
  await sql()`
    insert into ai_checks (run_at, button, order_id, ok, seconds, said_encrypted)
    values (${at.toISOString()}, ${button}, ${id}, ${body.ok === true}, ${seconds}, ${said ? encrypt(said) : null})
  `;
  send(res, 201, { ok: true });
}
