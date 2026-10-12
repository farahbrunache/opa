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

async function press(action, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST',
    url: `/api/desk?action=${action}`,
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

async function ask(url) {
  const req = { method: 'GET', url, headers: { cookie: `op_session=${signSession('admin-1')}` } };
  const res = fakeRes();
  await deskEndpoint(req, res);
  return JSON.parse(res.body);
}

const account = 'acct-payments-1';
const rows = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision, client_account_id)
  values ('h-pay', 'c-pay', 700, 'wise', 'RPAY000001', 'confirmed', 'go', ${account})
  returning id`;
const order = Number(rows[0].id);
await tagged`update orders set case_id = ${await db.caseForAccount(account)} where id = ${order}`;

async function newQuote(cents, status = 'agreed') {
  const made = await tagged`
    insert into quotes (account_id, amount_cents, scope_encrypted, status, answered_at)
    values (${account}, ${cents}, ${encrypt('Price the two bathrooms.')}, ${status}, now())
    returning id`;
  return Number(made[0].id);
}

console.log('');
console.log('what a quote was actually paid');

const full = await newQuote(40000);

check('a quote belonging to somebody else is not reachable',
  (await press('quote-due', { id: order, quoteId: full + 9999, dueAt: '2026-11-01' })).status === 404);
check('a date that is not a date is refused',
  (await press('quote-due', { id: order, quoteId: full, dueAt: 'next tuesday' })).status === 400);
check('setting a date is accepted',
  (await press('quote-due', { id: order, quoteId: full, dueAt: '2026-11-01' })).status === 200);
check('and clearing it is a real answer rather than an error',
  (await press('quote-due', { id: order, quoteId: full, dueAt: '' })).out.dueAt === null);

check('an amount is needed', (await press('quote-paid', { id: order, quoteId: full })).status === 400);
check('paying it in full is accepted',
  (await press('quote-paid', { id: order, quoteId: full, amount: 400 })).status === 200);

let person = await ask(`/api/desk?action=person&id=${order}`);
let quote = person.quotes.find((q) => q.id === full);
check('the record carries what arrived and when',
  quote.paid === 400 && quote.paidAt !== null && quote.status === 'paid', quote);
check('and nothing is owed on it', quote.late === false);

const short = await newQuote(40000);
const refused = await press('quote-paid', { id: order, quoteId: short, amount: 300 });
check('less than quoted without a reason is refused', refused.status === 400, refused);
const said = refused.message || refused.out?.error || '';
check('and the refusal says what was quoted', /400\.00/.test(said), said);

const settled = await press('quote-paid', {
  id: order, quoteId: short, amount: 300, discount: 'Took 100 off because he paid the same week.',
});
check('with a reason it is accepted', settled.status === 200, settled);
check('and it says how far short it came', settled.out.shortBy === 10000, settled.out);

person = await ask(`/api/desk?action=person&id=${order}`);
quote = person.quotes.find((q) => q.id === short);
check('the record keeps what arrived, not what was quoted',
  quote.paid === 300 && quote.amount === 400, [quote.paid, quote.amount]);
check('and the reason stays beside it',
  /paid the same week/.test(quote.discount || ''), quote.discount);

const over = await newQuote(10000);
check('more than quoted needs no reason',
  (await press('quote-paid', { id: order, quoteId: over, amount: 150 })).status === 200);

const owed = await newQuote(25000);
await tagged`update quotes set due_at = now() - interval '3 days' where id = ${owed}`;

person = await ask(`/api/desk?action=person&id=${order}`);
quote = person.quotes.find((q) => q.id === owed);
check('an agreed quote past its date reads as owed', quote.late === true, quote);

const today = await ask('/api/desk?action=today');
check('and it is on the first screen',
  today.late.some((r) => Number(r.quoteId) === owed), today.late);
check('with what is owed and when it was due, so nothing has to be opened to find out',
  today.late.find((r) => Number(r.quoteId) === owed).amount === 250
  && today.late.find((r) => Number(r.quoteId) === owed).dueAt !== null, today.late);

const offered = await newQuote(50000, 'offered');
await tagged`update quotes set due_at = now() - interval '3 days' where id = ${offered}`;
const after = await ask('/api/desk?action=today');
check('a quote nobody agreed to is never owed',
  !after.late.some((r) => Number(r.quoteId) === offered), after.late);

await press('quote-paid', { id: order, quoteId: owed, amount: 250 });
const paid = await ask('/api/desk?action=today');
check('paying it takes it off', !paid.late.some((r) => Number(r.quoteId) === owed), paid.late);

const trail = (await ask(`/api/desk?action=person&id=${order}`)).events.map((e) => e.kind);
check('dating and paying are both lines on the record',
  trail.includes('quote.due') && trail.includes('quote.paid'), trail);

{
  const paymentsEndpoint = (await import('../api/payments.js')).default;
  const [made] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values ('h-own', 'c-own', 700, 'wise', 'ROWNA-BCDEF', 'confirmed')
    returning id`;
  const own = Number(made.id);
  async function listed() {
    const req = {
      method: 'GET', url: '/api/payments?action=history&q=ROWNA-BCDEF',
      headers: { cookie: `op_session=${signSession('admin-1')}` },
    };
    const res = fakeRes();
    await paymentsEndpoint(req, res);
    return JSON.parse(res.body).orders.find((o) => Number(o.id) === own);
  }
  check('a payment nobody started is listed as a client\'s', (await listed()).isMine === false);
  check('marking one with no person behind it is accepted',
    (await press('mine', { id: own })).status === 200);
  check('and the payments list then shows it as yours', (await listed()).isMine === true);
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
