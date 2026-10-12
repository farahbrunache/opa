import { sql } from './db.js';
import { encrypt, keyedHash } from './crypto.js';
import { profileSide } from './desk-skips.js';
import { seedClaimStates } from './demo-claim.js';
import { seedChapters, seedSessionPivot } from './demo-chapters.js';
import { seedReferrals } from './demo-referrals.js';
import { syncStepsFor } from './chapter-steps.js';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

function demoReference(n) {
  return `DEMO${String(n).padStart(1, '0')}-${'ABCDEFGHJK'[n % 10].repeat(5)}`.slice(0, 11);
}

const TRANSCRIPTS = {
  a: 'Agent: Sample line one.\nCaller: Sample reply one.\n'
    + 'Agent: Sample line two.\nCaller: Sample reply two.',
  b: 'Agent: Sample line three.\nCaller: Sample reply three.\n'
    + 'Agent: Sample line four.\nCaller: Sample reply four.',
  c: 'Agent: Sample line five.\nCaller: Sample reply five.\n'
    + 'Agent: Sample line six.\nCaller: Sample reply six.',
};

const WORKING_SHEET = [
  'Sample introduction line.',
  '',
  '1. Sample step A.',
  '',
  '2. Sample step B.',
  '',
  '3. Sample step C.',
  '',
  'Sample closing line.',
].join('\n');

const MATCHED_AFTER_HOURS = [3.6, 19, 5.7, 7.9, 13.3, 2.2];

async function makeOrder(n, { status = 'confirmed' } = {}) {
  const rows = await sql()`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_demo, created_at, decided_at)
    values (${keyedHash(`demo-claim-${n}-${Date.now()}`)},
            ${keyedHash(`demo-card-${n}-${Date.now()}`)},
            700, 'wise', ${demoReference(n)}, ${status}, true, ${hoursAgo(72)},
            ${status === 'pending' ? null : hoursAgo(72 - MATCHED_AFTER_HOURS[n % MATCHED_AFTER_HOURS.length])})
    returning id
  `;
  return Number(rows[0].id);
}

async function makeCall(orderId, words, endedHoursAgo,
  { kind = 'intake', seconds = 240, fields = null, summary = null } = {}) {
  await sql()`
    insert into calls (order_id, call_id, kind, seconds, transcript_encrypted, summary_encrypted,
                       started_at, ended_at, record_encrypted, record_taken_at, fields_encrypted)
    values (${orderId}, ${`demo-call-${orderId}`}, ${kind}, ${seconds}, ${encrypt(words)},
            ${summary ? encrypt(JSON.stringify({ call_summary: summary })) : null},
            ${hoursAgo(endedHoursAgo + 0.1)}, ${hoursAgo(endedHoursAgo)},
            ${encrypt(JSON.stringify({ demo: true, call_cost: { combined_cost: 58 } }))},
            ${hoursAgo(endedHoursAgo)},
            ${fields ? encrypt(JSON.stringify(fields)) : null})
  `;
}

const SAMPLE_FIELDS = {
  trade: 'Sample trade',
  rate: 'not said',
  inTheWay: 'Sample note.',
  firstCustomer: 'not said',
};

async function makeCase(orderId, account, name) {
  const rows = await sql()`
    insert into cases (account_id, is_demo, name_encrypted)
    values (${account}, true, ${encrypt(name)})
    on conflict (account_id) do update set account_id = excluded.account_id
    returning id
  `;
  const caseId = Number(rows[0].id);
  await sql()`update orders set client_account_id = ${account}, case_id = ${caseId}
               where id = ${orderId}`;
  return caseId;
}

async function say(account, author, body, hoursBack, fromTemplate = false) {
  await sql()`
    insert into messages (account_id, author, body_encrypted, created_at, from_template)
    values (${account}, ${author}, ${encrypt(body)}, ${hoursAgo(hoursBack)}, ${fromTemplate})
  `;
}

