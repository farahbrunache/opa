import { check, db, failureCount, seedPrompts, tagged, useSlot } from './harness.mjs';

await db.ensureSchema();
await seedPrompts();
const { caseForAccount } = db;

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const { encrypt: seal } = await import('../lib/crypto.js');
const deskEndpoint = (await import('../api/desk.js')).default;

async function newOrder(overrides = {}) {
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${'h-' + Math.random()}, ${'c-' + Math.random()}, 700, 'wise',
            ${'R' + Math.random().toString(36).slice(2, 11).toUpperCase()},
            ${overrides.status || 'confirmed'})
    returning id`;
  return Number(rows[0].id);
}

console.log('');
console.log('the first screen');

async function askToday() {
  const req = { method: 'GET', url: '/api/desk?action=today', headers: {
    cookie: `op_session=${signSession('admin-1')}`,
  } };
  let payload = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; try { payload = JSON.parse(text); } catch { payload = text; } },
  };
  await deskEndpoint(req, res);
  return payload;
}

const waitingCall = await newOrder();
await tagged`insert into calls (order_id, call_id, transcript_encrypted, ended_at)
             values (${waitingCall}, ${'c-today-' + waitingCall}, 'x', now() - interval '31 hours')`;

let screen = await askToday();
check('a call that came back and has no decision is waiting',
  screen.calls.some((c) => c.id === waitingCall), screen.calls.map((c) => c.id));
check('and it says how long it has been',
  screen.calls.find((c) => c.id === waitingCall).hoursWaiting > 30);

await tagged`update orders set decision = 'go', decision_at = now() where id = ${waitingCall}`;
screen = await askToday();
check('a decided call drops off',
  !screen.calls.some((c) => c.id === waitingCall), screen.calls.map((c) => c.id));

const wroteIn = await newOrder();
const wroteCase = await caseForAccount('acct-wrote-today');
await tagged`update orders set client_account_id = 'acct-wrote-today', case_id = ${wroteCase},
                               status = 'confirmed' where id = ${wroteIn}`;
await tagged`insert into messages (account_id, author, body_encrypted, created_at)
             values ('acct-wrote-today', 'client', 'x', now() - interval '5 hours')`;

screen = await askToday();
check('somebody who wrote and has not been opened is unread',
  screen.unread.some((u) => u.caseId === wroteCase), screen.unread.map((u) => u.caseId));

await tagged`update cases set messages_read_at = now() where id = ${wroteCase}`;
screen = await askToday();
check('opening it takes them off',
  !screen.unread.some((u) => u.caseId === wroteCase), screen.unread.map((u) => u.caseId));

await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-wrote-today', 'client', 'x')`;
screen = await askToday();
check('writing again puts them back', screen.unread.some((u) => u.caseId === wroteCase));

await tagged`update cases set blocked_at = now(), blocker_encrypted = 'x' where id = ${wroteCase}`;
screen = await askToday();
check('blocked comes off', !screen.unread.some((u) => u.caseId === wroteCase));

await tagged`update cases set blocked_until = now() - interval '1 hour' where id = ${wroteCase}`;
screen = await askToday();
check('a blocker past its date comes back', screen.unread.some((u) => u.caseId === wroteCase));
check('and it says it was blocked',
  screen.unread.find((u) => u.caseId === wroteCase).wasBlocked === true);

await tagged`update cases set blocked_until = null, blocked_at = now() - interval '2 days'
              where id = ${wroteCase}`;
screen = await askToday();
check('a blocker inside the window stays off', !screen.unread.some((u) => u.caseId === wroteCase));

await tagged`update cases set blocked_at = now() - interval '30 days' where id = ${wroteCase}`;
screen = await askToday();
check('a blocker that sat too long comes back on its own',
  screen.unread.some((u) => u.caseId === wroteCase));

console.log('');
console.log('demo records');

const { seedDemo, clearDemo } = await import('../lib/demo.js');

const realOrder = await newOrder();
const realCase = await caseForAccount('acct-real-person');
await tagged`update orders set client_account_id = 'acct-real-person', case_id = ${realCase}
              where id = ${realOrder}`;
