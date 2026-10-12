import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { HttpError, query, send } from './http.js';
import { suggestFor, tradeList } from './trades.js';
import { rolesFor, skillsOf } from './skills.js';
import { directoryReadConfigured } from './desk-directory.js';
import { readFields } from './desk-callfields.js';
import { decrypt } from './crypto.js';
import { readChoice } from './settings.js';
import { models, SLOTS } from './draft.js';
import { MODEL_CHOICE } from './desk-drafts.js';
import { jobsFor, sweepQuietly } from './draft-jobs.js';
import { sheetAids } from './prompts.js';
import { orderId, readDetail } from './desk-events.js';
import {
  CADENCES,
  CADENCES_OFFERED,
  EVENT_BY,
  EVENT_GROUPS,
  EVENT_KINDS,
  PLAN_PATHS,
  conversationIsOpen,
  pageOf,
  quoteIsWaitingOnYou,
} from './desk.js';

import { breakEvenForOrder } from './costs.js';
import { questionsFor } from './desk-questions.js';
import { gapsFor } from './desk-gaps.js';
import { stageFor } from './questions.js';
import { standingOf } from './session-decision.js';
import { chaptersFor } from './desk-chapters.js';
import { broughtByFor } from './referrals.js';
import { readsFor } from './chapter-scope.js';
import { stepsForRecord } from './chapter-steps.js';
import { roadmapFor } from './desk-roadmap.js';