export async function seedDemo() {
  const made = [];
  const stamp = Date.now().toString(36).slice(-4);
  let n = 0;
  const next = () => (n += 1);

  const paidOnly = await makeOrder(next());
  made.push({ reference: demoReference(n), is: 'paid, never called' });

  const late = await makeOrder(next());
  await makeCall(late, TRANSCRIPTS.a, 31, { fields: SAMPLE_FIELDS });
  made.push({ reference: demoReference(n), is: 'called 31 hours ago, no decision' });

  const fresh = await makeOrder(next());
  await makeCall(fresh, TRANSCRIPTS.c, 3);
  made.push({ reference: demoReference(n), is: 'called 3 hours ago, no decision' });

  const working = await makeOrder(next());
  await makeCall(working, TRANSCRIPTS.a, 96, {
    summary: 'Sample summary one.',
  });
  const workingCase = await makeCase(working, `demo-acct-working-${stamp}`, 'Marisol Ketterby');
  await sql()`
    update orders set decision = 'go', decision_at = ${hoursAgo(90)},
                      approved_as_client_at = ${hoursAgo(90)},
                      recommendations_encrypted = ${encrypt(WORKING_SHEET)},
                      recommendations_written_at = ${hoursAgo(89)}
     where id = ${working}
  `;
  await sql()`
    insert into case_events (order_id, case_id, kind, detail_encrypted, created_at)
    values (${working}, ${workingCase}, 'step.done', ${encrypt('Sample step A. marked done by the client.')}, ${hoursAgo(84)}),
           (${working}, ${workingCase}, 'step.done', ${encrypt('Sample step B. marked done by the client.')}, ${hoursAgo(40)})
  `;
  const plan = await sql()`
    insert into plans (order_id, case_id, path, created_at)
    values (${working}, ${workingCase}, 'smallest', ${hoursAgo(88)})
    returning id
  `;
  const activity = async (position, title, state, extra = {}) => Number((await sql()`
    insert into activities (case_id, plan_id, position, title_encrypted, state, source, shown_at, cadence,
                            next_at, asked_at, outcome_encrypted, drop_reason, closed_at, created_at, updated_at)
    values (${workingCase}, ${plan[0].id}, ${position}, ${encrypt(title)}, ${state}, ${extra.source || 'you'},
            ${extra.shownAt ?? (state === 'drafted' ? null : hoursAgo(86))}, ${extra.cadence || 'none'},
            ${extra.nextAt || null}, ${extra.askedAt || null},
            ${extra.outcome ? encrypt(extra.outcome) : null}, ${extra.dropReason || null},
            ${extra.closedAt || null}, ${extra.createdAt || hoursAgo(86)}, ${extra.closedAt || hoursAgo(60)})
    returning id
  `)[0].id);
  await activity(1, 'Sample activity one', 'done', { outcome: 'Sample outcome.', closedAt: hoursAgo(70) });
  const second = await activity(2, 'Sample activity two', 'todo',
    { cadence: 'weekly', nextAt: hoursAgo(26), shownAt: hoursAgo(200), createdAt: hoursAgo(200) });
  await activity(3, 'Sample activity three', 'drafted', { createdAt: hoursAgo(60) });
  const fourth = await activity(4, 'Sample activity four', 'todo',
    { cadence: 'three-days', nextAt: hoursAgo(20 - 72), askedAt: hoursAgo(20), shownAt: hoursAgo(50), createdAt: hoursAgo(50) });
  await activity(5, 'Sample activity five', 'drafted', { source: 'redraw', createdAt: hoursAgo(10) });
  await activity(6, 'Sample activity six', 'dropped',
    { dropReason: 'not-needed', outcome: 'Sample reason.', closedAt: hoursAgo(44), shownAt: hoursAgo(80), createdAt: hoursAgo(80) });
  await activity(7, 'Sample activity seven', 'done', { closedAt: hoursAgo(30), shownAt: hoursAgo(66), createdAt: hoursAgo(66) });
  const people = await sql()`
    insert into contacts (case_id, name_encrypted, where_encrypted, why_encrypted, status, created_at)
    values (${workingCase}, ${encrypt('Bartholomew Quillfeather')}, ${encrypt('In person')},
            ${encrypt('Sample note one.')}, 'paying customer', ${hoursAgo(84)}),
           (${workingCase}, ${encrypt('Zebulon Quixtrade')}, ${encrypt('Signal')},
            ${encrypt('Sample note two.')}, 'talking', ${hoursAgo(80)}),
           (${workingCase}, ${encrypt('Sample place three')}, ${encrypt('Walk in')},
            ${encrypt('Sample note three.')}, 'to approach', ${hoursAgo(76)})
    returning id, status
  `;
  await sql()`
    insert into contacts (case_id, name_encrypted, why_encrypted, directory_profile_encrypted, created_at)
    values (${workingCase}, ${encrypt('')}, ${encrypt('Sample note four.')},
            ${encrypt('DEMO-directory-profile')}, ${hoursAgo(74)})
  `;
  const paid = people.find((row) => row.status === 'paying customer').id;
  const talking = people.find((row) => row.status === 'talking').id;
  await sql()`
    insert into outreach (contact_id, channel_encrypted, said_encrypted, back_encrypted, at)
    values (${paid}, ${encrypt('In person')}, ${encrypt('Sample message one.')},
            ${encrypt('Sample reply one.')}, ${hoursAgo(82)}),
           (${talking}, ${encrypt('Signal')}, ${encrypt('Sample message two.')},
            ${encrypt('Sample reply two.')}, ${hoursAgo(78)}),
           (${talking}, ${encrypt('Signal')}, ${encrypt('Sample message three.')}, null, ${hoursAgo(30)})
  `;
  await sql()`
    update cases set first_customer_at = ${hoursAgo(82)} where id = ${workingCase}
  `;
  await sql()`update orders set recommendation_done_at = ${hoursAgo(80)} where id = ${working}`;

  const bought = async (rate, back, usedAt, activityId) => {
    const [order] = await sql()`
      insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code,
                          status, is_demo, kind, rate, client_account_id, case_id, created_at, decided_at)
      values (${keyedHash(`demo-session-${rate}-${back}-${Date.now()}`)}, ${keyedHash(`demo-session-card-${rate}-${back}-${Date.now()}`)},
              ${rate === 'access' ? 2500 : 10000}, 'wise', ${demoReference(100 + back)}, 'confirmed', true, 'session', ${rate},
              ${`demo-acct-working-${stamp}`}, ${workingCase}, ${hoursAgo(back + 3)}, ${hoursAgo(back)})
      returning id
    `;
    await sql()`
      insert into held_sessions (case_id, order_id, rate, bought_at, used_at, activity_id, is_demo)
      values (${workingCase}, ${order.id}, ${rate}, ${hoursAgo(back)}, ${usedAt}, ${activityId}, true)
    `;
    if (rate === 'access') {
      await sql()`
        insert into access_requests (case_id, month, requested_at, granted_at, order_id, is_demo)
        values (${workingCase}, to_char(now() - interval '4 hours', 'YYYY-MM'), ${hoursAgo(back + 3)},
                ${hoursAgo(back + 3)}, ${order.id}, true)
      `;
    }
  };
  await bought('access', 75, hoursAgo(70), fourth);
  await bought('standard', 55, hoursAgo(26), second);
  await bought('standard', 55 - 1, null, null);
  await bought('access', 48, null, null);
  await bought('standard', 47, null, null);
  await sql()`
    insert into projects (case_id, activity_id, title_encrypted, state, due_at, delivered_at,
                          note_encrypted, created_at)
    values (${workingCase}, ${fourth},
            ${encrypt('Sample work one')},
            'done', ${hoursAgo(60)}, ${hoursAgo(52)},
            ${encrypt('Sample note.')}, ${hoursAgo(78)}),
           (${workingCase}, ${second},
            ${encrypt('Sample work two')},
            'doing', ${hoursAgo(18)}, null, null, ${hoursAgo(44)}),
           (${workingCase}, null,
            ${encrypt('Sample work three')},
            'to do', null, null, null, ${hoursAgo(12)})
  `;

  await say(`demo-acct-working-${stamp}`, 'opening',
    'What do you make of the recommendations? And would you like help following them through?', 88);
  await say(`demo-acct-working-${stamp}`, 'client', 'Sample client message one.', 80);
  await say(`demo-acct-working-${stamp}`, 'operator', 'Sample reply one.', 79);
  await say(`demo-acct-working-${stamp}`, 'auto', 'Farah reviewed your last message.', 78);
  await say(`demo-acct-working-${stamp}`, 'operator',
    'Sample check-in message.', 30, true);
  await syncStepsFor(working, [1, 2]);
  made.push({ reference: demoReference(n), is: 'a go, with a goal, seven activities, people to approach, five sessions on the card, work under two activities, two steps ticked and a conversation' });

  const quotedNoGo = await makeOrder(next());
  await makeCall(quotedNoGo, TRANSCRIPTS.b, 120);
  const quotedCase = await makeCase(quotedNoGo, `demo-acct-quoted-${stamp}`, 'Dev Oyelaranmi');
  await sql()`
    update orders set decision = 'no-go', decision_at = ${hoursAgo(118)},
                      recommendations_encrypted = ${encrypt('Sample next steps.')},
                      recommendations_written_at = ${hoursAgo(117)}
     where id = ${quotedNoGo}
  `;
  await sql()`
    insert into access_requests (case_id, month, requested_at, is_demo)
    values (${quotedCase}, to_char(now() - interval '4 hours' + interval '1 month', 'YYYY-MM'), ${hoursAgo(26)}, true)
  `;
  made.push({ reference: demoReference(n), is: "a no-go on next month's access-rate list" });

  const firstBuy = await makeOrder(next());
  await makeCall(firstBuy, TRANSCRIPTS.c, 400, {
    summary: 'Sample summary two.',
  });
  const returningCase = await makeCase(firstBuy, `demo-acct-returning-${stamp}`, 'Teodor Braskwell');
  await sql()`
    update orders set decision = 'go', decision_at = ${hoursAgo(398)},
                      approved_as_client_at = ${hoursAgo(398)},
                      recommendations_encrypted = ${encrypt('Sample next steps.')},
                      recommendations_written_at = ${hoursAgo(397)}
     where id = ${firstBuy}
  `;
  const secondBuy = await makeOrder(next());
  await makeCall(secondBuy, TRANSCRIPTS.c, 50, {
    kind: 'follow-up', seconds: 900,
    summary: 'Sample summary three.',
  });
  await sql()`update orders set client_account_id = ${`demo-acct-returning-${stamp}`},
                                case_id = ${returningCase} where id = ${secondBuy}`;
  made.push({ reference: demoReference(n), is: 'a second session under the same person' });

  await sql()`
    insert into introductions (a_order_id, b_order_id, a_case_id, b_case_id, reason_encrypted, made_at)
    values (${working}, ${firstBuy}, ${workingCase}, ${returningCase},
            ${encrypt('Sample introduction reason one.')},
            ${hoursAgo(28)})
  `;

  await sql()`
    insert into drafts (order_id, slot, model, job_id, prompt_tokens, completion_tokens,
                        seconds, finished_at, created_at)
    values (${working}, 'A', 'demo-model', 'demo-job-1', 1800, 400, 12,
            ${hoursAgo(87)}, ${hoursAgo(87)})
  `;
  await sql()`
    insert into drafts (order_id, slot, model, job_id, created_at, gave_up_at, failure)
    values (${working}, 'A', 'demo-model', 'demo-job-2', ${hoursAgo(86)}, ${hoursAgo(85.99)},
            'demo-model ended job demo-job-2 as failed. RunPod said: worker ran out of memory. Press again to start a new job.')
  `;
  const [recapDraft] = await sql()`
    insert into drafts (order_id, slot, model, job_id, kind, prompt_tokens, completion_tokens,
                        seconds, finished_at, created_at)
    values (${working}, 'A', 'demo-model', 'demo-job-3', 'recap', 2100, 120, 9,
            ${hoursAgo(80)}, ${hoursAgo(80)})
    returning id
  `;
  await sql()`
    insert into recaps (draft_id, order_id, content_encrypted, created_at)
    values (${recapDraft.id}, ${working},
            ${encrypt('Sample recap one.')},
            ${hoursAgo(80)})
  `;
  const [laterDraft] = await sql()`
    insert into drafts (order_id, slot, model, job_id, kind, prompt_tokens, completion_tokens,
                        seconds, finished_at, created_at)
    values (${working}, 'A', 'demo-model', 'demo-job-4', 'recap', 2600, 140, 11,
            ${hoursAgo(9)}, ${hoursAgo(9)})
    returning id
  `;
  await sql()`
    insert into recaps (draft_id, order_id, content_encrypted, created_at)
    values (${laterDraft.id}, ${working},
            ${encrypt('Sample recap two.')},
            ${hoursAgo(9)})
  `;
  const [gapsDraft] = await sql()`
    insert into drafts (order_id, slot, model, job_id, kind, prompt_tokens, completion_tokens,
                        seconds, finished_at, created_at)
    values (${working}, 'A', 'demo-model', 'demo-job-5', 'gaps', 1400, 160, 8,
            ${hoursAgo(30)}, ${hoursAgo(30)})
    returning id
  `;
  await sql()`
    insert into call_gaps (draft_id, order_id, call_id, content_encrypted, created_at)
    select ${gapsDraft.id}, ${working}, c.id, ${encrypt(JSON.stringify([
      { question: 'Sample question one?', reason: 'Sample reason one.' },
      { question: 'Sample question two?', reason: 'Sample reason two.' },
      { question: 'Sample question three?', reason: 'Sample reason three.' },
    ]))}, ${hoursAgo(30)}
      from calls c where c.order_id = ${working} order by c.id limit 1
  `;

  const blocked = await makeOrder(next());
  await makeCall(blocked, TRANSCRIPTS.b, 200);
  const blockedCase = await makeCase(blocked, `demo-acct-blocked-${stamp}`, 'Ines Halvorgaard');
  await sql()`
    update orders set decision = 'go', decision_at = ${hoursAgo(198)},
                      approved_as_client_at = ${hoursAgo(198)},
                      recommendations_encrypted = ${encrypt('Sample next steps.')},
                      recommendations_written_at = ${hoursAgo(197)}
     where id = ${blocked}
  `;
  await say(`demo-acct-blocked-${stamp}`, 'client', 'Sample client message three.', 60);
  await sql()`
    update cases set messages_read_at = ${hoursAgo(58)},
                     blocked_at = ${hoursAgo(58)},
                     blocker_encrypted = ${encrypt('Sample blocker.')}
     where id = ${blockedCase}
  `;
  await sql()`
    insert into introductions (a_order_id, a_case_id, to_link_encrypted, reason_encrypted,
                               outcome, outcome_encrypted, made_at, updated_at)
    values (${blocked}, ${blockedCase}, ${encrypt('https://example.com/profile/demo-profile')},
            ${encrypt('Sample introduction reason two.')},
            'worked', ${encrypt('Sample outcome.')},
            ${hoursAgo(150)}, ${hoursAgo(100)})
  `;
  const [blockedPlan] = await sql()`
    insert into plans (order_id, case_id, path, created_at)
    values (${blocked}, ${blockedCase}, 'smallest', ${hoursAgo(196)})
    returning id
  `;
  await sql()`
    insert into activities (case_id, plan_id, position, title_encrypted, state, shown_at, cadence, next_at, created_at)
    values (${blockedCase}, ${blockedPlan.id}, 1, ${encrypt('Sample activity one')}, 'todo', ${hoursAgo(150)},
            'weekly', ${hoursAgo(-20)}, ${hoursAgo(150)}),
           (${blockedCase}, ${blockedPlan.id}, 2, ${encrypt('Sample activity two')}, 'drafted', null, 'none', null, ${hoursAgo(150)})
  `;
  made.push({ reference: demoReference(n), is: 'blocked, waiting on somebody else, introduced by a profile link, a reminder due tomorrow' });

  await sql()`
    insert into questions (stage, body_encrypted, is_demo)
    values ('start', ${encrypt('DEMO Sample question one?')}, true),
           ('first', ${encrypt('DEMO Sample question two?')}, true),
           ('steady', ${encrypt('DEMO Sample question three?')}, true)
  `;
  await sql()`
    insert into questions (stage, topic_encrypted, body_encrypted, is_demo)
    values ('first', ${encrypt('Sample group')}, ${encrypt('DEMO Sample question four?')}, true)
  `;
  await sql()`
    insert into questions (stage, body_encrypted, sector_id, trade_id, is_demo)
    values ('first', ${encrypt('DEMO Sample question five?')}, 'demo-sector', 'demo-trade-1', true),
           ('any', ${encrypt('DEMO Sample question six?')}, 'demo-sector', null, true)
  `;
  await sql()`
    insert into question_asks (case_id, question_id, asked_at, is_demo)
    select ${workingCase}, id, ${hoursAgo(79)}, true from questions
     where is_demo and stage = 'first' and sector_id is null
  `;
  await sql()`
    insert into question_asks (case_id, question_id, asked_at, is_demo)
    select ${workingCase}, id, ${hoursAgo(79 + 168)}, true from questions
     where is_demo and stage = 'first' and sector_id is null and topic_encrypted is null
  `;
  await sql()`
    insert into question_passes (case_id, question_id, reason, passed_at, is_demo)
    select ${workingCase}, id, 'already-know', ${hoursAgo(30)}, true from questions
     where is_demo and stage = 'start'
  `;
  made.push({ reference: 'DEMO questions', is: 'questions for three stages, one in a group, one for a job title, one for a sector, two asked and one set aside' });

  const finished = await makeOrder(next());
  await makeCall(finished, TRANSCRIPTS.c, 500);
  const finishedCase = await makeCase(finished, `demo-acct-closed-${stamp}`, 'Wren Abernathe');
  await sql()`
    update orders set decision = 'go', decision_at = ${hoursAgo(498)},
                      approved_as_client_at = ${hoursAgo(498)},
                      recommendations_encrypted = ${encrypt('Sample next steps.')},
                      recommendations_written_at = ${hoursAgo(497)}
     where id = ${finished}
  `;
  await sql()`update cases set closed_at = ${hoursAgo(100)} where id = ${finishedCase}`;
  made.push({ reference: demoReference(n), is: 'closed' });

  const quiet = await makeOrder(next());
  await makeCall(quiet, TRANSCRIPTS.b, 300);
  const quietCase = await makeCase(quiet, `demo-acct-quiet-${stamp}`, 'Kade Ferrow');
  await sql()`
    update orders set decision = 'go', decision_at = ${hoursAgo(296)},
                      approved_as_client_at = ${hoursAgo(296)},
                      recommendations_encrypted = ${encrypt('Sample next steps.')},
                      recommendations_written_at = ${hoursAgo(295)}
     where id = ${quiet}
  `;
  const [quietPlan] = await sql()`
    insert into plans (order_id, case_id, path, created_at)
    values (${quiet}, ${quietCase}, 'smallest', ${hoursAgo(294)})
    returning id
  `;
  await sql()`
    insert into activities (case_id, plan_id, position, title_encrypted, state, shown_at, closed_at, created_at)
    values (${quietCase}, ${quietPlan.id}, 1, ${encrypt('Sample activity one')}, 'done', ${hoursAgo(290)}, ${hoursAgo(200)}, ${hoursAgo(290)}),
           (${quietCase}, ${quietPlan.id}, 2, ${encrypt('Sample activity two')}, 'todo', ${hoursAgo(200)}, null, ${hoursAgo(200)}),
           (${quietCase}, ${quietPlan.id}, 3, ${encrypt('Sample activity three')}, 'drafted', null, null, ${hoursAgo(100)})
  `;
  await say(`demo-acct-quiet-${stamp}`, 'client', 'Sample client message four.', 50);
  await say(`demo-acct-quiet-${stamp}`, 'operator', 'Sample reply two.', 48);
  made.push({ reference: demoReference(n), is: 'a go with nothing due, last spoken to two days ago' });

  const again = await makeOrder(next(), { status: 'pending' });
  await sql()`update orders set created_at = ${hoursAgo(5)}, client_account_id = ${`demo-acct-quiet-${stamp}`},
                                case_id = ${quietCase} where id = ${again}`;
  made.push({ reference: demoReference(n), is: "a payment to confirm on somebody's 2nd session" });

  const buying = await makeOrder(next(), { status: 'pending' });
  await sql()`update orders set created_at = ${hoursAgo(3)}, kind = 'session', rate = 'standard', card_amount_cents = 10000,
                                client_account_id = ${`demo-acct-quiet-${stamp}`}, case_id = ${quietCase} where id = ${buying}`;
  made.push({ reference: demoReference(n), is: 'a session at the standard rate, paid and waiting to be confirmed' });

  const toldNo = await makeOrder(next());
  await makeCall(toldNo, TRANSCRIPTS.b, 350);
  const toldNoCase = await makeCase(toldNo, `demo-acct-again-${stamp}`, 'Odile Marchbanks');
  await sql()`
    update orders set decision = 'no-go', decision_at = ${hoursAgo(345)},
                      recommendations_encrypted = ${encrypt('Sample next steps.')},
                      recommendations_written_at = ${hoursAgo(344)}
     where id = ${toldNo}
  `;
  const askedAgain = await makeOrder(next());
  await makeCall(askedAgain, TRANSCRIPTS.b, 6, { kind: 'follow-up', seconds: 1100 });
  await sql()`update orders set created_at = ${hoursAgo(8)}, client_account_id = ${`demo-acct-again-${stamp}`},
                                case_id = ${toldNoCase} where id = ${askedAgain}`;
  made.push({ reference: demoReference(n), is: 'a second session after a no-go, to decide again' });

  for (const back of [2, 20, 44, 70, 100, 230, 300]) {
    await sql()`insert into approach_taps (at, is_demo) values (${hoursAgo(back)}, true)`;
  }

  made.push(...(await seedClaimStates()));
  made.push(...(await seedChapters(stamp)));
  made.push(...(await seedSessionPivot(stamp)));
  made.push(...(await seedReferrals(stamp)));


  for (const [id, title, order] of [['demo-trade-1', 'Plumber', 1], ['demo-trade-2', 'Electrician', 2],
    ['demo-trade-3', 'Carpenter', 3]]) {
    await sql()`
      insert into trades (id, title, sector_id, sector, sector_order, title_order, is_demo)
      values (${id}, ${title}, 'demo-sector', 'Demo building trades', 999, ${order}, true)
      on conflict (id) do nothing
    `;
  }
  await sql()`
    update orders o set trade_id = 'demo-trade-' || (1 + (n.rank % 3))
      from (select id, row_number() over (order by id) as rank from orders
             where is_demo and decision = 'go') n
     where o.id = n.id
  `;
  const demoSkills = [
    ['demo-trade-1', ['Pipe fitting', 'Leak repair', 'Water heaters', 'Pricing a job']],
    ['demo-trade-2', ['Wiring', 'Panel upgrades', 'Lighting', 'Pricing a job']],
    ['demo-trade-3', ['Framing', 'Cabinets', 'Trim work', 'Pricing a job']],
  ];
  for (const [trade, names] of demoSkills) {
    for (const [i, name] of names.entries()) {
      await sql()`
        insert into trade_skills (id, trade_id, name, skill_order, is_demo)
        values (${`${trade}-skill-${i + 1}`}, ${trade}, ${name}, ${i + 1}, true)
        on conflict (id) do nothing
      `;
    }
  }
  await sql()`
    insert into order_skills (order_id, skill_id)
    select o.id, s.id
      from (select id from orders where is_demo and trade_id = 'demo-trade-1' order by id limit 1) o
      cross join (values ('demo-trade-1-skill-1'), ('demo-trade-1-skill-2'), ('demo-trade-1-skill-4')) s (id)
    on conflict do nothing
  `;
  await sql()`
    insert into pair_skips (pair_key, order_id, is_demo)
    values (${`o:${Math.min(blocked, finished)}|o:${Math.max(blocked, finished)}`}, ${blocked}, true),
           (${`o:${working}|${profileSide('DEMO-directory-profile-2')}`}, ${working}, true)
    on conflict do nothing
  `;
  await sql()`
    insert into case_events (order_id, case_id, kind, detail_encrypted, created_at)
    values (${blocked}, ${blockedCase}, 'pair.skipped', ${encrypt('With the closed demo client.')}, ${hoursAgo(26)}),
           (${working}, ${workingCase}, 'pair.skipped', ${encrypt('With a Directory profile.')}, ${hoursAgo(25)})
  `;
  for (const [order, step, seconds] of [
    [working, 'call-fields', 70], [working, 'decide', 40], [working, 'recommend', 540],
    [working, 'reply', 120], [late, 'call-fields', 55], [quotedNoGo, 'decide', 35],
    [quotedNoGo, 'recommend', 410],
  ]) {
    await sql()`insert into step_times (order_id, step, seconds, at)
                values (${order}, ${step}, ${seconds}, ${hoursAgo(20)})`;
  }
  return made;
}

export async function clearDemo() {
  const accounts = await sql()`select account_id from cases where is_demo`;
  const names = accounts.map((r) => r.account_id);

  for (const account of names) {
    await sql()`delete from messages where account_id = ${account}`;
  }

  await sql()`delete from held_sessions where is_demo`;
  await sql()`delete from access_requests where is_demo`;
  await sql()`delete from question_passes where is_demo`;
  await sql()`delete from approach_taps where is_demo`;
  await sql()`delete from pair_skips where is_demo`;
  await sql()`delete from question_asks where is_demo`;
  await sql()`delete from questions where is_demo`;
  await sql()`delete from trades where is_demo`;
  const orders = await sql()`delete from orders where is_demo returning id`;
  const cases = await sql()`delete from cases where is_demo returning id`;

  return { orders: orders.length, cases: cases.length, messagesFor: names.length };
}
