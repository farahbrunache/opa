import { sql } from './db.js';
import { agreedWording } from './quote-terms.js';
import { encrypt, keyedHash } from './crypto.js';
import { profileSide } from './desk-skips.js';
import { seedClaimStates } from './demo-claim.js';
import { seedChapters, seedSessionPivot } from './demo-chapters.js';
import { seedReferrals } from './demo-referrals.js';

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
    insert into step_ticks (order_id, step, done_at, is_demo)
    values (${working}, 1, ${hoursAgo(84)}, true), (${working}, 2, ${hoursAgo(40)}, true)
  `;
  await sql()`
    insert into case_events (order_id, case_id, kind, detail_encrypted, created_at)
    values (${working}, ${workingCase}, 'step.done', ${encrypt('Step 1 marked done by the client.')}, ${hoursAgo(84)}),
           (${working}, ${workingCase}, 'step.done', ${encrypt('Step 2 marked done by the client.')}, ${hoursAgo(40)})
  `;
  const plan = await sql()`
    insert into plans (order_id, case_id, path, created_at)
    values (${working}, ${workingCase}, 'smallest', ${hoursAgo(88)})
    returning id
  `;
  const steps = await sql()`
    insert into milestones (plan_id, position, title_encrypted, status, outcome_encrypted)
    values (${plan[0].id}, 1, ${encrypt('Sample milestone one')}, 'worked',
            ${encrypt('Sample outcome.')}),
           (${plan[0].id}, 2, ${encrypt('Sample milestone two')}, 'in progress', null)
    returning id, position
  `;

  const worked = steps.find((row) => row.position === 1).id;
  const ongoing = steps.find((row) => row.position === 2).id;
  await sql()`
    insert into action_items (milestone_id, position, title_encrypted, status, cadence,
                              next_at, outcome_encrypted, closed_at, created_at)
    values (${worked}, 1, ${encrypt('Sample action one')},
            'done', 'none', null,
            ${encrypt('Sample outcome.')},
            ${hoursAgo(70)}, ${hoursAgo(86)}),
           (${ongoing}, 1, ${encrypt('Sample action two')},
            'open', 'weekly', ${hoursAgo(26)}, null, null, ${hoursAgo(200)}),
           (${ongoing}, 2, ${encrypt('Sample action three')},
            'open', 'none', null, null, null, ${hoursAgo(60)}),
           (${ongoing}, 3, ${encrypt('Sample action four')},
            'open', 'three-days', ${hoursAgo(20 - 72)}, null, null, ${hoursAgo(50)})
  `;
  await sql()`
    update action_items set asked_at = ${hoursAgo(20)}
     where milestone_id = ${ongoing} and position = 3
  `;
  const [later] = await sql()`
    insert into milestones (plan_id, position, title_encrypted, status)
    values (${plan[0].id}, 3, ${encrypt('Sample milestone three')}, 'planned')
    returning id
  `;
  await sql()`
    insert into action_items (milestone_id, position, title_encrypted, status, cadence)
    values (${later.id}, 1, ${encrypt('Sample action five')}, 'open', 'none')
  `;
  const unseen = { milestone: Number(later.id), actions: [Number(ongoing)] };
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

  await sql()`
    insert into quotes (account_id, amount_cents, scope_encrypted, status, answered_at, due_at,
                        created_at, agreed_terms)
    values (${`demo-acct-working-${stamp}`}, 1200,
            ${encrypt('Sample scope one.')},
            'agreed', ${hoursAgo(60)}, ${hoursAgo(20)}, ${hoursAgo(72)}, ${agreedWording()})
  `;
  await sql()`
    insert into quotes (account_id, amount_cents, scope_encrypted, status, answered_at, due_at,
                        paid_cents, paid_at, discount_encrypted, created_at, agreed_terms)
    values (${`demo-acct-working-${stamp}`}, 900,
            ${encrypt('Sample scope two.')},
            'paid', ${hoursAgo(70)}, ${hoursAgo(50)}, 800, ${hoursAgo(48)},
            ${encrypt('Sample note.')},
            ${hoursAgo(80)}, ${agreedWording()})
  `;

  await sql()`
    insert into quotes (account_id, amount_cents, scope_encrypted, status, answered_at,
                        reason_encrypted, created_at)
    values (${`demo-acct-working-${stamp}`}, 1500,
            ${encrypt('Sample scope three.')},
            'changes asked', ${hoursAgo(10)},
            ${encrypt('Sample question?')}, ${hoursAgo(34)})
  `;

  const [paidQuote] = await sql()`
    select id from quotes where account_id = ${`demo-acct-working-${stamp}`} and status = 'paid'
    limit 1
  `;
  const workingCaseId = workingCase;
  await sql()`
    insert into projects (case_id, quote_id, title_encrypted, state, due_at, delivered_at,
                          note_encrypted, created_at)
    values (${workingCaseId}, ${paidQuote ? Number(paidQuote.id) : null},
            ${encrypt('Sample scope two')},
            'delivered', ${hoursAgo(60)}, ${hoursAgo(52)},
            ${encrypt('Sample note.')}, ${hoursAgo(78)}),
           (${workingCaseId}, null,
            ${encrypt('Sample project two')},
            'doing', ${hoursAgo(18)}, null, null, ${hoursAgo(44)})
  `;

  await say(`demo-acct-working-${stamp}`, 'opening',
    'What do you make of the recommendations? And would you like help following them through?', 88);
  await say(`demo-acct-working-${stamp}`, 'client', 'Sample client message one.', 80);
  await say(`demo-acct-working-${stamp}`, 'operator', 'Sample reply one.', 79);
  await say(`demo-acct-working-${stamp}`, 'auto', 'Farah reviewed your last message.', 78);
  await say(`demo-acct-working-${stamp}`, 'operator',
    'Sample check-in message.', 30, true);
  made.push({ reference: demoReference(n), is: 'a go, with a plan, milestones, actions, people to approach, quotes, work owed, two steps ticked and a conversation' });

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
    insert into quotes (account_id, amount_cents, scope_encrypted, status, created_at)
    values (${`demo-acct-quoted-${stamp}`}, 1100,
            ${encrypt('Sample scope four.')},
            'offered', ${hoursAgo(40)})
  `;
  await say(`demo-acct-quoted-${stamp}`, 'client', 'Sample client message two.', 26);
  made.push({ reference: demoReference(n), is: 'a no-go who was quoted, and wrote in 26 hours ago' });

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
  const [firstStep] = await sql()`
    insert into milestones (plan_id, position, title_encrypted, status)
    values (${blockedPlan.id}, 1, ${encrypt('Sample milestone one')}, 'in progress'),
           (${blockedPlan.id}, 2, ${encrypt('Sample milestone two')}, 'planned')
    returning id
  `;
  await sql()`
    insert into action_items (milestone_id, position, title_encrypted, status, cadence, next_at, created_at)
    values (${firstStep.id}, 1, ${encrypt('Sample action one')}, 'open', 'weekly',
            ${hoursAgo(-20)}, ${hoursAgo(150)})
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
  made.push({ reference: 'DEMO questions', is: 'questions for three stages, one in a group, one for a job title, one for a sector, and two asked' });

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
    insert into milestones (plan_id, position, title_encrypted, status)
    values (${quietPlan.id}, 1, ${encrypt('Sample milestone one')}, 'worked'),
           (${quietPlan.id}, 2, ${encrypt('Sample milestone two')}, 'in progress'),
           (${quietPlan.id}, 3, ${encrypt('Sample milestone three')}, 'planned')
  `;
  await say(`demo-acct-quiet-${stamp}`, 'client', 'Sample client message four.', 50);
  await say(`demo-acct-quiet-${stamp}`, 'operator', 'Sample reply two.', 48);
  made.push({ reference: demoReference(n), is: 'a go with nothing due, last spoken to two days ago' });

  const again = await makeOrder(next(), { status: 'pending' });
  await sql()`update orders set created_at = ${hoursAgo(5)}, client_account_id = ${`demo-acct-quiet-${stamp}`},
                                case_id = ${quietCase} where id = ${again}`;
  made.push({ reference: demoReference(n), is: "a payment to confirm on somebody's 2nd session" });

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
  await sql()`
    update milestones m set shown_at = m.created_at
      from plans p join orders o on o.id = p.order_id
     where m.plan_id = p.id and o.is_demo and m.shown_at is null and m.id <> ${unseen.milestone}
  `;
  await sql()`
    update action_items a set shown_at = a.created_at
      from milestones m join plans p on p.id = m.plan_id join orders o on o.id = p.order_id
     where a.milestone_id = m.id and o.is_demo and a.shown_at is null and m.id <> ${unseen.milestone}
       and not (a.milestone_id = any(${unseen.actions}::bigint[]) and a.position = 2)
  `;
  return made;
}

export async function clearDemo() {
  const accounts = await sql()`select account_id from cases where is_demo`;
  const names = accounts.map((r) => r.account_id);

  for (const account of names) {
    await sql()`delete from messages where account_id = ${account}`;
    await sql()`delete from quotes where account_id = ${account}`;
  }

  await sql()`delete from step_ticks where is_demo`;
  await sql()`delete from approach_taps where is_demo`;
  await sql()`delete from pair_skips where is_demo`;
  await sql()`delete from question_asks where is_demo`;
  await sql()`delete from questions where is_demo`;
  await sql()`delete from trades where is_demo`;
  const orders = await sql()`delete from orders where is_demo returning id`;
  const cases = await sql()`delete from cases where is_demo returning id`;

  return { orders: orders.length, cases: cases.length, messagesFor: names.length };
}
