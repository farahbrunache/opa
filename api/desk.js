import { ensureSchema, sql } from '../lib/db.js';

import { decrypt, encrypt, keyedHash } from '../lib/crypto.js';
import { requireAdmin } from '../lib/auth.js';
import { AUTO_UPDATE_MAX, isDecision } from '../lib/desk.js';

import { OPENING_LINE } from '../lib/orders.js';

import { HttpError, handle, query, readJson, send } from '../lib/http.js';
import { caseOf, orderId, record } from '../lib/desk-events.js';

import { introduce, recordIntroduction } from '../lib/desk-introductions.js';
import { chooseModel, writeDraft } from '../lib/desk-drafts.js';
import { addModel, aiCheck, aiCheckSave, setSlot } from '../lib/desk-ai.js';
import { draftResult, markUsed } from '../lib/draft-jobs.js';
import { setPlan } from '../lib/desk-plan.js';
import {
  addActivity, dropActivity, moveToTodo, pushActivity, recordDone, reopenActivity, saveOutcome, setCadence,
} from '../lib/desk-activities.js';
import { endSession, useSession } from '../lib/desk-sessions.js';
import { addContact, moveContact, reachOut } from '../lib/desk-contacts.js';
import {
  addQuestion, deleteQuestion, importQuestions, draftQuestions, editQuestion, listQuestions, markAsked,
  passQuestion,
} from '../lib/desk-questions.js';
import { skipPair, unskipPair } from '../lib/desk-skips.js';
import { decideRoadmap, draftRoadmap } from '../lib/desk-roadmap.js';
import { findMatches } from '../lib/desk-matches.js';
import { directoryProfile } from '../lib/desk-directory.js';
import { moveWork, setWorkDue, takeOnWork } from '../lib/desk-work.js';
import { today } from '../lib/desk-today.js';
import { person } from '../lib/desk-person.js';
import { clientPreview } from '../lib/desk-preview.js';
import { linkOwnProfile, readOwnProfile } from '../lib/desk-own-profile.js';
import { copyTrades, pairs, setTrade } from '../lib/desk-trades.js';
import { listSkills, setSkills } from '../lib/desk-skills.js';
import { draftCallFields, saveCallFields } from '../lib/desk-callfields.js';
import { findGaps } from '../lib/desk-gaps.js';
import { STEPS, startClock, timeReport, timeStep } from '../lib/desk-time.js';
import { funnel } from '../lib/desk-funnel.js';
import { setPool } from '../lib/desk-approached.js';
import { queue } from '../lib/desk-queue.js';
import { demoClear, demoSeed, markMine } from '../lib/desk-demo.js';
import { block, close, recommendationDone, unblock } from '../lib/desk-state.js';
import { decideInChapter, editChapter, pivot } from '../lib/desk-chapters.js';
import { recommendInChapter, syncStepsFor } from '../lib/chapter-steps.js';
import { flag, referralTree, setBroughtBy, unflag } from '../lib/referrals.js';
import { agentScript, callRecord } from '../lib/desk-voice.js';
import { listPrompts, savePrompt } from '../lib/prompts.js';

function needsCase(caseId) {
  if (caseId) return caseId;
  throw new HttpError(
    409,
    'They have not signed in yet, so there is nobody to work with. This opens once they open '
      + 'their claim link while signed in to Skills Economy.',
  );
}

async function firstCustomer(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const reached = body.reached !== false;

  const confirmed = await sql()`select 1 from orders where id = ${id} and status = 'confirmed'`;
  if (!confirmed.length) throw new HttpError(404, 'No confirmed order with that number.');
  const caseId = needsCase(await caseOf(id));

  const done = await sql()`
    update cases
       set first_customer_at = case when ${reached} then coalesce(first_customer_at, now()) else null end
     where id = ${caseId}
     returning first_customer_at
  `;
  await record(id, 'first-customer', reached ? String(body.note || '').trim() : 'Taken back off.');
  send(res, 200, { ok: true, at: done[0].first_customer_at });
}

