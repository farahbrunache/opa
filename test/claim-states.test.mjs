import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

const { signSession, encrypt, keyedHash } = await import('../lib/crypto.js');
const status = (await import('../api/status.js')).default;
const client = (await import('../api/client.js')).default;
const { seedDemo, clearDemo } = await import('../lib/demo.js');
await db.ensureSchema();

async function ask(endpoint, method, url, account, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' };
  if (account) headers.cookie = `op_session=${signSession(account)}`;
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  await endpoint({ method, url, headers,
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
}
const lookUp = (token) => ask(status, 'GET', `/api/status?t=${token}`);

async function order(reference, token, { method = 'wise', state = 'confirmed' } = {}) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${keyedHash(token)}, ${`cc-${reference}`}, 700, ${method}, ${reference}, ${state})
    returning id`;
  return Number(row.id);
}

console.log('the claim page: what is left to start with');
{
  await order('TESTA-AAAAA', 'tok-fresh');
  let r = await lookUp('tok-fresh');
  check('a fresh order has 3 starts and 30 minutes', r.out.startsLeft === 3 && r.out.minutesLeft === 30, r.out);
  check('and says it was paid by Wise', r.out.method === 'wise', r.out);

  const dropped = await order('TESTB-BBBBB', 'tok-dropped');
  await tagged`insert into calls (order_id, call_id, seconds, started_at, ended_at)
               values (${dropped}, 'c-dropped', 702, now() - interval '20 minutes', now() - interval '8 minutes')`;
  r = await lookUp('tok-dropped');
  check('a call that dropped at 11:42 leaves 2 starts and 23 minutes',
    r.out.status === 'confirmed' && r.out.startsLeft === 2 && r.out.minutesLeft === 23, r.out);

  const held = await order('TESTC-CCCCC', 'tok-held');
  await tagged`insert into calls (order_id, call_id, seconds, transcript_encrypted, started_at)
               values (${held}, 'c-held', 840, ${encrypt('Invented words.')}, now() - interval '2 hours')`;
  r = await lookUp('tok-held');
  check('a call that came back spends the order', r.out.status === 'used', r.out);
  check('and the page is told when and how long', r.out.callSeconds === 840 && Boolean(r.out.calledAt), r.out);
  check('starts are only said while it can start', r.out.startsLeft === undefined, r.out);

  await order('TESTD-DDDDD', 'tok-card', { method: 'amazon', state: 'pending' });
  r = await lookUp('tok-card');
  check('a gift card waiting says so, with no Wise details', r.out.method === 'amazon' && !r.out.payTo, r.out);

  const refused = await order('TESTE-EEEEE', 'tok-refused', { state: 'rejected' });
  await tagged`update orders set reject_reason = 'not_received' where id = ${refused}`;
  r = await lookUp('tok-refused');
  check('a rejection gives its reason in words', /No \$7 payment arrived/.test(r.out.reason), r.out);
}

console.log('the client page: each session as the list draws it');
{
  const account = 'acct-claim-states';
  const caseId = await db.caseForAccount(account);
  const first = await order('TESTF-FFFFF', 'tok-f');
  const second = await order('TESTG-GGGGG', 'tok-g');
  const third = await order('TESTH-HHHHH', 'tok-h');
  await tagged`update orders set client_account_id = ${account}, case_id = ${caseId}
                where id = any(${[first, second, third]}::bigint[])`;
  await tagged`update orders set created_at = now() - interval '3 days' where id = ${first}`;
  await tagged`update orders set created_at = now() - interval '2 days' where id = ${second}`;
  await tagged`insert into calls (order_id, call_id, kind, seconds, transcript_encrypted, started_at)
               values (${first}, 'c-f', 'intake', 900, ${encrypt('Invented.')}, now() - interval '70 hours')`;
  await tagged`insert into calls (order_id, call_id, kind, seconds, started_at)
               values (${second}, 'c-g', 'follow-up', 0, now() - interval '40 hours')`;
  const r = await ask(client, 'GET', '/api/client?action=mine', account);
  const by = Object.fromEntries(r.out.sessions.map((s) => [s.reference, s]));
  check('a call that came back is said with its length and kind',
    by['TESTF-FFFFF'].hasTranscript && by['TESTF-FFFFF'].callSeconds === 900
      && by['TESTF-FFFFF'].callKind === 'intake' && Boolean(by['TESTF-FFFFF'].calledAt), by['TESTF-FFFFF']);
  check('a call with nothing recorded has a call and no transcript',
    by['TESTG-GGGGG'].hasCall && !by['TESTG-GGGGG'].hasTranscript && by['TESTG-GGGGG'].callSeconds === 0,
    by['TESTG-GGGGG']);
  check('one not started has no call and a paid date',
    !by['TESTH-HHHHH'].hasCall && Boolean(by['TESTH-HHHHH'].paidAt), by['TESTH-HHHHH']);
  check('newest first', r.out.sessions[0].reference === 'TESTH-HHHHH', r.out.sessions.map((s) => s.reference));
}

console.log('a call that came back, with no account linked');
{
  const done = await order('TESTU-UUUUU', 'tok-unlinked');
  await tagged`insert into calls (order_id, call_id, seconds, transcript_encrypted, started_at)
               values (${done}, 'c-unlinked', 840, ${encrypt('Invented words.')}, now() - interval '2 hours')`;
  let r = await lookUp('tok-unlinked');
  check('before anything is written, nothing to deliver', r.out.status === 'used' && r.out.steps === null
    && r.out.messages.length === 0, r.out);
  await tagged`update orders set recommendations_encrypted = ${encrypt('1. An invented step.')},
               recommendations_written_at = now() where id = ${done}`;
  await tagged`insert into messages (order_id, author, body_encrypted)
               values (${done}, 'operator', ${encrypt('An invented note.')})`;
  r = await lookUp('tok-unlinked');
  check('their next steps are delivered on the claim link', r.out.steps === '1. An invented step.', r.out);
  check('and what was written to them', r.out.messages.length === 1
    && r.out.messages[0].body === 'An invented note.', r.out);
  check('nothing about a decision', !/decision|approved/i.test(JSON.stringify(r.out)), r.out);

  await tagged`update orders set client_account_id = 'acct-claim-linked' where id = ${done}`;
  r = await lookUp('tok-unlinked');
  check('once linked, they read it on their own page', r.out.steps === undefined && r.out.messages === undefined, r.out);
}

console.log('demo orders for the claim page');
{
  await seedDemo();
  const rows = await tagged`select reference_code, status, payment_method, is_demo from orders
                             where reference_code in ('DEMOW-WWWWW', 'DEMOG-GGGGG', 'DEMOR-RRRRR', 'DEMOD-DDDDD')`;
  check('one for each state the other demo rows miss', rows.length === 4 && rows.every((x) => x.is_demo), rows);
  await tagged`update orders set claim_token_hash = ${keyedHash('tok-demo-dropped')}
                where reference_code = 'DEMOD-DDDDD'`;
  const r = await lookUp('tok-demo-dropped');
  check('the dropped demo opens ready, with 2 starts and 23 minutes',
    r.out.status === 'confirmed' && r.out.startsLeft === 2 && r.out.minutesLeft === 23, r.out);
  await clearDemo();
  const left = await tagged`select count(*)::int as n from orders where reference_code like 'DEMO%'`;
  check('and they go with the rest of the demo data', left[0].n === 0, left[0]);
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
