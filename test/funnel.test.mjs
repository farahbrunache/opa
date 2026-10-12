import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;

function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null,
    setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}

const cookie = () => `op_session=${signSession('admin-1')}`;

async function read() {
  const res = fakeRes();
  await deskEndpoint({ method: 'GET', url: '/api/desk?action=funnel', headers: { cookie: cookie() } }, res);
  return JSON.parse(res.body);
}

async function write(payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST',
    url: '/api/desk?action=funnel-pool',
    headers: { cookie: cookie(), 'content-type': 'application/json' },
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

const row = (data, key) => data.stages.find((s) => s.key === key);
const keys = (data) => data.stages.map((s) => [s.key, s.count]);

console.log('');
console.log('the funnel');

let data = await read();
check('the stages run approached, paid, call, go, done',
  data.stages.map((s) => s.key).join(',') === 'pool,paid,called,go,done', keys(data));
check('the approached figure is absent rather than zero', row(data, 'pool').count === null,
  row(data, 'pool'));
check('and it says it is typed', row(data, 'pool').entered === true);
check('the row under an absent one has no rate', row(data, 'paid').rate === null,
  row(data, 'paid'));

const made = await tagged`insert into cases (account_id) values ('acct-funnel') returning id`;
const caseId = Number(made[0].id);
const orders = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, case_id, client_account_id)
  values ('h-fn', 'c-fn', 700, 'wise', 'FUNNEL0001', 'confirmed', ${caseId}, 'acct-funnel')
  returning id`;
const id = Number(orders[0].id);
data = await read();
check('paying puts somebody in the funnel', row(data, 'paid').count === 1, keys(data));
check('with no call yet', row(data, 'called').count === 0, keys(data));

await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${id}, 'c-fn-1', ${encrypt('Agent: What do you do?\nCaller: I paint.')})`;
data = await read();
check('a call shows', row(data, 'called').count === 1 && row(data, 'called').rate === 100,
  keys(data));
check('no go yet', row(data, 'go').count === 0, keys(data));

await tagged`update orders set decision = 'go' where id = ${id}`;
await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, case_id, client_account_id, kind, rate)
  values ('h-fn-s', 'c-fn-s', 10000, 'wise', 'FUNNELSESS', 'pending', ${caseId}, 'acct-funnel', 'session', 'standard')`;
data = await read();
check('a go shows', row(data, 'go').count === 1, keys(data));
check('a session paid for but not yet confirmed is not the last row', row(data, 'done').count === 0,
  keys(data));

await tagged`insert into held_sessions (case_id, rate) values (${caseId}, 'standard')`;
data = await read();
check('a session on the card is the last row', row(data, 'done').count === 1, keys(data));

{
  const before = row(data, 'paid').count;
  await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_mine)
    values ('h-fnm', 'c-fnm', 700, 'wise', 'FUNNELMINE', 'confirmed', true)`;
  data = await read();
  check('an order marked as yours is not in the funnel', row(data, 'paid').count === before, keys(data));
  const [demo] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_demo)
    values ('h-fnd', 'c-fnd', 700, 'wise', 'DEMOFUNNEL', 'confirmed', true)
    returning id`;
  data = await read();
  check('a demo order is', row(data, 'paid').count === before + 1, keys(data));
  await tagged`delete from orders where id = ${demo.id}`;
  data = await read();
}

const other = await tagged`insert into cases (account_id) values ('acct-nocall') returning id`;
const otherCase = Number(other[0].id);
await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, case_id, client_account_id)
  values ('h-fn2', 'c-fn2', 700, 'wise', 'FUNNEL0002', 'confirmed', ${otherCase}, 'acct-nocall')`;
await tagged`insert into held_sessions (case_id, rate) values (${otherCase}, 'access')`;
data = await read();
check('a session bought without a call record counts on the call row',
  row(data, 'called').count === 2, keys(data));
check('and on the go row', row(data, 'go').count === 2, keys(data));
check('and on the last row', row(data, 'done').count === 2, keys(data));
check('every row is a subset of the one above it',
  data.stages.slice(1).every((s, i) => i === 0 || s.count <= data.stages[i].count), keys(data));

