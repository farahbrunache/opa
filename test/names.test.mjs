import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { encrypt, keyedHash, signSession } = await import('../lib/crypto.js');
const { nameFrom } = await import('../lib/auth.js');
const client = (await import('../api/client.js')).default;
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();

console.log('the name on the account');
check('name wins', nameFrom({ name: 'Ada Invented', given_name: 'X' }) === 'Ada Invented');
check('first and last when there is no name',
  nameFrom({ given_name: 'Ada', family_name: 'Invented' }) === 'Ada Invented');
check('the username when that is all there is', nameFrom({ preferred_username: 'ada' }) === 'ada');
check('nothing when the account has no name', nameFrom({ sub: 'x' }) === null);

async function order(token) {
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${keyedHash(token)}, ${'c-' + token}, 700, 'wise',
            ${'N' + Math.random().toString(36).slice(2, 11).toUpperCase()}, 'confirmed')
    returning id`;
  return Number(rows[0].id);
}

async function linkWith(account, token, nameCookie) {
  const body = Readable.from([JSON.stringify({ t: token })]);
  const cookies = [`op_session=${signSession(account)}`];
  if (nameCookie) cookies.push(`op_name=${encodeURIComponent(nameCookie)}`);
  const req = {
    method: 'POST', url: '/api/client?action=link',
    headers: { cookie: cookies.join('; '), 'content-type': 'application/json' },
    [Symbol.asyncIterator]: body[Symbol.asyncIterator].bind(body),
  };
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end() { this.writableEnded = true; },
  };
  await client(req, res);
  return res.statusCode;
}

async function ask(url) {
  let said = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; said = text; },
  };
  await desk({ method: 'GET', url, headers: { cookie: `op_session=${signSession('admin-1')}` } }, res);
  return JSON.parse(said);
}

async function person(id) {
  let said = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; said = text; },
  };
  await desk({
    method: 'GET', url: `/api/desk?action=person&id=${id}`,
    headers: { cookie: `op_session=${signSession('admin-1')}` },
  }, res);
  return JSON.parse(said);
}

console.log('linking saves it');
const unlinked = await order('tok-unlinked');
check('an order nobody linked has no name', (await person(unlinked)).name === null);

const named = await order('tok-named');
check('linking works', (await linkWith('acct-named', 'tok-named', encrypt('Ada Invented'))) === 200);
check('and the desk shows the name', (await person(named)).name === 'Ada Invented');

const forged = await order('tok-forged');
check('a forged cookie still links', (await linkWith('acct-forged', 'tok-forged', 'not-sealed')) === 200);
check('but no name is saved', (await person(forged)).name === null);

console.log('finding somebody');
for (const id of [unlinked, named, forged]) {
  await tagged`insert into calls (order_id, call_id, transcript_encrypted)
               values (${id}, ${'c-names-' + id}, ${encrypt('Agent: Hello.')})`;
}
const byName = await ask('/api/desk?action=queue&q=ada%20inv');
check('a part of a name finds them, whatever the case',
  byName.people.length === 1 && byName.people[0].id === named, byName.people.map((p) => p.id));
const [{ reference_code: code }] = await tagged`select reference_code from orders where id = ${unlinked}`;
const byCode = await ask(`/api/desk?action=queue&q=${code.slice(0, 6).toLowerCase()}`);
check('a part of a code finds them', byCode.people.some((p) => p.id === unlinked), byCode.people);
const nobody = await ask('/api/desk?action=queue&q=zzzz-nobody');
check('nobody found is an empty list, not an error', nobody.people.length === 0 && nobody.total === 0);
check('and the counts still come back', nobody.counts && nobody.counts.waiting === 3, nobody.counts);

console.log('the counts on the tabs');
const waiting = await ask('/api/desk?action=queue&state=waiting&page=1');
check('each tab says how many are in it',
  ['waiting', 'replies', 'active', 'closed'].every((k) => Number.isInteger(waiting.counts[k])), waiting.counts);
check('and the count matches the list under it', waiting.counts.waiting === waiting.total,
  [waiting.counts.waiting, waiting.total]);
const closed = await ask('/api/desk?action=queue&state=closed&page=1');
check('an empty tab still has its counts', closed.people.length === 0 && closed.counts.waiting === 3, closed.counts);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