await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-real-person', 'client', 'x')`;
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${realOrder}, 'c-real-person', 'x')`;

const made = await seedDemo();
check('seeding makes a row for every path the desk has', made.length >= 7, made.length);

const scenarios = made.filter((row) => /^DEMO\d/.test(row.reference)).length;
const marked = await tagged`select count(*)::int as n from orders where is_demo`;
check('every seeded order carries the mark', marked[0].n > scenarios,
  { orders: marked[0].n, scenarios });

const lines = await tagged`select count(*)::int as n from cost_lines`;
check('and no cost line is seeded: what it costs to run stays as the owner listed it',
  lines[0].n === 0, lines[0]);

const unmarked = await tagged`
  select count(*)::int as n from orders where id = ${realOrder} and is_demo = false`;
check('a real order is not marked', unmarked[0].n === 1);

screen = await askToday();
check('a seeded call past the target is on the first screen',
  screen.calls.some((c) => c.hoursWaiting > 24), screen.calls.map((c) => c.hoursWaiting));
check('and a seeded message is unread on it', screen.unread.length > 0);

const cleared = await clearDemo();
check('clearing removes every demo order', cleared.orders === marked[0].n, [cleared, marked[0]]);

const leftMarked = await tagged`select count(*)::int as n from orders where is_demo`;
check('and none are left', leftMarked[0].n === 0, leftMarked[0]);

const realLeft = await tagged`select count(*)::int as n from orders where id = ${realOrder}`;
check('the real order survives', realLeft[0].n === 1, realLeft[0]);
const realCaseLeft = await tagged`select count(*)::int as n from cases where id = ${realCase}`;
check('the real case survives', realCaseLeft[0].n === 1);
const realSaid = await tagged`
  select count(*)::int as n from messages where account_id = 'acct-real-person'`;
check('their messages survive', realSaid[0].n === 1, realSaid[0]);
const realCalls = await tagged`
  select count(*)::int as n from calls where order_id = ${realOrder}`;
check('their call survives', realCalls[0].n === 1);

const secondRun = await seedDemo();
check("seeding twice works", secondRun.length === made.length, secondRun.length);
await clearDemo();

console.log('');
console.log('a draft that was paid for');

const drafts = await import('../lib/desk-drafts.js');
const { costsNow } = await import('../lib/costs.js');

const drafted = await newOrder();
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${drafted}, ${'c-draft-' + drafted}, ${seal('Caller: I drive.')})`;
await tagged`insert into strategies (order_id, version, body_encrypted, takeaways_encrypted)
             values (${drafted}, 1, ${seal('Invented strategy.')}, ${seal('[]')})`;