export async function person(req, res) {
  requireAdmin(req);
  await ensureSchema();
  sweepQuietly();
  const id = orderId(query(req).get('id'));

  const rows = await sql()`
    select o.id, o.reference_code, o.status, o.decision, o.decision_at, o.case_id, o.is_demo, o.is_mine, o.recommendation_done_at,
           o.trade_id,
           o.client_account_id, o.approved_as_client_at,
           k.first_customer_at, k.name_encrypted,
           o.recommendations_encrypted, o.recommendations_written_at
      from orders o
      left join cases k on k.id = o.case_id
     where o.id = ${id}
  `;
  if (!rows.length) throw new HttpError(404, 'No order with that number.');
  const row = rows[0];
  const caseId = row.case_id === null || row.case_id === undefined ? null : Number(row.case_id);

  const orders = caseId
    ? await sql()`
        select o.id, o.reference_code, o.status, o.decision, o.decision_at,
               o.recommendations_written_at,
               (select c.ended_at from calls c
                 where c.order_id = o.id and c.transcript_encrypted is not null
                 order by c.ended_at desc nulls last limit 1) as called_at
          from orders o where o.case_id = ${caseId} order by o.id desc
      `
    : [];

  if (caseId) {
    await sql()`update cases set messages_read_at = now() where id = ${caseId}`;
  }

  const standing = standingOf(orders.length ? orders.map((o) => ({ ...o, called: Boolean(o.called_at) }))
    : [{ id, decision: row.decision, decision_at: row.decision_at, called: true }], id);

  const account = row.client_account_id || null;
  const [{ count: messageCount }] = await sql()`
    select count(*)::int as count from messages
     where account_id = ${account}
        or (${account}::text is null and account_id is null and order_id = ${row.id})
  `;
  const messagePage = pageOf(
    new URL(req.url, 'https://placeholder.invalid').searchParams.get('mpage'),
    messageCount,
  );
  const messages = await sql()`
    select id, author, body_encrypted, created_at, from_template from messages
     where account_id = ${account}
        or (${account}::text is null and account_id is null and order_id = ${row.id})
     order by created_at asc
     limit ${messagePage.perPage} offset ${(messagePage.page - 1) * messagePage.perPage}
  `;

  const allCalls = await sql()`
    select c.id, c.order_id, o.reference_code, c.call_id, c.kind, c.transcript_encrypted,
           c.summary_encrypted, c.started_at, c.ended_at, c.seconds,
           c.record_encrypted is not null as record_kept, c.fields_encrypted, c.chapter_id
      from calls c join orders o on o.id = c.order_id
     where c.order_id = ${id} or (${caseId}::bigint is not null and o.case_id = ${caseId})
     order by c.started_at desc
  `;
  const calls = allCalls.filter((c) => Number(c.order_id) === id);

  const intros = await sql()`
    select i.id, i.a_order_id, i.b_order_id, i.to_link_encrypted, i.reason_encrypted, i.outcome,
           i.outcome_encrypted, i.made_at,
           a.reference_code as a_reference, b.reference_code as b_reference,
           ak.name_encrypted as a_name, bk.name_encrypted as b_name
      from introductions i
      join orders a on a.id = i.a_order_id
      left join orders b on b.id = i.b_order_id
      left join cases ak on ak.id = a.case_id
      left join cases bk on bk.id = b.case_id
     where i.a_order_id = ${id} or i.b_order_id = ${id}
        or (${caseId}::bigint is not null and (i.a_case_id = ${caseId} or i.b_case_id = ${caseId}))
     order by i.made_at desc limit 100
  `;

  const [caseRow] = caseId
    ? await sql()`select blocked_at, blocked_until, blocker_encrypted, closed_at
                    from cases where id = ${caseId}`
    : [];

  const quotes = row.client_account_id
    ? await sql()`
        select id, amount_cents, scope_encrypted, status, created_at, updated_at,
               answered_at, reason_encrypted, due_at, paid_cents, paid_at, discount_encrypted,
               agreed_terms
          from quotes where account_id = ${row.client_account_id}
         order by created_at desc limit 50
      `
    : [];
  const [plans, events] = caseId
    ? await Promise.all([
        sql()`select id, path, in_force, created_at from plans where case_id = ${caseId} order by created_at desc`,
        sql()`select kind, detail_encrypted, created_at, chapter_id from case_events
               where case_id = ${caseId} order by created_at desc limit 100`,
      ])
    : await Promise.all([
        sql()`select id, path, in_force, created_at from plans where order_id = ${id} order by created_at desc`,
        sql()`select kind, detail_encrypted, created_at, chapter_id from case_events
               where order_id = ${id} order by created_at desc limit 100`,
      ]);
  const inForce = plans.find((p) => p.in_force) || null;
  const stage = stageFor({
    decision: standing.decision,
    openQuote: quotes.some((q) => q.status === 'offered'),
    firstCustomerAt: row.first_customer_at,
    path: inForce?.path,
  });
  const steps = inForce
    ? await sql()`
        select id, position, title_encrypted, status, outcome_encrypted, created_at, updated_at, shown_at
          from milestones where plan_id = ${inForce.id} order by position asc
      `
    : [];

  const contacts = caseId
    ? await sql()`
        select id, name_encrypted, where_encrypted, why_encrypted, status, created_at, updated_at,
               directory_profile_encrypted is not null as from_directory, chapter_id
          from contacts where case_id = ${caseId} order by created_at asc
      `
    : [];
  const reaches = contacts.length
    ? await sql()`
        select o.id, o.contact_id, o.at, o.said_encrypted, o.back_encrypted, o.channel_encrypted
          from outreach o join contacts c on c.id = o.contact_id
         where c.case_id = ${caseId}
         order by o.at desc
      `
    : [];

  const projects = caseId
    ? await sql()`
        select id, quote_id, title_encrypted, state, due_at, delivered_at, note_encrypted,
               created_at, updated_at
          from projects where case_id = ${caseId} order by created_at asc
      `
    : [];

  const actions = inForce
    ? await sql()`
        select a.id, a.milestone_id, a.position, a.title_encrypted, a.status, a.cadence,
               a.next_at, a.outcome_encrypted, a.closed_at, a.updated_at, a.asked_at, a.shown_at
          from action_items a join milestones m on m.id = a.milestone_id
         where m.plan_id = ${inForce.id}
         order by a.position asc
      `
    : [];

  function readSummary(value) {
    if (!value) return null;
    try {
      return JSON.parse(decrypt(value));
    } catch {
      return null;
    }
  }

  const [{ approved_at: approvedAt = null } = {}] = row.client_account_id
    ? await sql()`
        select min(approved_as_client_at) as approved_at from orders
         where client_account_id = ${row.client_account_id}
      `
    : [{ approved_at: row.approved_as_client_at }];
  const tradeInfo = await tradeFacts(row);
  const chapterSteps = await stepsForRecord(caseId);

  send(res, 200, {
    id: row.id,
    reference: row.reference_code,
    name: row.name_encrypted ? decrypt(row.name_encrypted) : null,
    status: row.status,
    calls: allCalls.map((c) => ({
      id: c.id,
      orderId: Number(c.order_id),
      reference: c.reference_code,
      callId: c.call_id,
      kind: c.kind,
      transcript: c.transcript_encrypted ? decrypt(c.transcript_encrypted) : null,
      summary: readSummary(c.summary_encrypted),
      fields: readFields(c.fields_encrypted),
      startedAt: c.started_at,
      endedAt: c.ended_at,
      seconds: c.seconds,
      chapterId: c.chapter_id,
    })),
    calledAt: calls.find((c) => c.transcript_encrypted)?.started_at || null,
    recordMissing: calls.some((c) => c.transcript_encrypted && !c.record_kept),
    decision: standing.decision,
    decidedAt: standing.at,
    decisionInherited: standing.inherited,
    followUp: standing.followUp,
    earlierNoGoAt: standing.earlierNoGoAt,
    questionStage: stage,
    questions: await questionsFor(stage, caseId, row.trade_id),
    linkedCase: Boolean(caseId),
    isDemo: Boolean(row.is_demo),
    isMine: Boolean(row.is_mine),
    orders: orders.map((o) => ({
      id: Number(o.id),
      reference: o.reference_code,
      decision: o.decision,
      calledAt: o.called_at,
      recommendedAt: o.recommendations_written_at,
      thisOne: Number(o.id) === id,
    })),
    linked: Boolean(row.client_account_id),
    approvedAt,
    quoteWaiting: quotes.some((q) => quoteIsWaitingOnYou(q.status)),
    blocker: caseRow?.blocker_encrypted ? decrypt(caseRow.blocker_encrypted) : null,
    blockedAt: caseRow?.blocked_at || null,
    blockedUntil: caseRow?.blocked_until || null,
    closedAt: caseRow?.closed_at || null,
    breakEven: await breakEvenForOrder(id),
    conversationOpen: conversationIsOpen({
      approvedAt,
      quoteCount: quotes.length,
    }),
    recommendations: chapterSteps ? chapterSteps.text
      : row.recommendations_encrypted ? decrypt(row.recommendations_encrypted) : null,
    messages: messages.map((m) => ({
      id: m.id,
      author: m.author,
      body: decrypt(m.body_encrypted),
      at: m.created_at,
      fromTemplate: Boolean(m.from_template),
    })),
    awaitingReply: messages.length > 0
      && (await sql()`
           select author from messages
            where account_id = ${row.client_account_id}
            order by created_at desc limit 1
         `)[0]?.author === 'client',
    messagePage: messagePage.page,
    messagesPerPage: messagePage.perPage,
    messageCount,
    recommendedAt: chapterSteps ? chapterSteps.at : row.recommendations_written_at,
    firstCustomerAt: row.first_customer_at,
    recommendationDoneAt: row.recommendation_done_at,
    roadmap: inForce ? await roadmapFor(id) : null,
    plan: inForce
      ? { id: inForce.id, path: inForce.path, label: PLAN_PATHS[inForce.path]?.label || inForce.path, setAt: inForce.created_at }
      : null,
    milestones: steps.map((m) => ({
      id: m.id,
      position: m.position,
      title: decrypt(m.title_encrypted),
      status: m.status,
      outcome: m.outcome_encrypted ? decrypt(m.outcome_encrypted) : null,
      startedAt: m.created_at,
      updatedAt: m.updated_at,
      shownAt: m.shown_at,
      actions: actions
        .filter((a) => String(a.milestone_id) === String(m.id))
        .map((a) => ({
          id: Number(a.id),
          position: a.position,
          title: decrypt(a.title_encrypted),
          status: a.status,
          cadence: a.cadence,
          cadenceLabel: CADENCES[a.cadence]?.label || a.cadence,
          nextAt: a.next_at,
          due: a.status === 'open' && a.next_at !== null
            && new Date(a.next_at).getTime() <= Date.now(),
          outcome: a.outcome_encrypted ? decrypt(a.outcome_encrypted) : null,
          closedAt: a.closed_at,
          askedAt: a.asked_at,
          shownAt: a.shown_at,
          updatedAt: a.updated_at,
        })),
    })),
    projects: projects.map((w) => ({
      id: Number(w.id),
      quoteId: w.quote_id === null || w.quote_id === undefined ? null : Number(w.quote_id),
      title: decrypt(w.title_encrypted),
      state: w.state,
      dueAt: w.due_at,
      deliveredAt: w.delivered_at,
      note: w.note_encrypted ? decrypt(w.note_encrypted) : null,
      late: w.delivered_at === null && w.state !== 'dropped' && w.due_at !== null
        && new Date(w.due_at).getTime() <= Date.now(),
      takenAt: w.created_at,
      movedAt: w.updated_at,
    })),
    directoryRead: directoryReadConfigured(),
    contacts: contacts.map((c) => ({
      id: Number(c.id),
      name: decrypt(c.name_encrypted),
      where: c.where_encrypted ? decrypt(c.where_encrypted) : null,
      why: c.why_encrypted ? decrypt(c.why_encrypted) : null,
      fromDirectory: c.from_directory,
      status: c.status,
      chapterId: c.chapter_id,
      addedAt: c.created_at,
      movedAt: c.updated_at,
      reaches: reaches
        .filter((r) => String(r.contact_id) === String(c.id))
        .map((r) => ({
          id: Number(r.id),
          at: r.at,
          channel: r.channel_encrypted ? decrypt(r.channel_encrypted) : null,
          said: r.said_encrypted ? decrypt(r.said_encrypted) : null,
          back: r.back_encrypted ? decrypt(r.back_encrypted) : null,
        })),
    })),
    quotes: quotes.map((q) => ({
      id: q.id,
      amount: q.amount_cents / 100,
      scope: decrypt(q.scope_encrypted),
      status: q.status,
      writtenAt: q.created_at,
      movedAt: q.updated_at,
      answeredAt: q.answered_at,
      dueAt: q.due_at,
      paid: q.paid_cents === null || q.paid_cents === undefined ? null : q.paid_cents / 100,
      paidAt: q.paid_at,
      discount: q.discount_encrypted ? decrypt(q.discount_encrypted) : null,
      late: q.status === 'agreed' && q.paid_at === null && q.due_at !== null
        && new Date(q.due_at).getTime() <= Date.now(),
      untracked: q.paid_at !== null
        && !projects.some((w) => String(w.quote_id) === String(q.id)),
      reason: q.reason_encrypted ? decrypt(q.reason_encrypted) : null,
      agreedTerms: q.agreed_terms,
    })),
    introductions: intros.map((i) => {
      const sealed = (value) => (value ? decrypt(value) : null);
      const them = i.b_order_id === null
        ? null
        : Number(i.a_order_id) === Number(id)
          ? { id: i.b_order_id, reference: i.b_reference, name: sealed(i.b_name) }
          : { id: i.a_order_id, reference: i.a_reference, name: sealed(i.a_name) };
      return {
        id: i.id,
        them,
        link: i.to_link_encrypted ? decrypt(i.to_link_encrypted) : null,
        reason: i.reason_encrypted ? decrypt(i.reason_encrypted) : null,
        outcome: i.outcome,
        note: i.outcome_encrypted ? decrypt(i.outcome_encrypted) : null,
        madeAt: i.made_at,
      };
    }),
    events: events.map((e) => ({
      kind: e.kind,
      label: EVENT_KINDS[e.kind] || e.kind,
      group: EVENT_GROUPS[e.kind]?.[0] || 'edit',
      by: EVENT_BY[EVENT_GROUPS[e.kind]?.[1] || 'you'],
      detail: readDetail(e),
      at: e.created_at,
      chapterId: e.chapter_id,
    })),
    chapters: await chaptersFor(caseId),
    aiReads: await readsFor(id, row.client_account_id),
    broughtBy: await broughtByFor(id,
      new URL(req.url, 'https://placeholder.invalid').searchParams.get('bpage')),
    sheet: await sheetAids(),
    drafting: {
      models: models(), slots: SLOTS, chosen: await readChoice(MODEL_CHOICE), jobs: await jobsFor(id, caseId),
    },
    recaps: (await sql()`
      select d.model, d.seconds, r.content_encrypted, r.created_at
        from recaps r join drafts d on d.id = r.draft_id join orders o on o.id = r.order_id
       where r.order_id = ${id} or (${caseId}::bigint is not null and o.case_id = ${caseId})
       order by r.created_at desc
    `).map((r) => {
      const content = decrypt(r.content_encrypted);
      return { at: r.created_at, model: r.model, seconds: r.seconds, content, summary: firstSentence(content) };
    }),
    gaps: await gapsFor(id, caseId),
    cadenceChoices: CADENCES_OFFERED.map((value) => ({ value, label: CADENCES[value].label })),
    trade: tradeInfo.trade,
    trades: tradeInfo.trades,
    skills: tradeInfo.skills,
    roles: tradeInfo.roles,
    couldWorkWith: tradeInfo.couldWorkWith,
    hasCase: tradeInfo.hasCase,
    ownProfileLinked: tradeInfo.ownProfileLinked,
  });
}

export function firstSentence(text, max = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end === -1 ? flat : flat.slice(0, end + 1);
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[,;:\s]+$/, '')}…`;
}

async function tradeFacts(row) {
  const trades = await tradeList();
  const mine = trades.find((t) => t.id === row.trade_id) || null;
  const found = await suggestFor(row.id);
  const shape = (r) => ({
    id: Number(r.id), reference: r.reference_code, title: r.title, isDemo: Boolean(r.is_demo),
    name: r.name_encrypted ? decrypt(r.name_encrypted) : null,
  });
  const own = row.case_id ? await sql()`
    select directory_profile_encrypted is not null as linked from cases where id = ${row.case_id}
  ` : [];
  const skills = await skillsOf(row.id);
  return {
    skills,
    roles: await rolesFor(skills.map((s) => s.id)),
    hasCase: Boolean(row.case_id),
    ownProfileLinked: Boolean(own[0]?.linked),
    trade: mine,
    trades,
    couldWorkWith: { sameTrade: found.same.map(shape), sameSector: found.sector.map(shape) },
  };
}
