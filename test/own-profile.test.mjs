import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.DIRECTORY_SERVICE_URL = 'https://skills.example.test/';
process.env.DIRECTORY_SERVICE_TOKEN = 'onepercent.invented';
const { signSession, decrypt } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();

const cookie = `op_session=${signSession('admin-1')}`;
async function call(method, url, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  await desk({ method, url, headers: { cookie, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
}

let asked = null;
globalThis.fetch = async (url) => {
  asked = String(url);
  return new Response(JSON.stringify({ profile: { id: 'profile-1', jobTitle: 'Electrician',
    sector: 'Construction', firstName: 'Invented', profileUrl: 'https://skills.example.test/p' } }));
};

await tagged`insert into trades (id, title, sector_id, sector) values
  ('op-elec', 'Electrician', 's1', 'Construction'), ('op-plumb', 'Plumber', 's1', 'Construction')`;
const [order] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision)
  values ('op-h', 'op-c', 700, 'wise', 'OWNPROF001', 'confirmed', 'go') returning id`;
const id = Number(order.id);

console.log('before anybody signs in');
check('there is nobody to link a profile to', (await call('POST', '/api/desk?action=own-profile',
  { id, link: 'profile-1' })).status === 409);

const caseId = await db.caseForAccount('acct-own-profile');
await tagged`update orders set case_id = ${caseId}, client_account_id = 'acct-own-profile' where id = ${id}`;

console.log('linking and reading');
check('something that isn\'t a profile link is refused',
  (await call('POST', '/api/desk?action=own-profile', { id, link: 'https://elsewhere.test/x y' })).status === 400);
check('their profile links', (await call('POST', '/api/desk?action=own-profile',
  { id, link: 'https://skills.example.test/apps/directory/profile/profile-1' })).status === 200);
const [stored] = await tagged`select directory_profile_encrypted from cases where id = ${caseId}`;
check('and only its id is saved', decrypt(stored.directory_profile_encrypted) === 'profile-1');
const person = (await call('GET', `/api/desk?action=person&id=${id}`)).out;
check('the record knows it is linked', person.ownProfileLinked === true && person.hasCase === true);
const read = (await call('GET', `/api/desk?action=own-profile&id=${id}`)).out;
check('it reads the profile live, by its id', asked.endsWith('/api/directory/service/profiles/profile-1'), asked);
check('and matches its job title to the trade list', read.tradeId === 'op-elec' && read.jobTitle === 'Electrician', read);
const [before] = await tagged`select trade_id from orders where id = ${id}`;
check('nothing from the profile is saved by reading it', before.trade_id === null, before);

console.log('found by their account');
const [other] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision)
  values ('op-h2', 'op-c2', 700, 'wise', 'OWNPROF002', 'confirmed', 'go') returning id`;
const otherCase = await db.caseForAccount('user_inventedAccount0001');
await tagged`update orders set case_id = ${otherCase}, client_account_id = 'user_inventedAccount0001' where id = ${other.id}`;
const byAccount = (await call('GET', `/api/desk?action=own-profile&id=${other.id}`)).out;
check('with nothing pasted, it asks by the account they signed in with',
  asked.endsWith('/api/directory/service/accounts/user_inventedAccount0001/profile'), asked);
check('and reads the trade the same way', byAccount.tradeId === 'op-elec', byAccount);
const [kept] = await tagged`select directory_profile_encrypted from cases where id = ${otherCase}`;
check('then saves the profile id it found, and nothing else', decrypt(kept.directory_profile_encrypted) === 'profile-1');

const demoCase = await db.caseForAccount('demo-acct-invented');
const [demo] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision, case_id)
  values ('op-h3', 'op-c3', 700, 'wise', 'OWNPROF003', 'confirmed', 'go', ${demoCase}) returning id`;
asked = null;
const demoRead = await call('GET', `/api/desk?action=own-profile&id=${demo.id}`);
check('a demo account is never asked about', demoRead.status === 404 && asked === null, demoRead);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
