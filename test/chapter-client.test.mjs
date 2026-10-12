import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt, decrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const clientEndpoint = (await import('../api/client.js')).default;
const { sessionsView, threadView } = await import('../lib/client-view.js');

async function hit(handler, action, payload, who) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const base = handler === deskEndpoint ? '/api/desk' : '/api/client';
  const req = {
    method: 'POST', url: `${base}?action=${action}`, socket: { remoteAddress: '127.0.0.7' },
    headers: { cookie: `op_session=${signSession(who)}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() {}, getHeader() {}, end(t) { this.body = t; } };
  try {
    await handler(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}
const desk = (action, payload) => hit(deskEndpoint, action, payload, 'admin-1');
const account = 'acct-direction-1';
const client = (action, payload) => hit(clientEndpoint, action, payload, account);

const [row] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code,
                      status, decision, decision_at, approved_as_client_at, client_account_id,
                      recommendations_encrypted, recommendations_written_at)
  values ('h-dir', 'c-dir', 700, 'wise', 'RDIRE00001', 'confirmed', 'go', now() - interval '9 days',
          now() - interval '9 days', ${account}, ${encrypt('1. Sell ten candles.\n2. Ask a shop.')}, now() - interval '8 days')
  returning id`;
const order = Number(row.id);
const caseId = await db.caseForAccount(account);
await tagged`update orders set case_id = ${caseId} where id = ${order}`;
await tagged`update chapters set started_at = now() - interval '10 days' where case_id = ${caseId}`;

console.log('');
console.log('a new direction, as they see it');

const [asked] = await tagged`
  insert into messages (account_id, author, body_encrypted) values (${account}, 'client', ${encrypt('I want to fix bikes instead.')})
  returning id`;
check('nothing proposes a new direction from the desk', (await desk('reply', { id: order, body: 'Hello', propose: 'Bikes' })).status === 201
  && (await sessionsView(account)).proposal === undefined);
check('the chapter starts from their message',
  (await desk('pivot', { id: order, name: 'Bikes', fromMessageId: Number(asked.id) })).status === 201);
let page;

check('next steps on Chapter 2 are accepted', (await desk('recommend', { id: order, body: '1. Fix one bike.\n2. Tell two offices.\n3. Price a visit.' })).status === 201);
const [sheet] = await tagged`select recommendations_encrypted from orders where id = ${order}`;
check("and the session's sheet is never touched", decrypt(sheet.recommendations_encrypted).startsWith('1. Sell ten candles.'));

page = await sessionsView(account);
check('their page knows the chapter', page.chapter?.number === 2 && page.chapter.name === 'Bikes');
check("and shows the chapter's own steps", page.steps?.text.startsWith('1. Fix one bike.'));
check('a tick past the last step is refused', (await client('step', { chapter: 2, step: 9, done: true })).status === 400);
const ticked = await client('step', { chapter: 2, step: 2, done: true });
check("a tick lands on the chapter's steps", ticked.status === 200 && ticked.out.stepsDone.includes(2), ticked);
check('and not on the session', (await tagged`select count(*)::int as n from step_ticks where order_id = ${order}`)[0].n === 0);

const thread = await threadView(account);
check('their conversation knows where the new direction starts', thread.directions.length === 1 && thread.directions[0].name === 'Bikes');
check('the next steps went into the conversation as a message',
  thread.messages.some((m) => m.author === 'operator' && m.body.startsWith('1. Fix one bike.')));

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
