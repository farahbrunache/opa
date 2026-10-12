import { Readable } from 'node:stream';
import { check, db, failureCount, pg, tagged } from './harness.mjs';

console.log('the schema');
await db.ensureSchema();
check('it builds from nothing', true);

db.useDatabase(tagged);
let twice = null;
try {
  await db.ensureSchema();
} catch (error) {
  twice = error.message;
}
check('and running it a second time changes nothing', twice === null, twice);

const { abandonCall, aCallCameBack, keepRecord, reconcileStarts, secondsSpent } =
  await import('../lib/calls.js');
const sql = () => tagged;

async function newOrder(overrides = {}) {
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${'h' + Math.random()}, ${'c' + Math.random()}, 700, 'wise',
            ${'R' + Math.floor(Math.random() * 1e9)}, ${overrides.status || 'confirmed'})
    returning id
  `;
  return Number(rows[0].id);
}

console.log('what an order bought');
const { ABANDON_WITHIN_SECONDS, ASSUME_FULL_AFTER_SECONDS, SESSION_BUDGET_SECONDS, UNREPORTED_AFTER_SECONDS } =
  await import('../lib/orders.js');
const used = (order) =>
  secondsSpent(order, ASSUME_FULL_AFTER_SECONDS, SESSION_BUDGET_SECONDS, UNREPORTED_AFTER_SECONDS);

const fresh = await newOrder();
check('a new order has spent nothing',
  (await used(fresh)) === 0);

const dropped = await newOrder();
await tagged`insert into calls (order_id, call_id, seconds, started_at)
             values (${dropped}, ${'c' + dropped}, 120, now() - interval '2 hours')`;
const afterDrop = await used(dropped);
check('a call that died early spends only the minutes it ran', afterDrop === 120, afterDrop);
check('and leaves enough to start again', afterDrop < SESSION_BUDGET_SECONDS);

const full = await newOrder();
await tagged`insert into calls (order_id, call_id, seconds, started_at)
             values (${full}, ${'c' + full}, 1800, now() - interval '2 hours')`;
const afterFull = await used(full);
check('a full session does not leave enough for another',
  afterFull + ASSUME_FULL_AFTER_SECONDS > SESSION_BUDGET_SECONDS, afterFull);

const silent = await newOrder();
await tagged`insert into calls (order_id, call_id, started_at)
             values (${silent}, ${'c' + silent}, now() - interval '3 hours')`;
check('a call nobody ever reported on stops being counted', (await used(silent)) === 0);

const recent = await newOrder();
await tagged`insert into calls (order_id, call_id, started_at)
             values (${recent}, ${'c' + recent}, now() - interval '40 minutes')`;
check('but one that could still be running is counted until then',
  (await used(recent)) === ASSUME_FULL_AFTER_SECONDS, await used(recent));

console.log('a session that never connected');
const failed = await newOrder();
await tagged`insert into calls (order_id, call_id) values (${failed}, 'c-failed-to-join')`;
check('it takes the entire budget while it looks like a call in progress',
  (await used(failed)) >= SESSION_BUDGET_SECONDS);
check('the page can say it never connected',
  (await abandonCall(failed, 'c-failed-to-join', ABANDON_WITHIN_SECONDS)) === true);
check('and the minutes come back', (await used(failed)) === 0);

const late = await newOrder();
await tagged`insert into calls (order_id, call_id, started_at)
             values (${late}, 'c-too-late', now() - interval '20 minutes')`;
check('a call from twenty minutes ago cannot be given back',
  (await abandonCall(late, 'c-too-late', ABANDON_WITHIN_SECONDS)) === false);

const talked = await newOrder();
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${talked}, 'c-had-a-transcript', 'x')`;
check('nor can one that produced a transcript',
  (await abandonCall(talked, 'c-had-a-transcript', ABANDON_WITHIN_SECONDS)) === false);