const third = await tagged`insert into cases (account_id) values ('acct-worked') returning id`;
const thirdCase = Number(third[0].id);
const [thirdOrder] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, case_id)
  values ('h-fn4', 'c-fn4', 700, 'wise', 'FUNNEL0004', 'confirmed', ${thirdCase})
  returning id`;
const [plan] = await tagged`
  insert into plans (order_id, case_id, path) values (${thirdOrder.id}, ${thirdCase}, 'smallest')
  returning id`;
await tagged`insert into activities (case_id, plan_id, position, title_encrypted, state, closed_at)
             values (${thirdCase}, ${plan.id}, 1, ${encrypt('Ask three people')}, 'done', now())`;
data = await read();
check('an activity done is not the last row by itself', row(data, 'done').count === 2,
  keys(data));

async function press(payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST', url: '/api/desk?action=recommendation-done',
    headers: { cookie: cookie(), 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = fakeRes();
  try {
    await deskEndpoint(req, res);
    return res.statusCode;
  } catch (error) {
    return error.status || 500;
  }
}
check('pressing the button is accepted', (await press({ id: Number(thirdOrder.id) })) === 200);
data = await read();
check('and it is the last row', row(data, 'done').count === 3, keys(data));
check('it can be taken back', (await press({ id: Number(thirdOrder.id), done: false })) === 200);
data = await read();
check('and the row drops again', row(data, 'done').count === 2, keys(data));
await press({ id: Number(thirdOrder.id) });
const trail = await tagged`select kind from case_events where order_id = ${thirdOrder.id}`;
check('each press lands on the trail',
  trail.filter((e) => e.kind === 'recommendation-done').length === 3, trail);

const second = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, case_id, client_account_id)
  values ('h-fn3', 'c-fn3', 700, 'wise', 'FUNNEL0003', 'confirmed', ${caseId}, 'acct-funnel')
  returning id`;
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${Number(second[0].id)}, 'c-fn-2', ${encrypt('Agent: Again.')})`;
data = await read();
check('somebody who bought twice counts once', row(data, 'paid').count === 3, keys(data));

const set = await write({ pool: '170' });
check('the figure saves', set.status === 200 && set.out.total === 170, set);
data = await read();
check('and it reads back on the chart', row(data, 'pool').count === 170);
check('the paid row now has a rate against it', row(data, 'paid').rate === 2, row(data, 'paid'));

const bad = await write({ pool: '12 people' });
check('anything but digits is refused', bad.status === 400, bad);
check('and it says what to type',
  /digits/.test(bad.message || bad.out?.error || ''), bad.message || bad.out?.error);
data = await read();
check('the refusal changed nothing', row(data, 'pool').count === 170);

const cleared = await write({ pool: '' });
check('empty takes the row off', cleared.status === 200 && cleared.out.total === null, cleared);
data = await read();
check('and it is absent again rather than zero', row(data, 'pool').count === null);

console.log('the +1');
const tapsNow = async () => (await tagged`select id from approach_taps order by id`).map((r) => Number(r.id));
let added = await write({ add: 1 });
check('a tap on an empty figure starts it at one', added.out.total === 1 && added.out.week === 1, added);
check('and says which tap it was, with its time', added.out.tap?.id > 0 && Boolean(added.out.tap?.at), added);
await write({ pool: '170' });
const tapOne = await write({ add: 1 });
const tapTwo = await write({ add: 1 });
check('each tap goes up by one from the typed figure', tapTwo.out.total === 172, tapTwo);
check('this week counts every tap, before the fix too', tapTwo.out.week === 3, tapTwo);
check('and the funnel reads the same total', row(await read(), 'pool').count === 172);

const undone = await write({ undo: tapOne.out.tap.id });
check('undo takes one off', undone.status === 200 && undone.out.total === 171, undone);
const left = await tapsNow();
check('undo removes exactly that tap and leaves the next one',
  !left.includes(tapOne.out.tap.id) && left.includes(tapTwo.out.tap.id), left);
check('undoing the same tap twice is refused', (await write({ undo: tapOne.out.tap.id })).status === 404);
check('undo needs a tap number', (await write({ undo: 'last' })).status === 400);

const [old] = await tagged`insert into approach_taps (at) values (now() - interval '10 days') returning id`;
let state = await write({ add: 1 });
check('a tap older than seven days is not this week', state.out.week === 3, state);
check('a tap from before the fix is not added to the total twice', state.out.total === 172, state);
check('an old tap cannot be undone', (await write({ undo: Number(old.id) })).status === 404);

const fixed = await write({ pool: '200' });
check('fix count sets the total', fixed.out.total === 200, fixed);
check('and leaves this week alone, because the taps were real', fixed.out.week === 3, fixed);
state = await write({ add: 1 });
check('a tap after the fix adds to the fixed figure', state.out.total === 201, state);
check('only one at a time', (await write({ add: 5 })).status === 400);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
