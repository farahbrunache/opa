import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();
process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { encrypt, signSession } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const { ordinal, waitingPayments } = await import('../lib/confirm-speed.js');
const { standingOf } = await import('../lib/session-decision.js');
const deskEndpoint = (await import('../api/desk.js')).default;

const cookie = `op_session=${signSession('admin-1')}`;
function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}
async function get(url) {
  const res = fakeRes();
  await deskEndpoint({ method: 'GET', url, headers: { cookie } }, res);
  return JSON.parse(res.body);
}
async function post(action, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = { method: 'POST', url: `/api/desk?action=${action}`, headers: { cookie, 'content-type': 'application/json' } };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = fakeRes();
  await deskEndpoint(req, res);
  return JSON.parse(res.body);
}

let n = 0;
async function order({ status = 'confirmed', caseId = null, account = null, hoursBack = 10 } = {}) {
  n += 1;
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, case_id, client_account_id, created_at)
    values (${'rs-h-' + n}, ${'rs-c-' + n}, 700, 'wise', ${'TESTR-' + String(n).padStart(4, '0')},
            ${status}, ${caseId}, ${account}, now() - make_interval(secs => ${hoursBack * 3600}))
    returning id`;
  return Number(row.id);
}
async function person(account, name) {
  const [row] = await tagged`
    insert into cases (account_id, name_encrypted) values (${account}, ${name ? encrypt(name) : null})
    returning id`;
  return Number(row.id);
}
async function called(id, kind = 'intake') {
  await tagged`insert into calls (order_id, call_id, kind, transcript_encrypted, started_at, ended_at)
               values (${id}, ${'rs-call-' + id}, ${kind}, ${encrypt('Invented words.')}, now(), now())`;
}
async function decide(id, decision, hoursBack) {
  await tagged`update orders set decision = ${decision},
                      decision_at = now() - make_interval(secs => ${hoursBack * 3600}),
                      approved_as_client_at = case when ${decision} = 'go' then now() end
                where id = ${id}`;
}

console.log('');
console.log('ordinals');
const expected = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th',
  '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th', '21st', '22nd', '23rd'];
check('1st to 23rd', expected.every((word, i) => ordinal(i + 1) === word),
  expected.map((_, i) => ordinal(i + 1)));
check('111th, 112th, 113th, 101st', ordinal(111) === '111th' && ordinal(112) === '112th'
  && ordinal(113) === '113th' && ordinal(101) === '101st');

console.log('the payment card');
const kade = await person('acct-rs-kade', 'Kade Testperson');
const first = await order({ caseId: kade, account: 'acct-rs-kade', hoursBack: 300 });
await order({ status: 'rejected', caseId: kade, account: 'acct-rs-kade', hoursBack: 200 });
const second = await order({ status: 'pending', caseId: kade, account: 'acct-rs-kade', hoursBack: 4 });
const nameless = await person('acct-rs-nameless', null);
const theirFirst = await order({ status: 'pending', caseId: nameless, account: 'acct-rs-nameless', hoursBack: 3 });
const stranger = await order({ status: 'pending', hoursBack: 2 });
const cards = (await waitingPayments()).rows;
const cardOf = (id) => cards.find((c) => c.id === id);
check('an attached payment carries the name', cardOf(second)?.name === 'Kade Testperson', cardOf(second));
check('and which session it is, a rejected payment not counted',
  cardOf(second)?.session === 2 && cardOf(second)?.repeat === '2nd session', cardOf(second));
check('a first session is linked with no marker',
  cardOf(theirFirst)?.linked === true && cardOf(theirFirst)?.repeat === null && cardOf(theirFirst)?.name === null,
  cardOf(theirFirst));
check('an unattached payment carries neither',
  cardOf(stranger)?.linked === false && cardOf(stranger)?.name === null && cardOf(stranger)?.repeat === null,
  cardOf(stranger));
check('the first, confirmed order is not a card', !cardOf(first));

console.log('a follow-up after a go');
const teo = await person('acct-rs-go', 'Teo Testperson');
const goFirst = await order({ caseId: teo, account: 'acct-rs-go', hoursBack: 400 });
await called(goFirst);
await decide(goFirst, 'go', 390);
await tagged`update orders set recommendations_encrypted = ${encrypt('One thing first.')},
                               recommendations_written_at = now() where id = ${goFirst}`;
const funnelBefore = (await get('/api/desk?action=funnel')).stages;
const goAgain = await order({ caseId: teo, account: 'acct-rs-go', hoursBack: 30 });
await called(goAgain, 'follow-up');

let today = await get('/api/desk?action=today');
check('not listed as a new call', !today.calls.some((r) => r.id === goAgain), today.calls);
check('listed as a follow-up call', today.followUps.some((r) => r.id === goAgain && r.caseId === teo), today.followUps);
check('and counted as one', today.totals.followUps === 1, today.totals);

let record = await get(`/api/desk?action=person&id=${goAgain}`);
check('the record stands under the earlier go', record.decision === 'go' && record.decisionInherited === true
  && record.followUp === true, record.decision);
check('dated from the earlier session',
  new Date(record.decidedAt).getTime() < Date.now() - 389 * 3_600_000, record.decidedAt);
const [own] = await tagged`select decision from orders where id = ${goAgain}`;
check('and nothing is written on the new order', own.decision === null, own);

async function tabsOf(caseId) {
  const found = [];
  for (const state of ['waiting', 'replies', 'active', 'closed']) {
    const page = await get(`/api/desk?action=queue&state=${state}`);
    for (const p of page.people) {
      const [row] = await tagged`select case_id from orders where id = ${p.id}`;
      if (Number(row.case_id) === caseId) found.push({ state, id: Number(p.id), followUp: p.followUp });
    }
  }
  return found;
}
let tabs = await tabsOf(teo);
check('one row on Everyone, in Working, as a follow-up',
  tabs.length === 1 && tabs[0].state === 'active' && tabs[0].id === goAgain && tabs[0].followUp === true, tabs);
const [firstRef] = await tagged`select reference_code from orders where id = ${goFirst}`;
const byFirst = await get(`/api/desk?action=queue&q=${encodeURIComponent(firstRef.reference_code)}`);
check("an earlier session's code finds the person", byFirst.people.some((p) => Number(p.id) === goAgain), byFirst.people);

const funnelAfter = (await get('/api/desk?action=funnel')).stages;
check('the funnel still counts the person once',
  JSON.stringify(funnelBefore.map((s) => s.count)) === JSON.stringify(funnelAfter.map((s) => s.count)),
  [funnelBefore, funnelAfter]);

check('the conversation reads as open on the follow-up', record.conversationOpen === true);
await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-rs-go', 'client', ${encrypt('Invented question.')})`;
tabs = await tabsOf(teo);
check('writing in puts them under Wrote to you', tabs.some((t) => t.state === 'replies'), tabs);
await tagged`delete from messages where account_id = 'acct-rs-go'`;