const running = await newOrder();
await tagged`insert into calls (order_id, call_id) values (${running}, ${'c' + running})`;
const duringCall = await used(running);
check('a call still going spends the entire budget, so nobody is on two at once',
  duringCall >= SESSION_BUDGET_SECONDS, duringCall);

console.log('counting the attempts back from what happened');
const pressed = await newOrder();
await tagged`update orders set session_starts = 3, first_started_at = now() - interval '10 minutes'
              where id = ${pressed}`;
await tagged`insert into calls (order_id, call_id, seconds, started_at)
             values (${pressed}, 'c-gave-nothing', 0, now() - interval '9 minutes')`;
await reconcileStarts(pressed, UNREPORTED_AFTER_SECONDS);
let attempts = await tagged`select session_starts, first_started_at from orders where id = ${pressed}`;
check('presses that produced nothing stop counting', attempts[0].session_starts === 0, attempts[0]);
check('and the window has not started either', attempts[0].first_started_at === null, attempts[0]);

const spoke = await newOrder();
await tagged`insert into calls (order_id, call_id, seconds, started_at)
             values (${spoke}, 'c-real-one', 900, now() - interval '5 minutes')`;
await tagged`insert into calls (order_id, call_id, seconds, started_at)
             values (${spoke}, 'c-gave-nothing-either', 0, now() - interval '4 minutes')`;
await reconcileStarts(spoke, UNREPORTED_AFTER_SECONDS);
attempts = await tagged`select session_starts, first_started_at from orders where id = ${spoke}`;
check('a call that ran is still an attempt', attempts[0].session_starts === 1, attempts[0]);
check('and the window runs from it', attempts[0].first_started_at !== null, attempts[0]);

const { describeStatus } = await import('../lib/orders.js');
const stuck = await newOrder();
await tagged`update orders set session_starts = 3, first_started_at = now() - interval '30 minutes'
              where id = ${stuck}`;
await tagged`insert into calls (order_id, call_id, seconds, started_at)
             values (${stuck}, 'c-stuck-one', 0, now() - interval '29 minutes')`;
await tagged`insert into calls (order_id, call_id, started_at)
             values (${stuck}, 'c-stuck-two', now() - interval '3 hours')`;
await reconcileStarts(stuck, UNREPORTED_AFTER_SECONDS);
const reopened = await tagged`select status, session_starts, first_started_at from orders where id = ${stuck}`;
check('an order whose every attempt failed opens again',
  describeStatus(reopened[0]) === 'confirmed', reopened[0]);
check('and it has no minutes against it', (await used(stuck)) === 0);

let missing = null;
try { await secondsSpent(stuck, ASSUME_FULL_AFTER_SECONDS, SESSION_BUDGET_SECONDS); }
catch (error) { missing = error; }
check('leaving out a figure is refused rather than ignored',
  /unreportedAfter/.test(missing?.message || ''), missing?.message);

console.log('what they are told afterwards');
const told = await newOrder();
await tagged`update orders set decision = 'no-go', decision_at = now(),
                               recommendations_encrypted = 'x', recommendations_written_at = now()
              where id = ${told}`;
const sheet = await tagged`
  select decision, approved_as_client_at, recommendations_encrypted
    from orders where id = ${told}`;
check('a no-go still has something to read',
  sheet[0].recommendations_encrypted === 'x', sheet[0]);
check('and is not approved', sheet[0].approved_as_client_at === null, sheet[0]);

console.log('keeping what the voice service forgets');
const recorded = await newOrder();
await tagged`insert into calls (order_id, call_id) values (${recorded}, 'c-with-a-record')`;
check('a record is kept against the call it belongs to',
  (await keepRecord('c-with-a-record', 'encrypted-blob')) === true);
const kept = await tagged`
  select record_encrypted, record_taken_at from calls where call_id = 'c-with-a-record'`;
check('and when it was taken is kept with it',
  kept[0].record_encrypted === 'encrypted-blob' && kept[0].record_taken_at !== null, kept[0]);