async function openTheConversation(id, justPosted = 0) {
  const rows = await sql()`
    select client_account_id from orders
     where id = ${id}
       and approved_as_client_at is not null
       and recommendations_encrypted is not null
       and client_account_id is not null
  `;
  if (!rows.length) return false;
  const account = rows[0].client_account_id;

  const [{ count }] = await sql()`
    select count(*)::int as count from messages where account_id = ${account}
  `;
  if (count > justPosted) return false;

  await sql()`
    insert into messages (account_id, author, body_encrypted)
    values (${account}, 'opening', ${encrypt(OPENING_LINE)})
  `;
  await record(id, 'conversation.opened', OPENING_LINE);
  return true;
}

async function postSteps(id) {
  const rows = await sql()`
    select o.client_account_id, o.recommendations_encrypted, o.steps_posted_hash from orders o
     where o.id = ${id} and o.client_account_id is not null
       and o.recommendations_encrypted is not null
       and (o.decision = 'go'
            or (o.decision is null and o.case_id is not null
                and (select p.decision from orders p
                      where p.case_id = o.case_id and p.id < o.id and p.decision is not null
                      order by p.id desc limit 1) = 'go'))
  `;
  if (!rows.length) return 0;
  const text = decrypt(rows[0].recommendations_encrypted);
  const hash = keyedHash(`steps:${text}`);
  if (rows[0].steps_posted_hash === hash) return 0;
  await sql()`
    insert into messages (account_id, author, body_encrypted)
    values (${rows[0].client_account_id}, 'operator', ${encrypt(text)})
  `;
  await sql()`update orders set steps_posted_hash = ${hash} where id = ${id}`;
  await record(id, 'steps.posted', 'Posted as a message from you.');
  return 1;
}

async function stepsOntoRoadmap(id) {
  await syncStepsFor(id);
}

async function decide(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const decision = String(body.decision || '');
  if (!isDecision(decision)) throw new HttpError(400, 'Unknown decision.');
  if (await decideInChapter(id, decision, body.note)) {
    send(res, 200, { ok: true, decision, opened: false });
    return;
  }

  const done = await sql()`
    update orders set
      decision = ${decision},
      decision_at = now(),
      approved_as_client_at = case
        when ${decision} = 'go' then coalesce(approved_as_client_at, now())
        else null
      end
     where id = ${id} and status = 'confirmed'
     returning id
  `;
  if (!done.length) {
    throw new HttpError(409, 'That order is not a confirmed one, so there is no call to decide on.');
  }
  await record(id, 'decided', `${decision}. ${String(body.note || '').trim()}`.trim());
  const opened = decision === 'go' ? await openTheConversation(id, await postSteps(id)) : false;
  if (decision === 'go') await stepsOntoRoadmap(id);
  send(res, 200, { ok: true, decision, opened });
}

async function recommend(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const text = String(body.body || '').trim().slice(0, 8000);
  if (!text) throw new HttpError(400, 'Empty next steps are not a recommendation.');
  if (await recommendInChapter(id, text)) {
    await markUsed(id, null);
    send(res, 201, { ok: true, opened: false });
    return;
  }

  const done = await sql()`
    update orders set
      recommendations_encrypted = ${encrypt(text)},
      recommendations_written_at = now()
     where id = ${id} and status = 'confirmed'
     returning id
  `;
  if (!done.length) {
    throw new HttpError(409, 'That order is not a confirmed one, so there is nobody to write to.');
  }
  await markUsed(id, null);
  await record(id, 'recommended', 'Written.');
  const opened = await openTheConversation(id, await postSteps(id));
  await stepsOntoRoadmap(id);
  send(res, 201, { ok: true, opened });
}