await post('recommend', { id: goAgain, body: 'Next, the second thing.' });
today = await get('/api/desk?action=today');
check('next steps written, it leaves Today', !today.followUps.some((r) => r.id === goAgain), today.followUps);
const [posted] = await tagged`select count(*)::int as n from messages
                              where account_id = 'acct-rs-go' and author = 'operator'`;
check('and the next steps are posted into the open conversation, as on a go', posted.n === 1, posted);

console.log('a follow-up after a no-go');
const odi = await person('acct-rs-nogo', 'Odi Testperson');
const noFirst = await order({ caseId: odi, account: 'acct-rs-nogo', hoursBack: 500 });
await called(noFirst);
await decide(noFirst, 'no-go', 480);
const noAgain = await order({ caseId: odi, account: 'acct-rs-nogo', hoursBack: 20 });
await called(noAgain, 'follow-up');

today = await get('/api/desk?action=today');
check('listed as a new call', today.calls.some((r) => r.id === noAgain), today.calls);
check('not as a follow-up call', !today.followUps.some((r) => r.id === noAgain));
record = await get(`/api/desk?action=person&id=${noAgain}`);
check('the record shows this session undecided', record.decision === null, record.decision);
check('with the earlier no-go as context', Boolean(record.earlierNoGoAt), record.earlierNoGoAt);
tabs = await tabsOf(odi);
check('one row on Everyone, in New calls', tabs.length === 1 && tabs[0].state === 'waiting'
  && tabs[0].id === noAgain, tabs);

await post('decide', { id: noAgain, decision: 'go' });
const decided = await tagged`select id, decision from orders where case_id = ${odi} order by id`;
check('the decision is recorded on the new session',
  decided[0].decision === 'no-go' && decided[1].decision === 'go', decided);
record = await get(`/api/desk?action=person&id=${noAgain}`);
check('and the record reads it as its own', record.decision === 'go' && record.decisionInherited === false);
tabs = await tabsOf(odi);
check('the person moves to Working, once', tabs.length === 1 && tabs[0].state === 'active', tabs);

console.log('the rule');
const s = (id, decision, called = true) => ({ id, decision, decision_at: decision ? `2026-01-0${id}` : null, called });
check('own decision wins', standingOf([s(1, 'go'), s(2, 'no-go')], 2).decision === 'no-go');
check('a later decision does not reach back to a called session',
  standingOf([s(1, null), s(2, 'go')], 1).decision === null);
check('an uncalled session shows the latest decision',
  standingOf([s(1, 'no-go'), s(2, null, false)], 2).decision === 'no-go');
check('the latest earlier decision decides, not the first',
  standingOf([s(1, 'go'), s(2, 'no-go'), s(3, null)], 3).decision === null
  && standingOf([s(1, 'no-go'), s(2, 'go'), s(3, null)], 3).followUp === true);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