let submitted = 0;
let polled = null;
globalThis.fetch = async (url) => {
  const path = String(url);
  let body;
  if (path.endsWith('/run')) {
    submitted += 1;
    body = { id: `job-${submitted}` };
  } else {
    polled = path.split('/status/')[1];
    body = { status: 'FAILED' };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

process.env.RUNPOD_API_KEY = 'not-a-real-key';
await useSlot('A', 'fake', 'llama-test');

async function pressDraft() {
  const { Readable } = await import('node:stream');
  const payload = JSON.stringify({ id: drafted });
  const stream = Readable.from([payload]);
  const req = {
    method: 'POST', url: '/api/desk?action=draft',
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  let out = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; try { out = JSON.parse(text); } catch { out = text; } },
  };
  try {
    await drafts.writeDraft(req, res);
  } catch (error) {
    return { thrown: error };
  }
  return { out };
}

const first = await pressDraft();
await (await import('../lib/draft-jobs.js')).settleAll();
const [gaveUp] = await tagged`select failure from drafts where order_id = ${drafted}`;
check('a draft the model fails is written down as a failure', !first.thrown && /failed/.test(gaveUp?.failure || ''),
  String(first.thrown?.message || JSON.stringify(gaveUp)));
check('the job was submitted once', submitted === 1, submitted);
check('and the job polled is the job submitted', polled === 'job-1', polled);

const rows = await tagged`select job_id, model, finished_at, gave_up_at from drafts
                           where order_id = ${drafted}`;
check('it is written down anyway, because it cost money',
  rows.length === 1 && rows[0].job_id === 'job-1', rows);
check('with the job named, so the next press can tell what it was',
  rows[0].model === 'llama-test', rows[0]);
check('marked given up rather than finished',
  rows[0].finished_at === null && rows[0].gave_up_at !== null, rows[0]);

console.log('');
console.log('what a session costs');

const costs = await import('../lib/costs.js');

check('a call record with a cost in it is read',
  costs.callCostOf(JSON.stringify({ call_cost: { combined_cost: 58.1 } })) === 0.581);
check('a record with no cost in it is unknown, not free',
  costs.callCostOf(JSON.stringify({ call_cost: {} })) === null);
check('and so is a record that is not readable',
  costs.callCostOf('not json') === null && costs.callCostOf(null) === null);

check('a finished draft uses the seconds it reported',
  costs.draftSeconds({ seconds: 12 }) === 12);
check('a given-up draft is timed from submit to giving up',
  costs.draftSeconds({
    seconds: null,
    created_at: '2026-10-01T00:00:00Z',
    gave_up_at: '2026-10-01T00:00:45Z',
  }) === 45);
check('a draft with neither is unknown',
  costs.draftSeconds({ seconds: null, created_at: null, gave_up_at: null }) === null);

const priced = costs.costOfOrder({
  id: 1, reference: 'X', isDemo: false, paid: true,
  calls: [{ record: JSON.stringify({ call_cost: { combined_cost: 50 } }), hasRecord: true }],
  drafts: [{ seconds: 10 }],
}, 0.01);
check('a session adds its call and its drafting against the seven',
  priced.calls === 0.5 && priced.drafts === 0.1 && priced.spent === 0.6
  && priced.tookIn === 7 && Math.abs(priced.left - 6.4) < 1e-9, priced);
check('and nothing is unknown when both are known', priced.unknown.length === 0, priced.unknown);

const missing = costs.costOfOrder({
  id: 2, reference: 'Y', isDemo: false, paid: true,
  calls: [{ record: null, hasRecord: false }],
  drafts: [{ seconds: 30 }],
}, null);
check('a call with no record kept is named, not counted as free',
  missing.calls === 0 && missing.unknown.some((line) => /no record kept/.test(line)),
  missing.unknown);
check('and unpriced drafting says how many seconds went unpriced',
  missing.drafts === 0 && missing.draftedSeconds === 30
  && missing.unknown.some((line) => /30 seconds/.test(line)), missing.unknown);

const unpaid = costs.costOfOrder({
  id: 3, reference: 'Z', isDemo: false, paid: false, calls: [], drafts: [],
}, 0.01);
check('an unpaid order took in nothing', unpaid.tookIn === 0 && unpaid.left === 0, unpaid);

await tagged`insert into cost_lines (name, amount_cents, share_percent, every)
             values ('Drafting worker', 1, 100, 'draft-second')`;

const costed = await newOrder();
await tagged`insert into calls (order_id, call_id, transcript_encrypted, record_encrypted)
             values (${costed}, ${'c-cost-' + costed}, ${seal('x')},
                     ${seal(JSON.stringify({ call_cost: { combined_cost: 58.1 } }))})`;
await tagged`insert into drafts (order_id, slot, model, job_id, seconds, finished_at)
             values (${costed}, 'A', 'm', 'j-cost', 20, now())`;

const now = await costsNow();
const mine = now.orders.find((o) => o.id === costed);
check('the screen prices a real order from the database',
  Math.abs(mine.spent - (0.581 + 0.2)) < 1e-9, mine);
check('it says nothing is listed monthly rather than counting it as nothing',
  now.monthlyFixed === null
  && now.unknown.some((line) => /Nothing is listed as a monthly cost/.test(line)), now.unknown);

check('a line shared three ways carries a third of its price',
  Math.abs(costs.lineCost({ amount_cents: 10000, share_percent: 33 }) - 33) < 1e-9);
check('a line with no share carries all of it',
  costs.lineCost({ amount_cents: 2500, share_percent: 100 }) === 25);

await tagged`insert into cost_lines (name, amount_cents, share_percent, every)
             values ('Render', 2500, 100, 'month'), ('Claude Code', 10000, 33, 'month')`;
const withLines = await costsNow();
check('the monthly total adds the shares rather than the full prices',
  Math.abs(withLines.monthlyFixed - (25 + 33)) < 1e-9, withLines.monthlyFixed);
check('the window is seven days wide',
  withLines.lastSeven.days === 7 && typeof withLines.lastSeven.left === 'number',
  withLines.lastSeven);
check('a monthly bill is spread across those seven days rather than landed at once',
  Math.abs(withLines.lastSeven.fixedShare - (withLines.monthlyFixed * 7) / 30) < 1e-9,
  [withLines.lastSeven.fixedShare, withLines.monthlyFixed]);

const demoOrder = await newOrder();
await tagged`update orders set is_demo = true where id = ${demoOrder}`;
await tagged`insert into calls (order_id, call_id, transcript_encrypted, record_encrypted)
             values (${demoOrder}, ${'c-demo-' + demoOrder}, ${seal('x')},
                     ${seal(JSON.stringify({ call_cost: { combined_cost: 40 } }))})`;

const withDemo = await costsNow();
const demoRow = withDemo.orders.find((o) => o.id === demoOrder);
check('a demo session shows its seven and counts none of it',
  demoRow.tookIn === 7 && demoRow.counted === 0, demoRow);

check('an invented call cost is not a cost',
  costs.callCostOf(JSON.stringify({ demo: true, call_cost: { combined_cost: 58 } })) === null);
check('and a real one still is',
  costs.callCostOf(JSON.stringify({ call_cost: { combined_cost: 58 } })) === 0.58);
check('an invented record is known to be one',
  costs.isSeededRecord(JSON.stringify({ demo: true })) === true
  && costs.isSeededRecord(JSON.stringify({ call_cost: {} })) === false);
check('and what it cost is counted against the project',
  Math.abs(withDemo.demoSpent - 0.4) < 1e-9 && withDemo.demoSessions === 1,
  { demoSpent: withDemo.demoSpent, demoSessions: withDemo.demoSessions });
const pattern = await costsNow();
check('eight weeks come back, newest first',
  pattern.weeks.length === 8 && pattern.weeks[0].endedDaysAgo === 0
  && pattern.weeks[7].endedDaysAgo === 49, pattern.weeks.map((w) => w.endedDaysAgo));
check('the newest week matches the seven-day window it repeats',
  Math.abs(pattern.weeks[0].tookIn - pattern.lastSeven.tookIn) < 1e-9,
  [pattern.weeks[0].tookIn, pattern.lastSeven.tookIn]);
check('a monthly bill lands on every week, because it was owed in every one',
  pattern.weeks.every((w) => Math.abs(w.fixedShare - pattern.weeks[0].fixedShare) < 1e-9),
  pattern.weeks.map((w) => w.fixedShare));
check('and a week with nothing in it is still short by what the bills cost',
  pattern.weeks[7].tookIn === 0 && pattern.weeks[7].left < 0, pattern.weeks[7]);

check('it is not in what serving clients cost',
  Math.abs(withDemo.spent - withLines.spent) < 1e-9,
  [withDemo.spent, withLines.spent]);
check('and the seven dollars is what a session took in', now.sessionPrice === 7);

{
  const bought = await newOrder();
  await tagged`insert into calls (order_id, call_id, transcript_encrypted, record_encrypted)
               values (${bought}, ${'c-mine-' + bought}, ${seal('x')},
                       ${seal(JSON.stringify({ call_cost: { combined_cost: 90 } }))})`;

  async function pressMine(orderIdValue) {
    const { Readable } = await import('node:stream');
    const stream = Readable.from([JSON.stringify({ id: orderIdValue })]);
    const req = {
      method: 'POST', url: '/api/desk?action=mine',
      headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
    };
    Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
    const res = {
      statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
      end() { this.writableEnded = true; },
    };
    try {
      await deskEndpoint(req, res);
      return res.statusCode;
    } catch (error) {
      return error.status;
    }
  }

  const before = (await costsNow()).orders.find((o) => o.id === bought);
  check('before marking, a real session counts its seven',
    before.counted === 7 && before.isDemo === false, before);

  check('marking it is accepted', (await pressMine(bought)) === 200);

  const nowMine = await costsNow();
  const marked = nowMine.orders.find((o) => o.id === bought);
  check('after marking, the seven shows and counts nothing',
    marked.tookIn === 7 && marked.counted === 0 && marked.isMine === true
    && marked.isDemo === false, marked);
  check('and the real call it made still costs what it cost',
    Math.abs(marked.calls - 0.9) < 1e-9, marked.calls);
  check('counted against the project rather than against a client',
    nowMine.demoSpent >= 0.9, nowMine.demoSpent);

  check('marking it twice is refused', (await pressMine(bought)) === 409);
}

{
  const closes = costs.whatClosesTheGap(
    { left: -50, sessions: 4, servingClients: 2, days: 30 }, 7, 90);
  check('the gap is stated in sessions and money a month',
    closes.short === 50 && closes.sessions === 8
    && Math.abs(closes.perMonth - 50) < 1e-9, closes);
  check('a session counts for what is left of the seven after serving somebody',
    Math.abs(closes.perSessionLeft - 6.5) < 1e-9, closes.perSessionLeft);
  check('with nothing served, the sessions figure is left out rather than guessed',
    costs.whatClosesTheGap({ left: -50, sessions: 0, servingClients: 0, days: 30 }, 7, 90)
      .sessions === null);
  check('and being ahead closes no gap',
    costs.whatClosesTheGap({ left: 10, sessions: 4, servingClients: 2, days: 30 }, 7, 90) === null);
}

console.log('');
console.log('blocked, and closed');
{
  const state = await import('../lib/desk-state.js');

  async function press(action, body) {
    const { Readable } = await import('node:stream');
    const stream = Readable.from([JSON.stringify(body)]);
    const req = {
      method: 'POST', url: `/api/desk?action=${action}`,
      headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
    };
    Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
    let out = null;
    const res = {
      statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
      end(text) { this.writableEnded = true; try { out = JSON.parse(text); } catch { out = text; } },
    };
    try {
      await state[action](req, res);
      return { status: res.statusCode, out };
    } catch (error) {
      return { status: error.status, message: error.message };
    }
  }

  const held = await newOrder();
  await tagged`insert into calls (order_id, call_id, transcript_encrypted)
               values (${held}, ${'c-held-' + held}, ${seal('x')})`;
  const heldCase = await db.caseForAccount('acct-held');
  await tagged`update orders set client_account_id = 'acct-held', case_id = ${heldCase},
                                 decision = 'go', approved_as_client_at = now()
                where id = ${held}`;

  check('a blocker needs a reason', (await press('block', { id: held })).status === 400);
  check('and a date that has passed is refused',
    (await press('block', { id: held, reason: 'x', until: '2020-01-01' })).status === 400);

  check('blocking it is accepted',
    (await press('block', { id: held, reason: 'The licensing board answering.' })).status === 200);
  let row = (await tagged`select blocked_at, blocked_until, blocker_encrypted, closed_at
                            from cases where id = ${heldCase}`)[0];
  check('it is marked, with no date, and the reason is kept',
    row.blocked_at !== null && row.blocked_until === null
    && row.blocker_encrypted !== null, row);

  check('unblocking it is accepted', (await press('unblock', { id: held })).status === 200);
  row = (await tagged`select blocked_at, blocker_encrypted from cases where id = ${heldCase}`)[0];
  check('and nothing is left behind',
    row.blocked_at === null && row.blocker_encrypted === null, row);
  check('unblocking twice is refused', (await press('unblock', { id: held })).status === 409);

  check('closing it is accepted', (await press('close', { id: held })).out.closed === true);
  row = (await tagged`select closed_at from cases where id = ${heldCase}`)[0];
  check('it is marked closed', row.closed_at !== null, row);

  async function ask(url) {
    const req = { method: 'GET', url, headers: { cookie: `op_session=${signSession('admin-1')}` } };
    let out = null;
    const res = {
      statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
      end(text) { this.writableEnded = true; try { out = JSON.parse(text); } catch { out = text; } },
    };
    await deskEndpoint(req, res);
    return out;
  }

  const stillOpen = await ask(`/api/desk?action=person&id=${held}`);
  check('the conversation is still open on a closed case',
    stillOpen.conversationOpen === true && stillOpen.closedAt !== null, stillOpen.closedAt);

  const client = (await import('../api/client.js')).default;
  const { Readable } = await import('node:stream');
  const wrote = Readable.from([JSON.stringify({ body: 'One more thing.' })]);
  const req = {
    method: 'POST', url: '/api/client?action=send',
    headers: { cookie: `op_session=${signSession('acct-held')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: wrote[Symbol.asyncIterator].bind(wrote) });
  let said = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; said = text; },
  };
  await client(req, res);
  check('they could write in', res.statusCode === 200, [res.statusCode, String(said).slice(0, 160)]);
  row = (await tagged`select closed_at from cases where id = ${heldCase}`)[0];
  check('a message from them opens it again', row.closed_at === null, row);

  check('reopening it by hand works too', (await press('close', { id: held })).out.closed === true);
  const closedTab = await ask('/api/desk?action=queue&state=closed&page=1');
  check('the closed tab shows what was closed',
    closedTab.people.some((person) => Number(person.id) === held),
    closedTab.people.map((p) => Number(p.id)));
  const working = await ask('/api/desk?action=queue&state=active&page=1');
  check('and it is off the working tab',
    !working.people.some((person) => Number(person.id) === held),
    working.people.map((p) => Number(p.id)));
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
