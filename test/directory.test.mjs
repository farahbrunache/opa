import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, decrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const { profileIdFrom } = await import('../lib/desk-directory.js');
const deskEndpoint = (await import('../api/desk.js')).default;

function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null,
    setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}

async function run(req) {
  const res = fakeRes();
  try {
    await deskEndpoint(req, res);
    const out = res.body ? JSON.parse(res.body) : null;
    return { status: res.statusCode, out, message: out && out.error };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

function press(action, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST',
    url: `/api/desk?action=${action}`,
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  return run(req);
}

function ask(query, who = 'admin-1') {
  return run({ method: 'GET', url: `/api/desk?${query}`, headers: { cookie: `op_session=${signSession(who)}` } });
}

async function newOrder(account) {
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, client_account_id)
    values (${'h-' + account}, ${'c-' + account}, 700, 'wise',
            ${'D' + Math.random().toString(36).slice(2, 11).toUpperCase()},
            'confirmed', 'go', ${account})
    returning id`;
  const id = Number(rows[0].id);
  const caseId = await db.caseForAccount(account);
  await tagged`update orders set case_id = ${caseId} where id = ${id}`;
  return id;
}

console.log('');
console.log('the Directory on a list of people to approach');

check('a profile address gives its id',
  profileIdFrom('https://app.example.test/apps/directory/profile/abc-123') === 'abc-123');
check('a bare id is taken as it is', profileIdFrom('abc-123') === 'abc-123');
check('nothing pasted is no link', profileIdFrom('  ') === null);
{
  let refused = null;
  try { profileIdFrom('https://app.example.test/apps/lighthouse/1'); } catch (error) { refused = error; }
  check('an address that is not a profile is refused and says what to copy',
    refused && refused.status === 400 && /apps\/directory\/profile/.test(refused.message), refused?.message);
}

const id = await newOrder('dir-account-1');

delete process.env.DIRECTORY_SERVICE_TOKEN;
{
  const person = await ask(`action=person&id=${id}`);
  check('the switch reads off with no settings', person.out.directoryRead === false, person.out.directoryRead);
}

const added = await press('contact-add', { id, directory: 'https://app.example.test/apps/directory/profile/invented-7' });
check('a Directory link alone adds somebody', added.status === 201, added);

const [row] = await tagged`select id, name_encrypted, directory_profile_encrypted from contacts
                           where directory_profile_encrypted is not null order by id desc limit 1`;
const contact = Number(row.id);
check('the id is kept sealed, not in the clear', row.directory_profile_encrypted !== 'invented-7'
  && decrypt(row.directory_profile_encrypted) === 'invented-7');
check('no name is written for them', decrypt(row.name_encrypted) === '');

{
  const off = await ask(`action=directory-profile&id=${id}&contact=${contact}`);
  check('switched off, the read refuses and names both settings',
    off.status === 503 && /DIRECTORY_SERVICE_TOKEN/.test(off.message), off);
}

process.env.DIRECTORY_SERVICE_TOKEN = 'one-percent.an-invented-secret';

const realFetch = globalThis.fetch;
let asked = null;
function answer(status, body) {
  globalThis.fetch = async (url, options) => {
    asked = { url, options };
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
}

{
  const person = await ask(`action=person&id=${id}`);
  check('the switch reads on with both settings', person.out.directoryRead === true);
  const listed = person.out.contacts.find((c) => c.id === contact);
  check('the contact is marked as from the Directory', listed && listed.fromDirectory === true, listed);
  check('the person screen carries no Directory id', !JSON.stringify(person.out).includes('invented-7'));
}

const profile = {
  id: 'invented-7', firstName: 'Invented', lastName: 'Tiler', headline: 'Tile and grout',
  jobTitle: 'Tile setter', sector: 'Trades', skills: ['Grouting'], profileUrl: 'https://example.test/x',
  city: 'Nowhere', state: null, country: 'US',
};
answer(200, { profile });
{
  const read = await ask(`action=directory-profile&id=${id}&contact=${contact}`);
  check('a claimed profile is passed through', read.status === 200 && read.out.profile.lastName === 'Tiler', read);
  check('it asks the one profile, by id, with the credential',
    asked.url === 'https://app.chargingthefuture.com/api/directory/service/profiles/invented-7'
      && asked.options.headers.authorization === 'Bearer one-percent.an-invented-secret', asked);
  const [after] = await tagged`select name_encrypted, where_encrypted, why_encrypted from contacts where id = ${contact}`;
  check('nothing it said is written down', decrypt(after.name_encrypted) === '' && !after.where_encrypted && !after.why_encrypted);
}

answer(200, { profile: { ...profile, claimed: false } });
{
  const unclaimed = await ask(`action=directory-profile&id=${id}&contact=${contact}`);
  check('an unclaimed profile is passed through, saying so',
    unclaimed.status === 200 && unclaimed.out.profile.claimed === false && unclaimed.out.profile.lastName === 'Tiler', unclaimed);
}

answer(404, { ok: false });
{
  const gone = await ask(`action=directory-profile&id=${id}&contact=${contact}`);
  check('a removed profile says so', gone.status === 404 && /taken down/.test(gone.message), gone);
}

answer(401, { ok: false });
{
  const refused = await ask(`action=directory-profile&id=${id}&contact=${contact}`);
  check('a refused credential names both settings',
    refused.status === 502 && /DIRECTORY_SERVICE_TOKEN/.test(refused.message), refused);
}

globalThis.fetch = async () => { throw new Error('no route to host'); };
{
  const down = await ask(`action=directory-profile&id=${id}&contact=${contact}`);
  check('Skills Economy not answering says the contact is still saved', down.status === 502 && /saved/.test(down.message), down);
}

{
  const other = await newOrder('dir-account-2');
  const crossed = await ask(`action=directory-profile&id=${other}&contact=${contact}`);
  check('a contact on somebody else\'s list cannot be read through another record', crossed.status === 404, crossed);
  const stranger = await ask(`action=directory-profile&id=${id}&contact=${contact}`, 'not-an-admin');
  check('only the owner can read it', stranger.status === 401 || stranger.status === 403, stranger);
}

{
  const nothing = await press('contact-add', { id });
  check('neither a name nor a link is refused', nothing.status === 400, nothing);
}

globalThis.fetch = realFetch;
delete process.env.DIRECTORY_SERVICE_TOKEN;

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
