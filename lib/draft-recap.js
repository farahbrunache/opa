import { sql } from './db.js';
import { decrypt } from './crypto.js';
import { CADENCES, DROP_REASONS, PLAN_PATHS } from './desk.js';
import { standingFor } from './session-decision.js';
import { scopeOf } from './chapter-scope.js';

function on(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function daysSince(value) {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

export async function recapFacts(id, given = null) {
  const scope = given || await scopeOf(id);
  const [order] = await sql()`
    select o.id, o.case_id, o.recommendations_encrypted,
           o.recommendations_written_at, k.first_customer_at, k.blocker_encrypted,
           k.blocked_until, k.closed_at, o.client_account_id
      from orders o left join cases k on k.id = o.case_id
     where o.id = ${id}
  `;
  if (!order) return null;
  const caseId = order.case_id === null || order.case_id === undefined
    ? null
    : Number(order.case_id);

  const lines = [...scope.lead];
  const say = (line) => lines.push(line);

  const standing = scope.later
    ? { decision: scope.decision, at: null }
    : await standingFor(id);
  if (scope.later) {
    say(scope.decision ? `Decision on this chapter: ${scope.decision}.` : 'No decision on this chapter yet.');
  } else if (standing.decision) {
    say(`Decision: ${standing.decision}, recorded ${on(standing.at)}.`);
  } else {
    say('No decision has been recorded yet.');
  }
  if (order.recommendations_encrypted && scope.since(order.recommendations_written_at)) {
    say(`Their next steps were written ${on(order.recommendations_written_at)} and say:`);
    say(decrypt(order.recommendations_encrypted));
  }
  if (order.first_customer_at) say(`First paying customer: ${on(order.first_customer_at)}.`);
  if (order.blocker_encrypted) {
    say(`Blocked, waiting on somebody else: ${decrypt(order.blocker_encrypted)}`
      + (order.blocked_until ? ` Until ${on(order.blocked_until)}.` : ''));
  }
  if (order.closed_at) say(`This case was closed ${on(order.closed_at)}.`);

  if (caseId === null) {
    return { lines, caseId: null };
  }

  const [plan] = await sql()`
    select id, path, created_at, chapter_id from plans
     where case_id = ${caseId} and in_force order by created_at desc limit 1
  `;
  if (plan && !scope.holds(plan.chapter_id)) plan.id = null;
  if (plan?.id) {
    say(`Plan in force since ${on(plan.created_at)}: `
      + `${PLAN_PATHS[plan.path]?.label || plan.path}.`);
  } else {
    say('No plan is in force.');
  }

  const activities = (await sql()`
    select title_encrypted, state, cadence, next_at, outcome_encrypted, drop_reason, chapter_id
      from activities where case_id = ${caseId} order by position asc, id asc
  `).filter((a) => scope.holds(a.chapter_id));
  for (const a of activities) {
    const due = a.state === 'todo' && a.next_at && new Date(a.next_at) <= new Date();
    say(`Activity, ${a.state === 'todo' ? 'to do, on their page' : a.state}: ${decrypt(a.title_encrypted)}`
      + (a.state === 'todo' && a.cadence && a.cadence !== 'none'
        ? ` (${CADENCES[a.cadence]?.label || a.cadence}`
          + `${a.next_at ? `, next ${on(a.next_at)}` : ''}${due ? ', due now' : ''})`
        : '')
      + (a.drop_reason ? ` — why: ${DROP_REASONS[a.drop_reason] || a.drop_reason}` : '')
      + (a.outcome_encrypted ? ` — what happened: ${decrypt(a.outcome_encrypted)}` : ''));
  }

  const contacts = (await sql()`
    select id, name_encrypted, where_encrypted, status, chapter_id from contacts
     where case_id = ${caseId} order by created_at asc
  `).filter((contact) => scope.holds(contact.chapter_id));
  const reaches = contacts.length
    ? await sql()`
        select o.contact_id, o.at, o.said_encrypted, o.back_encrypted from outreach o
          join contacts c on c.id = o.contact_id
         where c.case_id = ${caseId} order by o.at asc
      `
    : [];
  for (const contact of contacts) {
    say(`Approaching ${decrypt(contact.name_encrypted)} at `
      + `${decrypt(contact.where_encrypted)} — `
      + `${contact.status}.`);
    for (const reach of reaches.filter((r) => Number(r.contact_id) === Number(contact.id))) {
      say(`  ${on(reach.at)}: said ${decrypt(reach.said_encrypted)}`
        + (reach.back_encrypted ? ` — back: ${decrypt(reach.back_encrypted)}` : ' — nothing back'));
    }
  }

  const projects = (await sql()`
    select title_encrypted, state, due_at, delivered_at, note_encrypted, chapter_id from projects
     where case_id = ${caseId} order by created_at asc
  `).filter((project) => scope.holds(project.chapter_id));
  for (const project of projects) {
    const late = project.due_at && !project.delivered_at
      && new Date(project.due_at) < new Date();
    say(`Yours to do, ${project.state}: ${decrypt(project.title_encrypted)}`
      + (project.due_at ? ` — due ${on(project.due_at)}${late ? ', past due' : ''}` : '')
      + (project.delivered_at ? ` — done ${on(project.delivered_at)}` : '')
      + (project.note_encrypted ? ` — ${decrypt(project.note_encrypted)}` : ''));
  }

  const held = await sql()`
    select h.rate, h.used_at, a.title_encrypted from held_sessions h
      left join activities a on a.id = h.activity_id where h.case_id = ${caseId}
  `;
  if (held.length) {
    const used = held.filter((h) => h.used_at);
    say(`Sessions on their card: ${held.length}, ${used.length} used`
      + (used.length ? `: ${used.map((h) => `${h.title_encrypted ? decrypt(h.title_encrypted) : 'no activity named'} (${h.rate} rate)`).join('; ')}` : '')
      + '.');
  }

  if (order.client_account_id) {
    const since = scope.startedAt ? new Date(scope.startedAt).toISOString() : '-infinity';
    const thread = await sql()`
      select author, body_encrypted, created_at from messages
       where account_id = ${order.client_account_id} and created_at >= ${since}::timestamptz
       order by created_at desc limit 12
    `;
    if (thread.length) {
      const last = thread[0];
      const quiet = daysSince(last.created_at);
      say(`The conversation has ${thread.length === 12 ? 'at least 12' : thread.length} lines. `
        + `The last was ${quiet === 0 ? 'today' : `${quiet} day${quiet === 1 ? '' : 's'} ago`}, `
        + `from ${last.author === 'client' ? 'them' : 'you'}.`);
      for (const message of thread.reverse()) {
        say(`  ${on(message.created_at)} ${message.author === 'client' ? 'them' : 'you'}: `
          + decrypt(message.body_encrypted));
      }
    } else {
      say('Nothing has been written in the conversation.');
    }
  }

  return { lines, caseId };
}