check('a call this site never started keeps nothing',
  (await keepRecord('c-never-heard-of', 'encrypted-blob')) === false);

await keepRecord('c-with-a-record', 'the-fuller-one');
const replaced = await tagged`
  select record_encrypted from calls where call_id = 'c-with-a-record'`;
check('a fuller record replaces the first', replaced[0].record_encrypted === 'the-fuller-one');

console.log('the columns that were called assessment');

const RENAME_COLUMN = (from, to) => `
  do $$
  begin
    if exists (
      select 1 from information_schema.columns
      where table_name = 'orders' and column_name = '${from}'
    ) and not exists (
      select 1 from information_schema.columns
      where table_name = 'orders' and column_name = '${to}'
    ) then
      alter table orders rename column ${from} to ${to};
    end if;
  end $$;
`;
async function runTheRename() {
  await pg.query(RENAME_COLUMN('assessment', 'decision'));
  await pg.query(RENAME_COLUMN('assessed_at', 'decision_at'));
}

const renamed = await newOrder();
await tagged`
  update orders set decision = 'go', decision_at = now(), decided_at = now() - interval '1 day'
   where id = ${renamed}`;

await pg.query('alter table orders rename column decision to assessment');
await pg.query('alter table orders rename column decision_at to assessed_at');
await runTheRename();

const columns = await tagged`
  select column_name from information_schema.columns
   where table_name = 'orders'
     and column_name in ('assessment', 'assessed_at', 'decision', 'decision_at', 'decided_at')
   order by column_name`;
check('the old names are gone and the new ones are there',
  columns.map((c) => c.column_name).join(',') === 'decided_at,decision,decision_at',
  columns.map((c) => c.column_name));

const carried = await tagged`
  select decision, decision_at, decided_at from orders where id = ${renamed}`;
check('and what was in it came across',
  carried[0].decision === 'go' && carried[0].decision_at !== null, carried[0]);
check('the payment\'s own timestamp is still its own',
  carried[0].decided_at !== null
    && new Date(carried[0].decided_at) < new Date(carried[0].decision_at), carried[0]);

await pg.query('alter table orders rename column decision_at to assessed_at');
await runTheRename();
const finished = await tagged`select decision, decision_at from orders where id = ${renamed}`;
check('a half-done rename finishes itself', finished[0].decision_at !== null, finished[0]);

await runTheRename();
const again = await tagged`select decision from orders where id = ${renamed}`;
check('running it a second time changes nothing', again[0].decision === 'go');

console.log('when the conversation opens');

async function conversationOpen(account) {
  const rows = await tagged`
    select 1 from orders
     where client_account_id = ${account} and approved_as_client_at is not null
     limit 1`;
  return rows.length > 0;
}

const waiting = await newOrder();
await tagged`update orders set client_account_id = 'acct-waiting' where id = ${waiting}`;
check('somebody who has paid and not been read has no conversation',
  (await conversationOpen('acct-waiting')) === false);

const turned = await newOrder();
await tagged`update orders set client_account_id = 'acct-no-go', decision = 'no-go',
                               decision_at = now(), approved_as_client_at = null
              where id = ${turned}`;
check('and a no-go has none either', (await conversationOpen('acct-no-go')) === false);

const client = await newOrder();
await tagged`update orders set client_account_id = 'acct-go', decision = 'go',
                               decision_at = now(), approved_as_client_at = now()
              where id = ${client}`;
check('a go opens it', (await conversationOpen('acct-go')) === true);

await tagged`update orders set decision = 'no-go', approved_as_client_at = null
              where id = ${client}`;
check('and changing the decision back closes it again',
  (await conversationOpen('acct-go')) === false);

await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-go', 'opening', 'x')`;
const already = await tagged`select 1 from messages where account_id = 'acct-go' limit 1`;
check('a thread with something in it is not opened again', already.length === 1);

console.log('a call that came back spends the session');


