import { check, db, failureCount, seedPrompts, tagged } from './harness.mjs';

await db.ensureSchema();
await seedPrompts();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const { scopeOf, readsFor, chapterInFull } = await import('../lib/chapter-scope.js');
const { recapFacts } = await import('../lib/draft-recap.js');
const { questionNotes } = await import('../lib/desk-questions.js');

async function press(action, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST', url: `/api/desk?action=${action}`,
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = { statusCode: 200, body: null, setHeader() {}, getHeader() {}, end(t) { this.body = t; } };
  try {
    await deskEndpoint(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

const account = 'acct-scope-1';
const [row] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision, decision_at, approved_as_client_at, client_account_id)
  values ('h-scope', 'c-scope', 700, 'wise', 'RSCOPE0001', 'confirmed', 'go', now(), now(), ${account})
  returning id`;
const order = Number(row.id);
const caseId = await db.caseForAccount(account);
await tagged`update orders set case_id = ${caseId} where id = ${order}`;
await tagged`update chapters set started_at = now() - interval '10 days' where case_id = ${caseId}`;
const say = (author, body, daysAgo) => tagged`
  insert into messages (account_id, author, body_encrypted, created_at)
  values (${account}, ${author}, ${encrypt(body)}, now() - ${`${daysAgo} days`}::interval)`;

await tagged`insert into calls (order_id, kind, transcript_encrypted, started_at, ended_at)
             values (${order}, 'intake', ${encrypt('Caller: I sell candles.')}, now() - interval '9 days', now() - interval '9 days')`;
await tagged`insert into contacts (case_id, name_encrypted) values (${caseId}, ${encrypt('Old Contact')})`;
await say('client', 'Candles are slow this month.', 5);

console.log('');
console.log('what the model reads after a pivot');

const before = await recapFacts(order);
check('in Chapter 1, a catch-up reads what it always did', before.lines.some((l) => l.includes('Old Contact'))
  && before.lines.some((l) => l.includes('Candles are slow')));
check('and the What AI reads box stays away', (await readsFor(order, account)) === null);

const started = await press('pivot', {
  id: order, name: 'Bike repair', startedBy: 'them', brief: 'I fix bikes now.',
  summary: 'Candles, one call, slow sales.', milestones: 'close', work: 'close', decision: 'reset',
});
check('a pivot starts Chapter 2', started.status === 201, started);
await say('client', 'Two offices want monthly visits.', 0);
await tagged`insert into contacts (case_id, name_encrypted) values (${caseId}, ${encrypt('New Contact')})`;

const plain = await scopeOf(order);
const recap = await recapFacts(order, plain);
const text = recap.lines.join('\n');
check('a catch-up starts from the brief', text.includes('I fix bikes now.'));
check('and reads what was said since the pivot', text.includes('Two offices want monthly visits.'));
check('and nothing said before it', !text.includes('Candles are slow'), text);
check('and only the work stamped with this chapter', text.includes('New Contact') && !text.includes('Old Contact'));
check("and this chapter's decision, not the session's", text.includes('No decision on this chapter yet'));
check('the earlier summary stays out unless asked for', !text.includes('Candles, one call'));
const asked = (await recapFacts(order, await scopeOf(order, { withSummary: true }))).lines.join('\n');
check('and goes along when the chip is on', asked.includes('Candles, one call, slow sales.'));

const notes = await questionNotes(order, plain);
check("questions don't read an earlier chapter's call", !notes.notes.join('\n').includes('I sell candles'));
check('and the brief stands in for a call', notes.calls === 1 && notes.notes.join('\n').includes('I fix bikes now.'));

const reads = await readsFor(order, account);
check('the box says what goes: the brief and one message, no calls',
  reads.number === 2 && reads.brief && reads.messages === 1 && reads.calls === 0, reads);
check('and counts the words', reads.words === 4 + 5, reads.words);
check('and the chip offers the summary with its length', reads.previous?.number === 1 && reads.previous.words === 5);

const full = await chapterInFull(caseId, 1);
check('a summary is written from its chapter in full', full.includes('I sell candles') && full.includes('Candles are slow'));
check('and nothing from the chapter after it', !full.includes('Two offices'));

check('the lines from the brief save on the chapter',
  (await press('chapter-edit', { id: order, number: 2, field: 'fields', fields: { trade: 'Bike mechanic' } })).status === 200);
check('and the model reads them', (await scopeOf(order)).fields?.trade === 'Bike mechanic');
check("a closed chapter's lines stay as they were",
  (await press('chapter-edit', { id: order, number: 1, field: 'fields', fields: { trade: 'x' } })).status === 409);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
