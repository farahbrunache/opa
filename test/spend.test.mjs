import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { encrypt: seal } = await import('../lib/crypto.js');
const { keepRecord } = await import('../lib/calls.js');
const { clearDemo } = await import('../lib/demo.js');
const { costsNow } = await import('../lib/costs.js');

await tagged`insert into cost_lines (name, amount_cents, share_percent, every)
             values ('Drafting worker', 1, 100, 'draft-second')`;

async function demoOrder(reference) {
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_demo)
    values (${'h-' + reference}, ${'c-' + reference}, 700, 'wise', ${reference},
            'confirmed', true)
    returning id`;
  return Number(rows[0].id);
}

console.log('');
console.log('what was spent outlives the row');

const order = await demoOrder('DEMO9-KKKKK');
const callId = 'c-spend-' + order;
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${order}, ${callId}, ${seal('Agent: Hello.')})`;

await keepRecord(callId, seal(JSON.stringify({ call_cost: { combined_cost: 75 } })));

const ledgerAfterCall = await tagged`select kind, amount_cents, was_demo, order_id from spend`;
check('keeping a call record writes what it cost',
  ledgerAfterCall.length === 1 && Number(ledgerAfterCall[0].amount_cents) === 75
  && ledgerAfterCall[0].was_demo === true && Number(ledgerAfterCall[0].order_id) === order,
  ledgerAfterCall);

await keepRecord(callId, seal(JSON.stringify({ call_cost: { combined_cost: 75 } })));
check('the same record kept again does not charge twice',
  (await tagged`select count(*)::int as n from spend`)[0].n === 1);

await tagged`insert into drafts (order_id, slot, model, job_id, seconds, finished_at)
             values (${order}, 'A', 'm', ${'j-spend-' + order}, 30, now())`;
const { backfillSpend } = await import('../lib/spend.js');
await backfillSpend();
await backfillSpend();
const drafted = await tagged`select seconds from spend where kind = 'draft'`;
check('the backfill picks up a draft, once',
  drafted.length === 1 && Number(drafted[0].seconds) === 30, drafted);

const before = await costsNow();
check('the week counts it against the project, because nobody paid for it',
  Math.abs(before.lastSeven.runningTheProject - (0.75 + 0.3 + before.lastSeven.fixedShare)) < 1e-9,
  before.lastSeven);
check('and the eight-week table says the same about this week',
  Math.abs(before.weeks[0].runningTheProject - before.lastSeven.runningTheProject) < 1e-9,
  [before.weeks[0].runningTheProject, before.lastSeven.runningTheProject]);

const cleared = await clearDemo();
check('clearing the demo records takes the order', cleared.orders >= 1, cleared);
check('and the call and the draft go with it',
  (await tagged`select count(*)::int as n from calls where order_id = ${order}`)[0].n === 0
  && (await tagged`select count(*)::int as n from drafts where order_id = ${order}`)[0].n === 0);

const left = await tagged`select kind, amount_cents, seconds, order_id from spend order by kind`;
check('what it cost stays',
  left.length === 2 && Number(left[0].amount_cents) === 75 && Number(left[1].seconds) === 30,
  left);
check('with the link to the order dropped rather than the line',
  left.every((line) => line.order_id === null), left);

const after = await costsNow();
check('so the week costs the same after the tidy-up as before it',
  Math.abs(after.lastSeven.runningTheProject - before.lastSeven.runningTheProject) < 1e-9,
  [after.lastSeven.runningTheProject, before.lastSeven.runningTheProject]);
check('and the session that was never sold is off the count',
  after.lastSeven.demoSessions === 0, after.lastSeven.demoSessions);

const seeded = await demoOrder('DEMO8-JJJJJ');
const seededCall = 'c-seeded-' + seeded;
await tagged`insert into calls (order_id, call_id, transcript_encrypted)
             values (${seeded}, ${seededCall}, ${seal('Agent: Hello.')})`;
await keepRecord(seededCall, seal(JSON.stringify({ demo: true, call_cost: { combined_cost: 900 } })));
check('an invented cost is not written down',
  (await tagged`select count(*)::int as n from spend where kind = 'call'`)[0].n === 1);

