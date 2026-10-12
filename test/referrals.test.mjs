import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.PAY_WISE = '@test-wisetag';
const { signSession } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const submit = (await import('../api/submit.js')).default;
const { bringFor, referralCode, referralLines } = await import('../lib/referrals.js');

function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}

async function hit(handler, method, url, payload, admin = true) {
  const stream = Readable.from([payload ? JSON.stringify(payload) : '']);
  const req = {
    method, url, socket: { remoteAddress: '127.0.0.9' },
    headers: { 'content-type': 'application/json', ...(admin ? { cookie: `op_session=${signSession('admin-1')}` } : {}) },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = fakeRes();
  try {
    await handler(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}
const press = (action, payload) => hit(deskEndpoint, 'POST', `/api/desk?action=${action}`, payload);
const ask = async (url) => (await hit(deskEndpoint, 'GET', url)).out;

let n = 0;
async function person(name, decision) {
  n += 1;
  const account = `acct-ref-${n}`;
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, decision_at, decided_at, client_account_id)
    values (${'h-ref-' + n}, ${'c-ref-' + n}, 700, 'wise', ${`RREF${n}-AAAAA`.slice(0, 11)}, 'confirmed',
            ${decision}, now(), now() - ${`${20 - n} hours`}::interval, ${account})
    returning id`;
  const caseId = await db.caseForAccount(account);
  await tagged`update orders set case_id = ${caseId} where id = ${row.id}`;
  const { encrypt } = await import('../lib/crypto.js');
  await tagged`update cases set name_encrypted = ${encrypt(name)} where id = ${caseId}`;
  return { order: Number(row.id), caseId };
}

console.log('');
console.log('who brought whom');

check('a code is six characters from the reference alphabet', referralCode('abc1o5') === null
  && referralCode('abc23') === null && referralCode('abc234') === 'ABC234');

const ana = await person('Ana Test', 'go');
const bo = await person('Bo Test', 'no-go');
check('a no-go gets no link', (await bringFor(bo.caseId)) === null);
const link = await bringFor(ana.caseId);
check('a go gets a link to the sales page with a code that is not their reference',
  /^https:\/\/farahbrunache\.com\/\?from=[A-Z0-9]{6}$/.test(link?.link || '') && !link.link.includes('RREF'), link);
check('asking again gives the same link', (await bringFor(ana.caseId)).link === link.link);
const code = link.link.split('from=')[1];

const bought = await hit(submit, 'POST', '/api/submit', { method: 'wise', from: code }, false);
check('an order through a link is placed', bought.status === 201, bought);
const [kept] = await tagged`select from_code from orders where reference_code = ${bought.out.reference}`;
check('and keeps the code', kept.from_code === code, kept);
const stray = await hit(submit, 'POST', '/api/submit', { method: 'wise', from: 'ZZZZZZ' }, false);
const [dropped] = await tagged`select from_code from orders where reference_code = ${stray.out.reference}`;
check("a code that's nobody's is dropped, and the order still goes through",
  stray.status === 201 && dropped.from_code === null);

await tagged`update orders set status = 'confirmed', decided_at = now() where reference_code = ${bought.out.reference}`;
const [cy] = await tagged`select id from orders where reference_code = ${bought.out.reference}`;
const newcomer = Number(cy.id);
const record = await ask(`/api/desk?action=person&id=${newcomer}`);
check('their record says Ana brought them, through her link',
  record.broughtBy.how === 'link' && record.broughtBy.by?.name === 'Ana Test', record.broughtBy);
const hers = await ask(`/api/desk?action=person&id=${ana.order}`);
check("and Ana's says she brought one", hers.broughtBy.brought.length === 1);
check("and her client page counts them", (await bringFor(ana.caseId)).brought === 1);

check('a correction needs a real code',
  (await press('brought-by', { id: ana.order, how: 'person', reference: 'NOPE0-00000' })).status === 404);
check('nobody brings themselves',
  (await press('brought-by', { id: ana.order, how: 'person', reference: hers.reference })).status === 400);
check('a correction to a person is accepted',
  (await press('brought-by', { id: ana.order, how: 'person', reference: (await ask(`/api/desk?action=person&id=${bo.order}`)).reference })).status === 200);
check("and nobody can be brought by somebody they brought",
  (await press('brought-by', { id: bo.order, how: 'person', reference: hers.reference })).status === 400);

check('a flag is accepted', (await press('flag', { id: bo.order, why: 'An invented reason.' })).status === 200);
const lines = await referralLines();
check('everybody down the chain is marked to check, all the way down',
  lines[ana.order]?.check === 'Bo Test' && lines[newcomer]?.check === 'Bo Test', lines);
check('and Everyone says who brought them', lines[newcomer]?.via === 'Ana');
const flagged = await ask(`/api/desk?action=person&id=${bo.order}`);
check('the reason is kept, and only on the desk', flagged.broughtBy.why === 'An invented reason.');
const [sealed] = await tagged`select flag_why_encrypted from orders where id = ${bo.order}`;
check('sealed at rest', !String(sealed.flag_why_encrypted).includes('invented'));
const tree = await ask('/api/desk?action=referrals');
check('the tree counts the flag and who was brought', tree.flagged === 1 && tree.brought === 2, tree);
check('and shows chains only: one, from Bo down', tree.chains === 1 && tree.tree.length === 1
  && tree.tree[0].children[0]?.children.length === 1, tree.tree);
check('a page past the last is the last', (await ask('/api/desk?action=referrals&page=99')).page === tree.last);
check('a flag stops nobody paying', (await hit(submit, 'POST', '/api/submit', { method: 'wise', from: code }, false)).status === 201);

for (let i = 0; i < 11; i += 1) {
  await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decided_at, from_code)
    values (${'h-many-' + i}, ${'c-many-' + i}, 700, 'wise', ${`RMANY-${String(i).padStart(5, 'A')}`.slice(0, 11)},
            'confirmed', now() - ${`${i} minutes`}::interval, ${code})`;
}
const first = (await ask(`/api/desk?action=person&id=${ana.order}`)).broughtBy;
check('a record shows 10 of everybody they brought', first.brought.length === 10 && first.broughtTotal === 12, first);
const second = (await ask(`/api/desk?action=person&id=${ana.order}&bpage=2`)).broughtBy;
check('and the rest on the next page', second.brought.length === 2 && second.broughtPage === 2 && second.broughtLast === 2);

check('removing the flag is accepted', (await press('unflag', { id: bo.order })).status === 200);
const after = await referralLines();
check('and clears everybody under it', !after[ana.order]?.check && !after[newcomer]?.check, after);
check('a flag and its removal are on the log',
  (await ask(`/api/desk?action=person&id=${bo.order}`)).events.filter((e) => ['flagged', 'unflagged'].includes(e.kind)).length === 2);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