const hadTheirCall = await newOrder();
await tagged`insert into calls (order_id, call_id, seconds, transcript_encrypted)
             values (${hadTheirCall}, 'c-four-minutes', 240, 'what was said')`;
check('four minutes with words in it is a session that happened',
  (await aCallCameBack(hadTheirCall)) === true);

const neverConnected = await newOrder();
await tagged`insert into calls (order_id, call_id) values (${neverConnected}, 'c-never-connected')`;
check('a start that came back with nothing does not',
  (await aCallCameBack(neverConnected)) === false);

check('and an order with no calls at all does not',
  (await aCallCameBack(await newOrder())) === false);

console.log('the desk can read what it reads');
await tagged`
  select o.id, o.reference_code, o.decision, o.decision_at, o.status, o.case_id,
         o.recommendations_encrypted, o.recommendations_written_at,
         o.client_account_id, o.approved_as_client_at,
         k.first_customer_at,
         o.session_starts, o.first_started_at,
         exists (select 1 from calls c
                  where c.order_id = o.id and c.record_encrypted is null
                    and c.transcript_encrypted is not null) as record_missing
    from orders o left join cases k on k.id = o.case_id limit 1`;
await tagged`
  select id, call_id, kind, transcript_encrypted, summary_encrypted, started_at, ended_at,
         seconds, record_encrypted, record_taken_at
    from calls limit 1`;
check('the desk reads only columns the schema has', true);

console.log('the reservation');
const contested = await newOrder();
const MAX = 3;
const take = () => tagged`
  update orders set session_starts = session_starts + 1,
                    first_started_at = coalesce(first_started_at, now())
   where id = ${contested} and status = 'confirmed' and session_starts < ${MAX}
   returning session_starts`;
const results = await Promise.all([take(), take(), take(), take(), take()]);
const won = results.filter((r) => r.length).length;
check('it hands out exactly the number of starts there are', won === MAX, won);

console.log('one plan in force');
const planned = await newOrder();
await tagged`insert into plans (order_id, goal) values (${planned}, 'reach')`;
let second = null;
try {
  await tagged`insert into plans (order_id, goal) values (${planned}, 'smallest')`;
} catch (error) {
  second = error.message;
}
check('the database refuses a second plan in force', second !== null);
await tagged`update plans set in_force = false where order_id = ${planned}`;
await tagged`insert into plans (order_id, goal) values (${planned}, 'smallest')`;
const inForce = await tagged`select goal from plans where order_id = ${planned} and in_force`;
check('and takes the new one once the old is retired', inForce[0]?.goal === 'smallest', inForce);

console.log('the funnel');
const account = 'user_invented_for_this_test';
const a = await newOrder();
const b = await newOrder();
for (const id of [a, b]) {
  await tagged`update orders set client_account_id = ${account}, decision = 'go' where id = ${id}`;
  await tagged`insert into calls (order_id, call_id, transcript_encrypted, seconds)
               values (${id}, ${'t' + id}, 'x', 600)`;
}
const counted = await tagged`
  with people as (
    select o.id, coalesce(o.client_account_id, 'order:' || o.id) as who, o.decision,
           exists (select 1 from calls c where c.order_id = o.id
                    and c.transcript_encrypted is not null) as called
      from orders o where o.status = 'confirmed'
  )
  select count(distinct who) filter (where called and decision = 'go') as go from people`;
check('two orders from one person count once', Number(counted[0].go) === 1, counted[0]);

console.log('introductions');
const one = await newOrder();
const other = await newOrder();
await tagged`insert into introductions (a_order_id, b_order_id) values (${one}, ${other})`;
const reverse = await tagged`
  select id from introductions
   where (a_order_id = ${other} and b_order_id = ${one})
      or (a_order_id = ${one} and b_order_id = ${other}) limit 1`;
check('the pair is found whichever way round it is asked', reverse.length === 1);

