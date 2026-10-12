import { Readable } from 'node:stream';
import { check, db, failureCount, pg, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const client = (await import('../api/client.js')).default;
await db.ensureSchema();

async function ask(endpoint, account, method, url, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  const cookie = account ? `op_session=${signSession(account)}` : '';
  await endpoint({ method, url, headers: { cookie, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
}
const owner = (method, action, payload) => ask(desk, 'admin-1', method, `/api/desk?action=${action}`, payload);
const as = (account, method, action, payload) => ask(client, account, method, `/api/client?action=${action}`, payload);
const preview = (who, id, part, extra = '') =>
  ask(desk, who, 'GET', `/api/desk?action=client-preview&id=${id}&part=${part}${extra}`);

async function order(reference, account, name, decision) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, approved_as_client_at)
    values (${`pv-${reference}`}, ${`pvc-${reference}`}, 700, 'wise', ${reference}, 'confirmed',
            ${decision}, ${decision === 'go' ? new Date().toISOString() : null})
    returning id`;
  if (account) {
    const caseId = await db.caseForAccount(account);
    await tagged`update cases set name_encrypted = ${encrypt(name)} where id = ${caseId}`;
    await tagged`update orders set client_account_id = ${account}, case_id = ${caseId} where id = ${row.id}`;
  }
  return Number(row.id);
}

async function fingerprint() {
  const tables = (await pg.query(`select table_name from information_schema.tables
                                   where table_schema = 'public' and table_type = 'BASE TABLE'
                                   order by table_name`)).rows.map((r) => r.table_name);
  const out = {};
  for (const table of tables) {
    const [row] = (await pg.query(`select count(*)::int as n,
                                          md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
                                     from "${table}" t`)).rows;
    out[table] = `${row.n}:${row.h}`;
  }
  return out;
}

const go = await order('PREVW-AAAAA', 'acct-pv-go', 'Invented Person', 'go');
const nogo = await order('PREVW-BBBBB', 'acct-pv-nogo', 'Another Invented', 'no-go');
const unlinked = await order('PREVW-CCCCC', null, null, null);

await owner('POST', 'recommend', { id: go, body: '1. Do the first thing.\n2. Do the second.' });
await owner('POST', 'recommend', { id: nogo, body: '1. Something to read.' });
await as('acct-pv-go', 'POST', 'step', { reference: 'PREVW-AAAAA', step: 1 });
await as('acct-pv-go', 'POST', 'send', { body: 'An invented question.' });
await tagged`insert into quotes (account_id, amount_cents, scope_encrypted, status)
             values ('acct-pv-go', 4500, ${encrypt('Invented offer. What it covers.')}, 'offered')`;
await tagged`update cases set messages_read_at = null where account_id = 'acct-pv-go'`;

console.log('the same answer the client gets');
for (const part of ['mine', 'quotes', 'thread']) {
  const theirs = await as('acct-pv-go', 'GET', part);
  const shown = await preview('admin-1', go, part);
  check(`${part}: the preview equals the client's own read`, shown.status === 200
    && JSON.stringify(shown.out) === JSON.stringify(theirs.out), { theirs: theirs.out, shown: shown.out });
}
{
  const theirs = await as('acct-pv-go', 'GET', 'thread&page=1');
  const shown = await preview('admin-1', go, 'thread', '&page=1');
  check('a page of the thread matches too', JSON.stringify(shown.out) === JSON.stringify(theirs.out));
  const mine = (await preview('admin-1', go, 'mine')).out;
  check('the approved page: approved, first name, the tick', mine.approved
    && mine.firstName === 'Invented' && mine.sessions[0].stepsDone.join() === '1', mine);
  check('nothing owner-only is in it', !/from_template|fromTemplate|note|isDemo|is_demo|decision/
    .test(JSON.stringify(mine)), mine);
}
{
  const theirs = await as('acct-pv-nogo', 'GET', 'thread');
  const shown = await preview('admin-1', nogo, 'thread');
  check('a no-go: the conversation is refused the same way', theirs.status === 403
    && shown.status === 403 && shown.out.error === theirs.out.error, shown.out);
  const mine = (await preview('admin-1', nogo, 'mine')).out;
  check('a no-go: not approved, the recommendation there',
    !mine.approved && /Something to read/.test(mine.sessions[0].recommendations), mine);
}
{
  const mine = await preview('admin-1', unlinked, 'mine');
  check('no account linked: that one session, no name', mine.status === 200
    && mine.out.account === null && mine.out.sessions.length === 1
    && mine.out.sessions[0].reference === 'PREVW-CCCCC' && mine.out.firstName === null, mine.out);
  check('no account linked: no offers', (await preview('admin-1', unlinked, 'quotes')).out.quotes.length === 0);
  check('no account linked: no conversation', (await preview('admin-1', unlinked, 'thread')).status === 403);
}

console.log('reading it writes nothing');
{
  const before = await fingerprint();
  for (const id of [go, nogo, unlinked]) {
    for (const part of ['mine', 'quotes', 'thread']) await preview('admin-1', id, part);
  }
  const after = await fingerprint();
  const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
  check('no table changed: messages, cases, step ticks, events, orders, quotes or any other',
    changed.length === 0 && Object.keys(before).length > 10, changed);
  const [row] = await tagged`select messages_read_at from cases where account_id = 'acct-pv-go'`;
  check('their message is still unread on the desk', row.messages_read_at === null, row);
}

console.log('written before an account is linked');
{
  const { keyedHash } = await import('../lib/crypto.js');
  const waiting = await order('PREVW-DDDDD', null, null, 'go');
  await tagged`update orders set claim_token_hash = ${keyedHash('pv-claim-ddddd')} where id = ${waiting}`;
  const sent = await owner('POST', 'reply', { id: waiting, body: 'An invented note from the desk.' });
  check('the desk can write to them', sent.status === 201, sent.out);
  const shown = await preview('admin-1', waiting, 'thread');
  check('their page shows it, read only', shown.status === 200 && shown.out.readOnly === true
    && shown.out.messages.length === 1 && shown.out.messages[0].author === 'operator', shown.out);
  check('nothing about a decision in it', !/decision|approved|answer was/i.test(JSON.stringify(shown.out)), shown.out);
  const record = await ask(desk, 'admin-1', 'GET', `/api/desk?action=person&id=${waiting}`);
  check('the desk record lists it', record.out?.messages?.length === 1 && record.out.linked === false, record.out);
  const linked = await as('acct-pv-later', 'POST', 'link', { t: 'pv-claim-ddddd' });
  check('linking works', linked.status === 200, linked.out);
  const theirs = await as('acct-pv-later', 'GET', 'thread');
  check('once linked it is on their account and they can write', theirs.status === 200
    && !theirs.out.readOnly && theirs.out.messages.length === 1, theirs.out);
  const left = await tagged`select count(*)::int as n from messages where order_id = ${waiting}`;
  check('nothing is left held by the order', left[0].n === 0, left);
}

console.log('owner-only');
{
  check('signed out is refused', (await preview(null, go, 'mine')).status === 401);
  check('the client themselves is refused', (await preview('acct-pv-go', go, 'mine')).status === 403);
  check('another client is refused', (await preview('acct-pv-nogo', go, 'mine')).status === 403);
  check('an unknown part is refused', (await preview('admin-1', go, 'send')).status === 400);
  check('an unknown record is a 404', (await preview('admin-1', 999999, 'mine')).status === 404);
}

console.log('a re-enabled control would still be refused for the owner');
{
  const before = await fingerprint();
  check('ticking their step', (await as('admin-1', 'POST', 'step', { reference: 'PREVW-AAAAA', step: 2 })).status === 404);
  check('writing into their conversation', (await as('admin-1', 'POST', 'send', { body: 'x' })).status === 403);
  const [quote] = await tagged`select id from quotes where account_id = 'acct-pv-go'`;
  check('answering their offer', (await as('admin-1', 'POST', 'quote-answer',
    { id: Number(quote.id), answer: 'agreed', accepted: true })).status === 409);
  const after = await fingerprint();
  const changed = Object.keys(before).filter((t) => before[t] !== after[t] && t !== 'rate_limits');
  check('and none of those wrote anything but the rate count', changed.length === 0, changed);
}

if (failureCount()) {
  console.log(`\n${failureCount()} failed`);
  process.exit(1);
}
console.log('\nall passed');
