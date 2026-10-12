import { sql } from './db.js';
import { encrypt, keyedHash } from './crypto.js';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const REFERENCE = 'DEMOP-PPPPP';

const BRIEF = [
  'Sample brief line one.',
  '',
  'Sample brief line two.',
].join('\n');

const SUMMARY = 'Sample chapter summary.';

export async function seedChapters(stamp) {
  const account = `demo-acct-pivot-${stamp}`;
  const [order] = await sql()`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_demo, created_at, decided_at,
                        decision, decision_at, approved_as_client_at)
    values (${keyedHash(`demo-claim-pivot-${Date.now()}`)}, ${keyedHash(`demo-card-pivot-${Date.now()}`)},
            700, 'wise', ${REFERENCE}, 'confirmed', true, ${hoursAgo(240)}, ${hoursAgo(236)},
            'go', ${hoursAgo(200)}, ${hoursAgo(200)})
    returning id
  `;
  const [person] = await sql()`
    insert into cases (account_id, is_demo, name_encrypted, created_at)
    values (${account}, true, ${encrypt('Kim Wrenfield')}, ${hoursAgo(230)})
    returning id
  `;
  await sql()`update orders set client_account_id = ${account}, case_id = ${person.id} where id = ${order.id}`;
  const [first] = await sql()`
    update chapters set started_at = ${hoursAgo(240)}, name_encrypted = ${encrypt('Sample chapter one')}
     where case_id = ${person.id} and number = 1
    returning id
  `;

  await sql()`
    insert into calls (order_id, call_id, kind, seconds, transcript_encrypted, started_at, ended_at,
                       fields_encrypted)
    values (${order.id}, ${`demo-call-pivot-${order.id}`}, 'intake', 610,
            ${encrypt('Agent: Sample line one.\nCaller: Sample reply one.')},
            ${hoursAgo(220.2)}, ${hoursAgo(220)},
            ${encrypt(JSON.stringify({
              trade: 'Sample trade', rate: 'Sample rate',
              inTheWay: 'Sample note.', firstCustomer: 'Sample customer',
            }))})
  `;
  const [plan] = await sql()`
    insert into plans (order_id, case_id, path, in_force, created_at)
    values (${order.id}, ${person.id}, 'smallest', false, ${hoursAgo(198)})
    returning id
  `;
  await sql()`
    insert into activities (case_id, plan_id, position, title_encrypted, state, drop_reason, closed_at,
                            chapter_id, created_at, updated_at)
    values (${person.id}, ${plan.id}, 1, ${encrypt('Sample activity one')}, 'dropped', 'changed-direction',
            ${hoursAgo(29)}, ${first.id}, ${hoursAgo(198)}, ${hoursAgo(29)})
  `;

  const say = async (author, body, back) => (await sql()`
    insert into messages (account_id, author, body_encrypted, created_at)
    values (${account}, ${author}, ${encrypt(body)}, ${hoursAgo(back)})
    returning id
  `)[0].id;
  await say('opening', 'Sample opening message.', 199);
  await say('client', 'Sample client message one.', 150);
  await say('operator', 'Sample reply one.', 140);
  await say('client', 'Sample client message two.', 96);
  const brief = await say('client', BRIEF, 30);

  await sql()`
    update chapters set ended_at = ${hoursAgo(29)}, decision = 'go', decision_at = ${hoursAgo(200)},
                        summary_encrypted = ${encrypt(SUMMARY)},
                        closed_with_encrypted = ${encrypt(JSON.stringify({ activities: ['Sample activity one'], work: [] }))}
     where id = ${first.id}
  `;
  await sql()`
    insert into chapters (case_id, number, name_encrypted, started_at, brief_encrypted, changed_encrypted,
                          started_by, from_message_id)
    values (${person.id}, 2, ${encrypt('Sample chapter two')}, ${hoursAgo(29)}, ${encrypt(BRIEF)},
            ${encrypt('Sample change.')}, 'them', ${brief})
  `;
  await say('operator', 'Sample reply two.', 20);

  await sql()`
    insert into case_events (order_id, case_id, chapter_id, kind, detail_encrypted, created_at)
    values (${order.id}, ${person.id}, ${first.id}, 'decided', ${encrypt('go.')}, ${hoursAgo(200)})
  `;
  await sql()`
    insert into case_events (order_id, case_id, kind, detail_encrypted, created_at)
    values (${order.id}, ${person.id}, 'pivot',
            ${encrypt('Chapter 2 started: Sample chapter two. Carried: sessions, skills profile. '
              + 'Closed: 1 activity dropped as changed direction. Decision reset. Chapter 1 summary saved, 3 words.')},
            ${hoursAgo(29)})
  `;
  return [{ reference: REFERENCE, is: 'two chapters, no decision on the second yet' }];
}

const SECOND = 'DEMOC-CCCCC';

export async function seedSessionPivot(stamp) {
  const account = `demo-acct-second-${stamp}`;
  const order = async (reference, made, decided, decision) => (await sql()`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_demo, created_at, decided_at,
                        decision, decision_at, approved_as_client_at, client_account_id)
    values (${keyedHash(`demo-claim-${reference}-${Date.now()}`)}, ${keyedHash(`demo-card-${reference}-${Date.now()}`)},
            700, 'wise', ${reference}, 'confirmed', true, ${hoursAgo(made)}, ${hoursAgo(made - 4)},
            ${decision}, ${decision ? hoursAgo(decided) : null}, ${decision ? hoursAgo(decided) : null}, ${account})
    returning id
  `)[0].id;
  const first = await order('DEMOB-BBBBB', 400, 380, 'go');
  const second = await order(SECOND, 30, null, null);
  const [person] = await sql()`
    insert into cases (account_id, is_demo, name_encrypted, created_at)
    values (${account}, true, ${encrypt('Odile Fernhaven')}, ${hoursAgo(395)})
    returning id
  `;
  await sql()`update orders set case_id = ${person.id} where id in (${first}, ${second})`;
  await sql()`
    update chapters set started_at = ${hoursAgo(400)}, name_encrypted = ${encrypt('Sample chapter one')}
     where case_id = ${person.id} and number = 1
  `;
  const call = (orderId, id, transcript, back, fields) => sql()`
    insert into calls (order_id, call_id, kind, seconds, transcript_encrypted, summary_encrypted,
                       started_at, ended_at, fields_encrypted)
    values (${orderId}, ${id}, 'intake', 640, ${encrypt(transcript)}, ${encrypt(JSON.stringify(fields.summary))},
            ${hoursAgo(back + 0.2)}, ${hoursAgo(back)}, ${encrypt(JSON.stringify(fields.lines))})
  `;
  await call(first, `demo-call-second-a-${first}`,
    'Agent: Sample line one.\nCaller: Sample reply one.', 390, {
      summary: 'Sample summary one.',
      lines: { trade: 'Sample trade', rate: 'Sample rate', inTheWay: 'Sample note.', firstCustomer: 'Sample customer' },
    });
  await call(second, `demo-call-second-b-${second}`,
    'Agent: Sample line two.\nCaller: Sample reply two.', 26, {
      summary: 'Sample summary two.',
      lines: { trade: 'Sample trade two', rate: 'Sample rate', inTheWay: 'Sample note.', firstCustomer: 'Sample customer' },
    });
  return [{ reference: SECOND, is: 'a second paid call asking for a new direction, ready to start Chapter 2 from' }];
}