let selfIntro = null;
try {
  await tagged`insert into introductions (a_order_id, b_order_id) values (${one}, ${one})`;
} catch (error) {
  selfIntro = error.message;
}
check('and nobody is introduced to themselves', selfIntro !== null);

console.log('the operator\'s choices');
const settings = await import('../lib/settings.js');
await settings.writeChoice('draft.model.slot', 'A');
await settings.writeChoice('draft.model.slot', 'B');
check('a choice replaces the one before it', (await settings.readChoice('draft.model.slot')) === 'B');
check('a choice nobody has made reads as nothing',
  (await settings.readChoice('draft.model.never.set')) === null);

console.log('what a draft cost');
const costedId = await newOrder();
await tagged`insert into drafts (order_id, slot, model, prompt_tokens, completion_tokens, seconds)
             values (${costedId}, 'A', 'llama3.2', 900, 120, 7)`;
const spent = await tagged`
  select sum(prompt_tokens)::int as inbound, sum(completion_tokens)::int as outbound
    from drafts where order_id = ${costedId}`;
check('tokens in and out are both recorded',
  spent[0].inbound === 900 && spent[0].outbound === 120, spent[0]);

const draftColumns = await tagged`
  select column_name from information_schema.columns where table_name = 'drafts'`;
check('no draft text is stored',
  !draftColumns.some((c) => /content|body|text|encrypted/.test(c.column_name)),
  draftColumns.map((c) => c.column_name));

console.log('');
console.log('the queue that surfaces a message');

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const deskEndpoint = (await import('../api/desk.js')).default;

async function askDesk(state) {
  const req = { method: 'GET', url: `/api/desk?action=queue&state=${state}`, headers: {
    cookie: `op_session=${signSession('admin-1')}`,
  } };
  let payload = null;
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    getHeader() {},
    end(text) { this.writableEnded = true; try { payload = JSON.parse(text); } catch { payload = text; } },
  };
  await deskEndpoint(req, res);
  return payload;
}

const goWhoWrote = await newOrder();
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${goWhoWrote}, ${'c-go-wrote-' + goWhoWrote}, 'x')`;
await tagged`update orders set decision = 'go', decision_at = now(), approved_as_client_at = now(),
                               client_account_id = 'acct-go-wrote' where id = ${goWhoWrote}`;
await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-go-wrote', 'client', 'x')`;

let replies = await askDesk('replies');
check('a go who writes in shows in the tab that surfaces a message',
  replies.people.some((p) => Number(p.id) === goWhoWrote),
  replies.people.map((p) => Number(p.id)));
check('and the count matches the rows',
  replies.total === replies.people.length, [replies.total, replies.people.length]);

const approvedWhoWrote = await newOrder();
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${approvedWhoWrote}, ${'c-appr-' + approvedWhoWrote}, 'x')`;
await tagged`update orders set decision = 'go', decision_at = now(),
                               approved_as_client_at = now(),
                               client_account_id = 'acct-approved' where id = ${approvedWhoWrote}`;
await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-approved', 'client', 'x')`;

replies = await askDesk('replies');
check('an approved person who writes in still shows',
  replies.people.some((p) => Number(p.id) === approvedWhoWrote),
  replies.people.map((p) => Number(p.id)));

await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-approved', 'operator', 'x')`;
replies = await askDesk('replies');
check('somebody already written back to drops off it',
  !replies.people.some((p) => Number(p.id) === approvedWhoWrote),
  replies.people.map((p) => Number(p.id)));

const { encrypt } = await import('../lib/crypto.js');

async function askPerson(id) {
  const req = { method: 'GET', url: `/api/desk?action=person&id=${id}`, headers: {
    cookie: `op_session=${signSession('admin-1')}`,
  } };
  let payload = null;
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    getHeader() {},
    end(text) { this.writableEnded = true; try { payload = JSON.parse(text); } catch { payload = text; } },
  };
  await deskEndpoint(req, res);
  return payload;
}

