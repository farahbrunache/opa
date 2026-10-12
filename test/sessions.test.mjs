import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.PAY_WISE = 'invented-wisetag';
const { signSession } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const client = (await import('../api/client.js')).default;
const submit = (await import('../api/submit.js')).default;
const payments = (await import('../api/payments.js')).default;
const sessions = await import('../lib/sessions.js');
const costsApi = (await import('../api/costs.js')).default;

await db.ensureSchema();

async function ask(endpoint, account, method, url, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  try {
    await endpoint({ method, url,
      headers: { cookie: account ? `op_session=${signSession(account)}` : '', 'content-type': 'application/json' },
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  } catch (error) {
    return { status: error.status || 500, out: { error: error.message } };
  }
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
}
const owner = (method, action, payload) => ask(desk, 'admin-1', method, `/api/desk?action=${action}`, payload);
const person = async (id) => (await owner('GET', `person&id=${id}`)).out;

async function linkedGo(reference, account) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, approved_as_client_at)
    values (${`sh-${reference}`}, ${`sc-${reference}`}, 700, 'wise', ${reference}, 'confirmed', 'go', now())
    returning id`;
  const caseId = await db.caseForAccount(account);
  await tagged`update orders set client_account_id = ${account}, case_id = ${caseId} where id = ${row.id}`;
  return { order: Number(row.id), caseId };
}

console.log('');
console.log('the rates are settings');
check('with nothing set there are no rates', (await sessions.ratesNow()) === null);
const me = await linkedGo('RSESS000001', 'acct-sess-1');
check('and the client is told nothing is on sale yet',
  (await ask(client, 'acct-sess-1', 'GET', '/api/client?action=sessions')).out.rates === null);
check('a request is refused the same way',
  (await ask(client, 'acct-sess-1', 'POST', '/api/client?action=access-request')).status === 503);
const save = (payload) => ask(costsApi, 'admin-1', 'POST', '/api/costs?action=prices', payload);
check('a price that is not a number is refused, naming it',
  (await save({ standard: 'lots' })).status === 400 && (await save({ standard: 'lots' })).out.error.startsWith('The standard session'));
check('a count that is not whole is refused', (await save({ aMonth: '2.5' })).status === 400);
check('only the owner sets them', (await ask(costsApi, 'acct-sess-1', 'POST', '/api/costs?action=prices', { standard: 1 })).status === 403);
check('saved on Money', (await save({ standard: '100', access: '25', aMonth: '2' })).status === 200);
check('they read back', JSON.stringify(await sessions.ratesNow()) === JSON.stringify({ standard: 100, access: 25, aMonth: 2 }));
check('the month is the owner\'s clock, four hours behind UTC',
  sessions.monthOf('2026-11-01T02:00:00Z') === '2026-10' && sessions.monthOf('2026-11-01T05:00:00Z') === '2026-11');
check('the next month wraps the year', sessions.monthAfter('2026-12') === '2027-01');

console.log('requesting an access-rate session');
const card = (account) => ask(client, account, 'GET', '/api/client?action=sessions');
const request = (account) => ask(client, account, 'POST', '/api/client?action=access-request');
let shown = (await card('acct-sess-1')).out;
check('the card says how many are left this month', shown.access.left === 2 && shown.access.cap === 2 && shown.held.length === 0, shown);
let asked = await request('acct-sess-1');
check('a request while any are left is given at once', asked.status === 200 && asked.out.request.granted === true
  && asked.out.request.toPay === true && asked.out.access.left === 1, asked.out);
check('a second request while the first is unpaid is refused', (await request('acct-sess-1')).status === 409);
const other = await linkedGo('RSESS000002', 'acct-sess-2');
const third = await linkedGo('RSESS000003', 'acct-sess-3');
check('the second person takes the last one', (await request('acct-sess-2')).out.access.left === 0);
asked = await request('acct-sess-3');
check('the third goes on next month\'s list, in order', asked.status === 200 && asked.out.request.granted === false
  && asked.out.request.monthName === asked.out.access.nextMonthName, asked.out);
check('nobody is asked why', !JSON.stringify(asked.out).includes('reason'));

console.log('buying one');
const buy = (account, payload) => ask(submit, account, 'POST', '/api/submit', { method: 'wise', ...payload });
check('a session needs a rate it knows', (await buy('acct-sess-1', { session: 'cheap' })).status === 400);
check('and a signed-in buyer', (await buy(null, { session: 'standard' })).status === 401);
check('an access-rate buy needs a request that was given',
  (await buy('acct-sess-3', { session: 'access' })).status === 409);
const bought = await buy('acct-sess-1', { session: 'access' });
check('an access-rate order opens at the access price, with no claim link',
  bought.status === 201 && bought.out.price === 25 && bought.out.amount === 25 && bought.out.claim === null
  && bought.out.session === 'access', bought.out);
const standard = await buy('acct-sess-2', { session: 'standard' });
check('a standard one at the standard price', standard.status === 201 && standard.out.price === 100, standard.out);
check('a plain $7 order still works as before',
  (await buy(null, {})).out.price === 7 && (await buy(null, {})).out.claim.startsWith('/claim?t='));
const [pending] = await tagged`select id, kind, rate, case_id, client_account_id from orders where reference_code = ${bought.out.reference}`;
check('the order is a session on their case', pending.kind === 'session' && pending.rate === 'access'
  && Number(pending.case_id) === me.caseId && pending.client_account_id === 'acct-sess-1', pending);
shown = (await card('acct-sess-1')).out;
check('their card shows the payment being confirmed', shown.pending.length === 1 && shown.pending[0].rate === 'access', shown.pending);
let first = (await owner('GET', 'today')).out;
check('it is a payment to confirm on Today, named as a session',
  first.toConfirm.some((o) => o.id === Number(pending.id) && o.kind === 'session' && o.repeat === 'Session · Access rate'), first.toConfirm);

console.log('confirming puts it on the card');
const confirmed = await ask(payments, 'admin-1', 'POST', '/api/payments?action=decide', { id: Number(pending.id), decision: 'confirm' });
check('the confirm says a session was bought', confirmed.status === 200 && confirmed.out.bought === true, confirmed.out);
shown = (await card('acct-sess-1')).out;
check('the card has one hole, unused, at the access rate',
  shown.held.length === 1 && shown.held[0].usedAt === null && shown.held[0].rate === 'access' && shown.pending.length === 0, shown);
check('and no request is open any more', shown.request === null, shown.request);
const [standardPending] = await tagged`select id from orders where reference_code = ${standard.out.reference}`;
const declined = await ask(payments, 'admin-1', 'POST', '/api/payments?action=decide', { id: Number(standardPending.id), decision: 'reject', reason: 'not_received' });
check('a rejected one puts nothing on the card', declined.status === 200 && (await card('acct-sess-2')).out.held.length === 0);

console.log('using one for an activity');
let record = await person(me.order);
check('the desk sees the card and the month\'s count',
  record.sessions.held.length === 1 && record.sessions.access.given === 2 && record.sessions.access.left === 0
  && record.sessions.requests[0].orderStatus === 'confirmed', record.sessions);
check('with nothing on their page there is nothing to use it for',
  (await owner('POST', 'session-use', { id: me.order, activityId: 999999 })).status === 404);
await owner('POST', 'activity-add', { id: me.order, title: 'Invented activity' });
record = await person(me.order);
const activity = record.activities[0];
check('not for a drafted one', (await owner('POST', 'session-use', { id: me.order, activityId: activity.id })).status === 409);
await owner('POST', 'activity-move', { id: me.order, activityId: activity.id });
const used = await owner('POST', 'session-use', { id: me.order, activityId: activity.id });
check('one session is used for it', used.status === 200 && used.out.activity === 'Invented activity', used.out);
record = await person(me.order);
check('the card shows what it went to and at which rate',
  record.sessions.held[0].usedFor === 'Invented activity' && record.sessions.held[0].rate === 'access', record.sessions.held);
check('the activity counts it', record.activities[0].sessionsUsed === 1);
check('a second use finds nothing left', (await owner('POST', 'session-use', { id: me.order, activityId: activity.id })).status === 409);
shown = (await card('acct-sess-1')).out;
check('the client sees it used, by what it went to', shown.held[0].usedFor === 'Invented activity');

console.log('next month\'s list and the money line');
const list = (await ask(payments, 'admin-1', 'GET', '/api/payments?action=list')).out;
check('Money has the month\'s line', list.access.given === 2 && list.access.left === 0 && list.access.waiting === 1, list.access);
const [waiting] = await tagged`select id from access_requests where case_id = ${third.caseId}`;
await tagged`update access_requests set month = ${sessions.monthOf()} where id = ${waiting.id}`;
await tagged`update access_requests set granted_at = null, month = ${sessions.monthOf()} where id = ${waiting.id}`;
await tagged`delete from access_requests where case_id = ${other.caseId}`;
const granted = await sessions.grantDue();
check('when a place opens, the list is given to in order', granted === 1
  && (await card('acct-sess-3')).out.request.granted === true, granted);
const trail = (await tagged`select kind from case_events where order_id in (${me.order}, ${third.order}, ${Number(pending.id)})`).map((r) => r.kind);
check('every step is on the trail', ['access.requested', 'access.given', 'access.listed', 'session.bought', 'session.used']
  .every((k) => trail.includes(k)), trail);

console.log('the funnel and costs');
const funnel = (await owner('GET', 'funnel')).out;
check('a bought session counts as the last row of the funnel', funnel.stages.find((s) => s.key === 'done').count >= 1, funnel.stages);
const { costsNow } = await import('../lib/costs.js');
const costs = await costsNow();
check('and its money is counted apart from the $7 calls', costs.bought === 1 && costs.boughtIn === 25 && costs.tookIn >= 25, [costs.bought, costs.boughtIn]);

console.log('demo rows');
check('demo data seeds', (await owner('POST', 'demo-seed')).status === 201);
const [demoHeld] = await tagged`select count(*)::int as n from held_sessions where is_demo`;
check('with five sessions on the working client\'s card', demoHeld.n === 5, demoHeld);
check('and a session payment to confirm', (await owner('GET', 'today')).out.toConfirm.some((o) => o.kind === 'session' && o.isDemo));
check('demo data clears', (await owner('POST', 'demo-clear')).status === 200);
const [left] = await tagged`select count(*)::int as n from held_sessions where is_demo`;
check('taking the card with it', left.n === 0);
const [real] = await tagged`select count(*)::int as n from held_sessions where case_id = ${me.caseId}`;
check('and leaving a real one', real.n === 1);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
