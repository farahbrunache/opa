import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const { recapFacts } = await import('../lib/draft-recap.js');

function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null,
    setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}

async function press(payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST',
    url: '/api/desk?action=draft',
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = fakeRes();
  try {
    await deskEndpoint(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

console.log('');
console.log('where this relationship stands');

const bare = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status)
  values ('h-recap-bare', 'c-recap-bare', 700, 'wise', 'RECAPBARE1', 'confirmed')
  returning id`;
const bareId = Number(bare[0].id);
const noCase = await press({ id: bareId, of: 'recap' });
check('an order with no case refuses rather than drafting', noCase.status === 409, noCase);
const why = (answer) => answer.message || answer.out?.error || '';
check('and it says to record a decision first', /decision/.test(why(noCase)), why(noCase));

const made = await tagged`insert into cases (account_id) values ('acct-recap') returning id`;
const caseId = Number(made[0].id);
const rows = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, case_id, decision, decision_at,
                      recommendations_encrypted, recommendations_written_at, client_account_id)
  values ('h-recap', 'c-recap', 700, 'wise', 'RECAP00001', 'confirmed', ${caseId}, 'go', now(),
          ${encrypt('Charge per job, not per hour.')}, now(), 'acct-recap')
  returning id`;
const id = Number(rows[0].id);

const plan = await tagged`
  insert into plans (order_id, case_id, path, in_force)
  values (${id}, ${caseId}, 'smallest', true) returning id`;
const planId = Number(plan[0].id);
await tagged`
  insert into activities (case_id, plan_id, position, title_encrypted, state, closed_at, outcome_encrypted)
  values (${caseId}, ${planId}, 1, ${encrypt('Name a rate per job')}, 'done', now(), ${encrypt('Settled on a flat rate')})`;
await tagged`
  insert into activities (case_id, plan_id, position, title_encrypted, state, shown_at, cadence, next_at)
  values (${caseId}, ${planId}, 2, ${encrypt('Write the rate down')}, 'todo', now(), 'weekly',
          now() - interval '2 days')`;
await tagged`
  insert into activities (case_id, plan_id, position, title_encrypted, state, closed_at, drop_reason)
  values (${caseId}, ${planId}, 3, ${encrypt('Print flyers')}, 'dropped', now(), 'tried-it')`;
const contact = await tagged`
  insert into contacts (case_id, name_encrypted, where_encrypted, why_encrypted, status)
  values (${caseId}, ${encrypt('A hardware store')}, ${encrypt('two streets over')},
          ${encrypt('they hire out')}, 'talking') returning id`;
await tagged`
  insert into outreach (contact_id, said_encrypted, back_encrypted, at)
  values (${Number(contact[0].id)}, ${encrypt('Asked what they pay')},
          ${encrypt('Told me to come by Friday')}, now() - interval '3 days')`;
await tagged`
  insert into projects (case_id, title_encrypted, state, due_at)
  values (${caseId}, ${encrypt('Sample work item')}, 'to do', now() - interval '1 day')`;
await tagged`
  insert into held_sessions (case_id, rate, used_at, activity_id)
  values (${caseId}, 'access', now(), (select id from activities where case_id = ${caseId} and position = 1))`;
await tagged`insert into held_sessions (case_id, rate) values (${caseId}, 'standard')`;
await tagged`
  insert into messages (account_id, author, body_encrypted)
  values ('acct-recap', 'client', ${encrypt('Friday went well. What do I charge them?')})`;

const facts = await recapFacts(id);
const text = facts.lines.join('\n');

check('the decision is in the facts', /Decision: go/.test(text), text.slice(0, 80));
check('and the sheet it was written with', text.includes('Charge per job, not per hour.'));
check('the plan in force is named', /Plan in force since .*smallest number/i.test(text));
check('a done activity, with what happened', /Activity, done: Name a rate per job.*Settled on a flat rate/.test(text), text);
check('one on their page, with its reminder', /Activity, to do, on their page: Write the rate down \(Every week.*due now\)/.test(text), text);
check('a dropped one, with why', /Activity, dropped: Print flyers — why: Tried it, didn't work/.test(text), text);
check('who is being approached, and where',
  /Approaching A hardware store at two streets over — talking/.test(text));
check('what was said and what came back',
  /Asked what they pay — back: Told me to come by Friday/.test(text));
check('work of yours, and that it is past due',
  /Yours to do, to do: Sample work item.*past due/.test(text));
check('the sessions on the card and what one went to',
  /Sessions on their card: 2, 1 used: Name a rate per job \(access rate\)/.test(text), text);
check('the conversation, with who wrote last',
  /The last was today, from them/.test(text) && text.includes('What do I charge them?'));

check('nothing handed over is still encrypted',
  !/[A-Za-z0-9+/]{40,}={0,2}/.test(text), text.match(/[A-Za-z0-9+/]{40,}={0,2}/)?.[0]);

const thinCase = await tagged`insert into cases (account_id) values ('acct-thin') returning id`;
const thin = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, case_id)
  values ('h-recap-thin', 'c-recap-thin', 700, 'wise', 'RECAPTHIN1', 'confirmed',
          ${Number(thinCase[0].id)})
  returning id`;
const empty = await press({ id: Number(thin[0].id), of: 'recap' });
check('a record with almost nothing in it refuses', empty.status === 409, empty);
check('and says reading it would be shorter',
  /shorter than reading it/.test(why(empty)), why(empty));

{
  const { firstSentence } = await import('../lib/desk-person.js');
  check('a catch-up is listed by its first sentence',
    firstSentence('Go, with the smallest path. Nothing is waiting.') === 'Go, with the smallest path.');
  check('a question mark ends one too', firstSentence('Paid yet? Not yet.') === 'Paid yet?');
  check('one with no full stop is the line itself', firstSentence('No stop here') === 'No stop here');
  check('a figure with a decimal point is not the end of a sentence',
    firstSentence('Owes $12.50 on the quote. More.') === 'Owes $12.50 on the quote.');
  const long = firstSentence(`${'word '.repeat(60)}end.`);
  check('a long one is cut at a word, under the limit', long.length <= 141 && long.endsWith('…') && !/wor…$/.test(long), long);
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