{
  const { signSession } = await import('../lib/crypto.js');
  const { Readable } = await import('node:stream');
  const deskEndpoint = (await import('../api/desk.js')).default;

  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values ('h-mine-spend', 'c-mine-spend', 700, 'wise', 'RMINESPEND1', 'confirmed')
    returning id`;
  const bought = Number(rows[0].id);
  const boughtCall = 'c-mine-spend-' + bought;
  await tagged`insert into calls (order_id, call_id, transcript_encrypted)
               values (${bought}, ${boughtCall}, ${seal('Agent: Hello.')})`;
  await keepRecord(boughtCall, seal(JSON.stringify({ call_cost: { combined_cost: 90 } })));

  const asClient = await costsNow();
  check('a session nobody has marked costs what it costs to serve somebody',
    Math.abs(asClient.lastSeven.clientCalls - 0.9) < 1e-9, asClient.lastSeven.clientCalls);

  const stream = Readable.from([JSON.stringify({ id: bought })]);
  const req = {
    method: 'POST',
    url: '/api/desk?action=mine',
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end() { this.writableEnded = true; },
  };
  await deskEndpoint(req, res);
  check('marking it as the owner\'s own is accepted', res.statusCode === 200, res.statusCode);

  const asProject = await costsNow();
  check('what it already spent moves to the project',
    asProject.lastSeven.clientCalls === 0
    && Math.abs(asProject.lastSeven.projectCalls - (asClient.lastSeven.projectCalls + 0.9)) < 1e-9,
    [asProject.lastSeven.clientCalls, asProject.lastSeven.projectCalls]);
  check('and the week costs the same either way, because the money did not change',
    Math.abs(asProject.lastSeven.spent - asClient.lastSeven.spent) < 1e-9,
    [asProject.lastSeven.spent, asClient.lastSeven.spent]);

  await clearDemo();
  const kept = await tagged`select is_demo, is_mine from orders where id = ${bought}`;
  check('clearing demo records leaves your own test session',
    kept.length === 1 && kept[0].is_mine === true && kept[0].is_demo === false, kept);
  check('and its call', (await tagged`select 1 from calls where order_id = ${bought}`).length === 1);
}

console.log('a call line written in dollars, corrected once');
{
  await tagged`insert into spend (kind, source, amount_cents, at)
               values ('call', 'call:999999', 5814, now())`;
  const rerunSchema = async () => {
    db.useDatabase(tagged);
    await db.ensureSchema();
  };
  await rerunSchema();
  let [line] = await tagged`select source, amount_cents from spend where source like '%999999'`;
  check('a call line priced in dollars is divided by a hundred',
    line.source === 'voice:999999' && Number(line.amount_cents) === 58, line);
  await rerunSchema();
  [line] = await tagged`select source, amount_cents from spend where source like '%999999'`;
  check('and running the schema again leaves it alone', Number(line.amount_cents) === 58, line);
}

console.log('a session marked yours the old way');
{
  const [old] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_demo)
    values ('h-old', 'c-old', 700, 'wise', 'OLDMK-AAAAA', 'confirmed', true) returning id`;
  const seeded = await demoOrder('DEMO8-MMMMM');
  db.useDatabase(tagged);
  await db.ensureSchema();
  const [moved] = await tagged`select is_demo, is_mine from orders where id = ${old.id}`;
  check('it moves to its own mark', moved.is_mine === true && moved.is_demo === false, moved);
  const [left] = await tagged`select is_demo, is_mine from orders where id = ${seeded}`;
  check('and a demo row keeps the demo mark', left.is_demo === true && left.is_mine === false, left);
}

console.log('every charge');
{
  const { chargesOf } = await import('../lib/costs-items.js');
  const { VERDICT_DAYS } = await import('../lib/costs.js');
  await tagged`insert into cost_lines (name, amount_cents, share_percent, every)
               values ('Hosting', 700, 100, 'month')`;
  const figures = await costsNow();
  const rate = figures.lines.find((l) => l.every === 'draft-second');
  const charges = await chargesOf(VERDICT_DAYS, figures.lines, rate ? rate.costs : null);
  check('the itemized total is the thirty-day figure',
    Math.abs(charges.total - figures.verdict.spent) < 1e-9,
    [charges.total, figures.verdict.spent]);
  check('a call is a line of its own', charges.items.some((i) => i.what === 'Call'), charges.items);
  check('and so is a monthly bill',
    charges.items.some((i) => i.what === 'Hosting' && Math.abs(i.amount - 7) < 1e-9),
    charges.items);
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
