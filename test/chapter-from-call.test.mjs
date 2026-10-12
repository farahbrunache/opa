import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt, keyedHash } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const client = (await import('../api/client.js')).default;

async function hit(handler, url, who, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const req = {
    method: payload ? 'POST' : 'GET', url, socket: { remoteAddress: '127.0.0.9' },
    headers: { cookie: `op_session=${signSession(who)}`, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream),
  };
  const res = { statusCode: 200, body: null, setHeader() {}, getHeader() {}, end(t) { this.body = t; } };
  try {
    await handler(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}
const press = (action, payload) => hit(desk, `/api/desk?action=${action}`, 'admin-1', payload);
const person = async (id) => (await hit(desk, `/api/desk?action=person&id=${id}`, 'admin-1')).out;

async function paid(token, account) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, client_account_id)
    values (${keyedHash(token)}, ${'c-' + token}, 700, 'wise',
            ${'F' + Math.random().toString(36).slice(2, 11).toUpperCase()}, 'confirmed', ${account})
    returning id`;
  return Number(row.id);
}
async function called(orderId, words) {
  const [row] = await tagged`
    insert into calls (order_id, call_id, kind, seconds, transcript_encrypted)
    values (${orderId}, ${`call-${orderId}-${Math.random()}`}, 'intake', 600, ${encrypt(words)})
    returning id, chapter_id`;
  return row;
}

const account = 'acct-from-call-1';
const first = await paid('t-from-call-1', account);
const caseId = await db.caseForAccount(account);
await tagged`update orders set case_id = ${caseId} where id = ${first}`;
await tagged`update chapters set started_at = now() - interval '10 days' where case_id = ${caseId}`;
await called(first, 'Agent: What do you do?\nCaller: I bake cakes.');

const second = await paid('t-from-call-2', account);
await tagged`update orders set case_id = ${caseId} where id = ${second}`;
const redo = await called(second, 'Agent: What do you do?\nCaller: I want to teach baking instead.');
const [draft] = await tagged`
  insert into drafts (order_id, slot, model) values (${second}, 'a', 'test-model') returning id`;
await tagged`insert into recaps (draft_id, order_id, content_encrypted) values (${draft.id}, ${second}, ${encrypt('Recap.')})`;
await tagged`
  insert into call_gaps (draft_id, order_id, call_id, content_encrypted)
  values (${draft.id}, ${second}, ${redo.id}, ${encrypt('Gaps.')})`;

const other = await paid('t-from-call-3', 'acct-from-call-2');
await tagged`update orders set case_id = ${await db.caseForAccount('acct-from-call-2')} where id = ${other}`;
const elsewhere = await called(other, 'Agent: Hello?\nCaller: Somebody else.');

console.log('');
console.log('a chapter started from a call');

check("a call on somebody else's record is refused",
  (await press('pivot', { id: first, name: 'Classes', fromCallId: Number(elsewhere.id) })).status === 400);
const [said] = await tagged`
  insert into messages (account_id, author, body_encrypted) values (${account}, 'client', ${encrypt('Classes?')})
  returning id`;
check('a message and a call together are refused',
  (await press('pivot', { id: first, name: 'Classes', fromCallId: Number(redo.id), fromMessageId: Number(said.id) })).status === 400);

const started = await press('pivot', { id: first, name: 'Classes', brief: 'Teach baking.', fromCallId: Number(redo.id) });
check('the chapter starts from the call', started.status === 201 && started.out.number === 2, started);

const view = await person(first);
const two = view.chapters[1];
check('the chapter says which call it came from', Number(two.fromCallId) === Number(redo.id));
check('and is recorded as theirs', two.startedBy === 'them');
const [moved] = await tagged`select chapter_id from calls where id = ${redo.id}`;
check('the call moves into the new chapter', String(moved.chapter_id) === String(two.id));
const [recap] = await tagged`select chapter_id from recaps where order_id = ${second}`;
check('so does its recap', String(recap.chapter_id) === String(two.id));
const [gap] = await tagged`select chapter_id from call_gaps where call_id = ${redo.id}`;
check('and its gaps', String(gap.chapter_id) === String(two.id));
check('the earlier call stays in Chapter 1',
  view.calls.filter((c) => String(c.chapterId) === String(view.chapters[0].id) || c.chapterId === null).length === 1);

const firstCall = view.calls.find((c) => Number(c.orderId) === first);
check('a call from an earlier chapter is refused',
  (await press('pivot', { id: first, name: 'Shop', fromCallId: Number(firstCall.id) })).status === 400);

console.log('');
console.log('a call taken before the session was linked');

const third = await paid('t-from-call-4', null);
const unlinked = await called(third, 'Agent: What do you do?\nCaller: Classes are going well.');
check('it has no chapter yet', unlinked.chapter_id === null);
const linked = await hit(client, '/api/client?action=link', account, { t: 't-from-call-4' });
check('linking works', linked.status === 200, linked);
const [stamped] = await tagged`select chapter_id from calls where id = ${unlinked.id}`;
check('linking files the call under the open chapter', String(stamped.chapter_id) === String(two.id));

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
