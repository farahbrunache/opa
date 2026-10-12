import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;

async function hit(method, url, payload) {
  const stream = Readable.from([payload ? JSON.stringify(payload) : '']);
  const req = { method, url, headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' } };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = { statusCode: 200, body: null, setHeader() {}, getHeader() {}, end(t) { this.body = t; } };
  try {
    await deskEndpoint(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

const account = 'acct-pivot-list-1';
const [row] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code,
                      status, decision, decision_at, approved_as_client_at, client_account_id)
  values ('h-plist', 'c-plist', 700, 'wise', 'RPLST00001', 'confirmed', 'go', now(), now(), ${account})
  returning id`;
const order = Number(row.id);
const caseId = await db.caseForAccount(account);
await tagged`update orders set case_id = ${caseId} where id = ${order}`;
await tagged`update chapters set started_at = now() - interval '10 days' where case_id = ${caseId}`;

console.log('');
console.log('a new direction on Today and Everyone');

let today = (await hit('GET', '/api/desk?action=today')).out;
check('nothing before a pivot', !today.pivots.some((p) => p.id === order));
check('a pivot is started', (await hit('POST', '/api/desk?action=pivot', { id: order, name: 'Repair van', startedBy: 'them' })).status === 201);
today = (await hit('GET', '/api/desk?action=today')).out;
const card = today.pivots.find((p) => p.id === order);
check('Today lists them with the direction', card?.direction === 'Repair van', today.pivots);
check('and counts them', today.totals.pivots >= 1);
const queue = (await hit('GET', '/api/desk?action=queue&state=active')).out;
check('Everyone names the direction on their row', queue.pivots[order] === 'Repair van', queue.pivots);
check('a go on the chapter is accepted', (await hit('POST', '/api/desk?action=decide', { id: order, decision: 'go' })).status === 200);
today = (await hit('GET', '/api/desk?action=today')).out;
check('and takes them off Today', !today.pivots.some((p) => p.id === order));
check('and off Everyone', !(await hit('GET', '/api/desk?action=queue&state=active')).out.pivots[order]);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