async function reply(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const auto = body.mode === 'auto';
  const fromTemplate = !auto && body.fromTemplate === true;
  const text = String(body.body || '').trim().slice(0, 4000);
  if (!text) throw new HttpError(400, 'An empty message is not a message.');
  if (auto && text.length > AUTO_UPDATE_MAX) {
    throw new HttpError(400, `An auto update is a line of status, up to ${AUTO_UPDATE_MAX} `
      + `characters, and this one is ${text.length}. Send it as a message from you instead.`);
  }

  const rows = await sql()`select client_account_id from orders where id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  const account = rows[0].client_account_id || null;

  await sql()`
    insert into messages (account_id, order_id, author, body_encrypted, from_template)
    values (${account}, ${account ? null : id}, ${auto ? 'auto' : 'operator'}, ${encrypt(text)}, ${fromTemplate})
  `;
  if (auto) await record(id, 'message.auto', text);
  else await markUsed(id, 'reply');
  if (auto || body.free === true) req.free = true;
  if (fromTemplate) await record(id, 'message.template', text);
  const asked = auto ? 0 : await markAsked(id, body.questions);
  send(res, 201, { ok: true, asked });
}

async function addNote(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const note = String(body.note || '').trim();
  if (!note) throw new HttpError(400, 'An empty note is not a note.');

  const exists = await sql()`select 1 from orders where id = ${id}`;
  if (!exists.length) throw new HttpError(404, 'No order with that number.');
  await record(id, 'note', note);
  send(res, 201, { ok: true });
}

const ACTIONS = {
  GET: {
    today, queue, person, funnel, 'call-record': callRecord, 'agent-script': agentScript,
    time: timeReport, pairs, 'directory-profile': directoryProfile,
    'own-profile': readOwnProfile,
    'skills-list': listSkills,
    questions: listQuestions,
    'client-preview': clientPreview,
    referrals: referralTree,
    'ai-check': aiCheck,
    'draft-result': draftResult,
    prompts: listPrompts,
  },
  POST: {
    decide,
    plan: setPlan,
    'activity-add': addActivity,
    'activity-done': recordDone,
    'activity-outcome': saveOutcome,
    'activity-reopen': reopenActivity,
    'activity-drop': dropActivity,
    'activity-move': moveToTodo,
    'activity-push': pushActivity,
    'activity-cadence': setCadence,
    'session-use': useSession,
    'session-close': endSession,
    'work-take': takeOnWork,
    'work-move': moveWork,
    'work-due': setWorkDue,
    'contact-add': addContact,
    'contact-reach': reachOut,
    'contact-move': moveContact,
    reply,
    recommend,
    draft: writeDraft,
    model: chooseModel,
    introduce,
    'introduction-record': recordIntroduction,
    'first-customer': firstCustomer,
    'recommendation-done': recommendationDone,
    note: addNote,
    trade: setTrade,
    skills: setSkills,
    'trades-copy': copyTrades,
    'own-profile': linkOwnProfile,
    'call-fields': saveCallFields,
    'call-fields-draft': draftCallFields,
    'call-gaps': findGaps,
    'ai-check-save': aiCheckSave,
    'slot-set': setSlot,
    'model-add': addModel,
    'question-add': addQuestion,
    'question-edit': editQuestion,
    'question-delete': deleteQuestion,
    'question-pass': passQuestion,
    'questions-import': importQuestions,
    'questions-draft': draftQuestions,
    'roadmap-draft': draftRoadmap,
    'roadmap-decide': decideRoadmap,
    skip: skipPair,
    unskip: unskipPair,
    'find-matches': findMatches,
    'funnel-pool': setPool,
    block,
    unblock,
    close,
    pivot,
    'chapter-edit': editChapter,
    'brought-by': setBroughtBy,
    flag,
    unflag,
    'mine': markMine,
    'demo-seed': demoSeed,
    'demo-clear': demoClear,
    prompt: savePrompt,
  },
};

export default handle(['GET', 'POST'], async (req, res) => {
  const action = query(req).get('action');
  const run = ACTIONS[req.method]?.[action];
  if (!run) throw new HttpError(400, `The desk has no ${req.method} action "${action || ''}".`);
  await run(req, res);

  const params = query(req);
  try {
    if (req.method === 'GET' && action === 'person') await startClock(params.get('id'));
    if (req.method === 'POST' && STEPS[action]) await timeStep(params.get('on'), action, req.free === true);
  } catch (error) {
    console.error('[one-percent] a step was not timed:', error.message);
  }
});
