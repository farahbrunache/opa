import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
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

async function ask(id) {
  const req = {
    method: 'GET',
    url: `/api/desk?action=person&id=${id}`,
    headers: { cookie: `op_session=${signSession('admin-1')}` },
  };
  const res = fakeRes();
  await deskEndpoint(req, res);
  return JSON.parse(res.body);
}

async function newOrder(account) {
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, client_account_id)
    values (${'h-' + account}, ${'c-' + account}, 700, 'wise',
            ${'R' + Math.random().toString(36).slice(2, 11).toUpperCase()},
            'confirmed', 'go', ${account})
    returning id`;
  const id = Number(rows[0].id);
  const caseId = await db.caseForAccount(account);
  await tagged`update orders set case_id = ${caseId} where id = ${id}`;
  return id;
}

console.log('');
console.log('people to approach');

{
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values ('h-nocase', 'c-nocase', 700, 'wise', 'RNOCASE001', 'confirmed')
    returning id`;
  const unlinked = Number(rows[0].id);
  const refused = await press('contact-add', { id: unlinked, name: 'Somebody' });
  check('an order nobody has linked has nowhere to keep a list', refused.status === 409, refused);
}

const order = await newOrder('acct-contacts-1');

check('a contact needs a name', (await press('contact-add', { id: order, name: '  ' })).status === 400);
check('adding one is accepted', (await press('contact-add', {
  id: order, name: 'Ray at the garage', where: 'In person', why: 'His plumber never answers.',
})).status === 201);
check('and one with nothing but a name', (await press('contact-add', {
  id: order, name: 'The hardware store',
})).status === 201);

let person = await ask(order);
const [ray, store] = person.contacts;
check('both come back on the record, oldest first',
  person.contacts.length === 2 && ray.name === 'Ray at the garage'
  && store.name === 'The hardware store', person.contacts.map((c) => c.name));
check('with where and why where they were given',
  ray.where === 'In person' && ray.why === 'His plumber never answers.', ray);
check('and nothing invented where they were not',
  store.where === null && store.why === null, store);
check('a new contact is somebody to approach', ray.status === 'to approach' && store.status === 'to approach');

check('reaching out needs something written down',
  (await press('contact-reach', { id: order, contactId: ray.id })).status === 400);
check('a contact belonging to nobody here is not reachable',
  (await press('contact-reach', { id: order, contactId: ray.id + 9999, said: 'Hello' })).status === 404);

check('what was said goes down on its own', (await press('contact-reach', {
  id: order, contactId: ray.id, said: 'Told him I price per job now and asked what he pays.',
})).status === 201);

person = await ask(order);
let kept = person.contacts.find((c) => c.id === ray.id);
check('it is on the record with nothing back yet',
  kept.reaches.length === 1 && kept.reaches[0].back === null
  && /price per job/.test(kept.reaches[0].said), kept.reaches);
check('and the status moved itself off to approach', kept.status === 'reached out', kept.status);

check('what came back goes down later, as its own line', (await press('contact-reach', {
  id: order, contactId: ray.id, back: 'Said 400 for the last one and asked me to quote the next.',
})).status === 201);
person = await ask(order);
kept = person.contacts.find((c) => c.id === ray.id);
check('two times approached read as two lines, newest first',
  kept.reaches.length === 2 && /400 for the last one/.test(kept.reaches[0].back),
  kept.reaches.map((r) => [r.said, r.back]));

check('a status it does not know is refused',
  (await press('contact-move', { id: order, contactId: ray.id, status: 'maybe' })).status === 400);

check('said no is a status like any other',
  (await press('contact-move', { id: order, contactId: store.id, status: 'said no' })).status === 200);

const before = await ask(order);
check('nothing has ended the method yet', before.firstCustomerAt === null, before.firstCustomerAt);

const paid = await press('contact-move', { id: order, contactId: ray.id, status: 'paying customer' });
check('marking the one who paid is accepted', paid.status === 200, paid);
check('and it ends the method on the case', paid.out.firstCustomerAt !== null, paid.out);

person = await ask(order);
check('the record carries the date rather than only the contact',
  person.firstCustomerAt !== null, person.firstCustomerAt);

const at = person.firstCustomerAt;
await press('contact-move', { id: order, contactId: store.id, status: 'paying customer' });
person = await ask(order);
check('a second paying customer does not move the date',
  person.firstCustomerAt === at, [at, person.firstCustomerAt]);

const trail = person.events.map((e) => e.kind);
check('adding, reaching out and moving are all lines on the record',
  trail.includes('contact.added') && trail.includes('contact.reached')
  && trail.includes('contact.moved'), trail);

{
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, client_account_id, case_id)
    values ('h-second', 'c-second', 700, 'wise', 'RSECOND001', 'confirmed', 'go',
            'acct-contacts-1', ${(await db.caseForAccount('acct-contacts-1'))})
    returning id`;
  const second = Number(rows[0].id);
  const other = await ask(second);
  check('their second order shows the same list',
    other.contacts.length === person.contacts.length
    && other.contacts[0].name === person.contacts[0].name,
    other.contacts.map((c) => c.name));
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