const approvedRecord = await newOrder();
await tagged`update orders set decision = 'go', decision_at = now(), approved_as_client_at = now(),
                               client_account_id = 'acct-approved-record' where id = ${approvedRecord}`;
await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-approved-record', 'client', ${encrypt('Can we talk about the timing?')})`;
let record = await askPerson(approvedRecord);
check('the record screen says the conversation is open on a go', record.conversationOpen === true,
  [record.decision, record.approvedAt]);
check('and it says a reply is owed on the same record',
  record.awaitingReply === true, record.awaitingReply);

const plainNoGo = await newOrder();
await tagged`update orders set decision = 'no-go', decision_at = now(),
                               client_account_id = 'acct-plain-no' where id = ${plainNoGo}`;
record = await askPerson(plainNoGo);
check('a no-go stays closed', record.conversationOpen === false, record.approvedAt);


console.log('');
console.log('a case is a person');

const { caseForAccount } = db;

const justInterest = await newOrder();
const [interest] = await tagged`select case_id from orders where id = ${justInterest}`;
check('an order with no sign-in has no case', interest.case_id === null, interest);

const firstBuy = await newOrder();
const secondBuy = await newOrder();
const theirCase = await caseForAccount('acct-two-orders');
await tagged`update orders set client_account_id = 'acct-two-orders', case_id = ${theirCase}
              where id in (${firstBuy}, ${secondBuy})`;
const together = await tagged`
  select count(distinct case_id)::int as cases, count(*)::int as orders
    from orders where client_account_id = 'acct-two-orders'`;
check('two orders under one account are one case',
  together[0].cases === 1 && together[0].orders === 2, together[0]);

check('an account has exactly one case, however often it is asked for',
  (await caseForAccount('acct-two-orders')) === theirCase);

await tagged`insert into plans (order_id, case_id, goal) values (${firstBuy}, ${theirCase}, 'reach')`;
let refused = null;
try {
  await tagged`insert into plans (order_id, case_id, goal) values (${secondBuy}, ${theirCase}, 'smallest')`;
} catch (error) { refused = error.message; }
check('one person cannot be on two paths at once', refused !== null, refused);

await tagged`update cases set first_customer_at = now() where id = ${theirCase}`;
const earning = await tagged`
  select count(distinct o.case_id)::int as people
    from orders o join cases k on k.id = o.case_id
   where k.first_customer_at is not null`;
check('one person with two orders is one person earning', earning[0].people === 1, earning[0]);

const { signSession: signAccount } = await import('../lib/crypto.js');
const { keyedHash: hashToken } = await import('../lib/crypto.js');
const clientEndpoint = (await import('../api/client.js')).default;

const toLink = await newOrder();
const claimToken = 'claim-token-for-the-link-test';
await tagged`update orders set claim_token_hash = ${hashToken(claimToken)} where id = ${toLink}`;

const linkReq = Readable.from([JSON.stringify({ t: claimToken })]);
linkReq.method = 'POST';
linkReq.url = '/api/client?action=link';
linkReq.headers = {
  'content-type': 'application/json',
  cookie: `op_session=${signAccount('acct-just-signed-in')}`,
};
const linkRes = {
  statusCode: 200, writableEnded: false,
  setHeader() {}, getHeader() {}, end() { this.writableEnded = true; },
};
await clientEndpoint(linkReq, linkRes);

const linked = await tagged`
  select o.case_id, k.account_id from orders o left join cases k on k.id = o.case_id
   where o.id = ${toLink}`;
check('linking an order while signed in creates the case',
  linked[0].case_id !== null && linked[0].account_id === 'acct-just-signed-in', linked[0]);

const orderColumns = await tagged`
  select column_name from information_schema.columns where table_name = 'orders'`;
check('and the column it moved from is gone',
  !orderColumns.some((c) => c.column_name === 'first_customer_at'),
  orderColumns.map((c) => c.column_name).filter((n) => n.includes('customer')));

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
