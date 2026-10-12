import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();
process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const deskEndpoint = (await import('../api/desk.js')).default;

async function askDesk(state) {
  const req = { method: 'GET', url: `/api/desk?action=queue&state=${state}`, headers: {
    cookie: `op_session=${signSession('admin-1')}`,
  } };
  let payload = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; payload = JSON.parse(text); },
  };
  await deskEndpoint(req, res);
  return payload;
}

async function tabsOf(id) {
  const found = [];
  for (const state of ['waiting', 'replies', 'active', 'closed']) {
    const page = await askDesk(state);
    if (page.people.some((p) => Number(p.id) === id)) found.push(state);
  }
  return found;
}

let n = 0;
async function calledOrder(account) {
  n += 1;
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, client_account_id)
    values (${'h-q' + n}, ${'c-q' + n}, 700, 'wise', ${'QUEUE-0000' + n}, 'confirmed', ${account})
    returning id`;
  const id = Number(row.id);
  await tagged`insert into calls (order_id, call_id, transcript_encrypted)
               values (${id}, ${'c-queue-' + n}, 'x')`;
  return id;
}

console.log('');
console.log('everybody with a call is in a tab');

const fresh = await calledOrder(null);
check('a call nobody has decided is in new calls', (await tabsOf(fresh)).includes('waiting'));

const quoted = await calledOrder('acct-queue-quoted');
await tagged`update orders set decision = 'no-go', decision_at = now() where id = ${quoted}`;
await tagged`insert into quotes (account_id, amount_cents, scope_encrypted, status)
             values ('acct-queue-quoted', 50000, 'x', 'withdrawn')`;
await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-queue-quoted', 'client', 'x')`;
await tagged`insert into messages (account_id, author, body_encrypted)
             values ('acct-queue-quoted', 'operator', 'x')`;
let tabs = await tabsOf(quoted);
check('a quoted no-go with nothing waiting is in working', tabs.join(',') === 'active', tabs);

const plain = await calledOrder(null);
await tagged`update orders set decision = 'no-go', decision_at = now() where id = ${plain}`;
tabs = await tabsOf(plain);
check('a no-go with no quote is in closed', tabs.join(',') === 'closed', tabs);

const go = await calledOrder(null);
await tagged`update orders set decision = 'go', decision_at = now() where id = ${go}`;
tabs = await tabsOf(go);
check('a go is in working', tabs.join(',') === 'active', tabs);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
