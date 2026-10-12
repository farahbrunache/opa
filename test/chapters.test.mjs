import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
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

async function ask(url) {
  const req = { method: 'GET', url, headers: { cookie: `op_session=${signSession('admin-1')}` } };
  const res = fakeRes();
  await deskEndpoint(req, res);
  return JSON.parse(res.body);
}

const account = 'acct-pivot-1';
const [row] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision, decision_at, approved_as_client_at,
                      client_account_id)
  values ('h-pivot', 'c-pivot', 700, 'wise', 'RPIVOT0001', 'confirmed', 'go', now(), now(), ${account})
  returning id`;
const order = Number(row.id);
const caseId = await db.caseForAccount(account);
await tagged`update orders set case_id = ${caseId} where id = ${order}`;
await tagged`update chapters set started_at = now() - interval '10 days' where case_id = ${caseId}`;

console.log('');
console.log('chapters');

const first = await ask(`/api/desk?action=person&id=${order}`);
check('a person has Chapter 1 from the start',
  first.chapters.length === 1 && first.chapters[0].number === 1 && first.chapters[0].endedAt === null,
  JSON.stringify(first.chapters));

await tagged`update plans set in_force = false where case_id = ${caseId}`;
const [plan] = await tagged`insert into plans (order_id, case_id, goal) values (${order}, ${caseId}, 'smallest') returning id`;
await tagged`insert into activities (case_id, plan_id, position, title_encrypted, state, source, shown_at)
             values (${caseId}, ${plan.id}, 1, ${encrypt('Ten paid repairs')}, 'todo', 'you', now())`;
await tagged`insert into activities (case_id, plan_id, position, title_encrypted, state, source, shown_at, closed_at)
             values (${caseId}, ${plan.id}, 2, ${encrypt('Done already')}, 'done', 'you', now(), now())`;
await tagged`insert into work (case_id, title_encrypted) values (${caseId}, ${encrypt('Write the flyer')})`;
const [kept] = await tagged`insert into contacts (case_id, name_encrypted) values (${caseId}, ${encrypt('Ana')}) returning id`;
await tagged`insert into contacts (case_id, name_encrypted) values (${caseId}, ${encrypt('Bo')})`;
const [said] = await tagged`
  insert into messages (account_id, author, body_encrypted) values (${account}, 'client', ${encrypt('A new direction.')})
  returning id`;
const [ours] = await tagged`
  insert into messages (account_id, author, body_encrypted) values (${account}, 'operator', ${encrypt('Mine.')})
  returning id`;

check('a pivot needs a name', (await press('pivot', { id: order, startedBy: 'them' })).status === 400);

check('a chapter cannot start in the future',
  (await press('pivot', { id: order, name: 'Vans', startedBy: 'them', startsOn: '2999-01-01' })).status === 400);
check('it starts from their message, never one of yours',
  (await press('pivot', { id: order, name: 'Vans', startedBy: 'them', fromMessageId: Number(ours.id) })).status === 400);
{
  const [loose] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code, status)
    values ('h-pivot-2', 'c-pivot-2', 700, 'wise', 'RPIVOT0002', 'confirmed') returning id`;
  check('an order nobody has linked has no person to pivot',
    (await press('pivot', { id: Number(loose.id), name: 'Vans', startedBy: 'them' })).status === 409);
}

const started = await press('pivot', {
  id: order, name: 'Mobile repair van', startedBy: 'them', changed: 'Garage to van',
  brief: 'The van brief.', fromMessageId: Number(said.id), closingName: 'Garage', summary: 'Four repairs.',
  contacts: [Number(kept.id)], activities: 'close', work: 'close', decision: 'reset',
});
check('a pivot starts Chapter 2', started.status === 201 && started.out.number === 2, JSON.stringify(started));

const after = await ask(`/api/desk?action=person&id=${order}`);
const [one, two] = after.chapters;
check('Chapter 1 is still there, closed, with its name and summary',
  one.endedAt !== null && one.name === 'Garage' && one.summary === 'Four repairs.', JSON.stringify(one));
check('and it keeps the decision it had', one.decision === 'go', one.decision);
check('Chapter 2 is open, from their message, with the brief',
  two.endedAt === null && two.brief === 'The van brief.' && Number(two.fromMessageId) === Number(said.id)
    && two.startedBy === 'them', JSON.stringify(two));
check('a reset leaves Chapter 2 undecided', two.decision === null);

const steps = await tagged`select state, drop_reason from activities where plan_id = ${plan.id} order by position`;
check('an open activity left behind is dropped as changed direction',
  steps[0].state === 'dropped' && steps[0].drop_reason === 'changed-direction', steps[0]);
check('a finished one is left as it was', steps[1].state === 'done');
check('and the goal it hung off is retired, not deleted',
  (await tagged`select in_force from plans where id = ${plan.id}`)[0].in_force === false);
const [work] = await tagged`select state from work where case_id = ${caseId}`;
check('open work left behind is dropped', work.state === 'dropped');
check('Chapter 1 says what it closed with',
  one.closedWith.activities.includes('Ten paid repairs') && one.closedWith.work.includes('Write the flyer'),
  JSON.stringify(one.closedWith));

const people = await tagged`select id, chapter_id from contacts where case_id = ${caseId} order by id`;
check('the person picked to carry moves to Chapter 2',
  String(people.find((p) => Number(p.id) === Number(kept.id)).chapter_id) === String(two.id));
check('the one left stays in Chapter 1',
  String(people.find((p) => Number(p.id) !== Number(kept.id)).chapter_id) === String(one.id));

check('a no-go on Chapter 2 is accepted', (await press('decide', { id: order, decision: 'no-go' })).status === 200);
const [stillGo] = await tagged`select decision, approved_as_client_at from orders where id = ${order}`;
check('and the order keeps the first go, so the conversation stays open',
  stillGo.decision === 'go' && stillGo.approved_as_client_at !== null, JSON.stringify(stillGo));
const decided = await ask(`/api/desk?action=person&id=${order}`);
check('the no-go is on Chapter 2', decided.chapters[1].decision === 'no-go');

await tagged`insert into work (case_id, title_encrypted) values (${caseId}, ${encrypt('Van tires')})`;
const [fresh] = await tagged`select chapter_id from work where case_id = ${caseId} order by id desc limit 1`;
check('work added after the pivot is stamped Chapter 2', String(fresh.chapter_id) === String(two.id));

check('the brief of a closed chapter stays as it was',
  (await press('chapter-edit', { id: order, number: 1, field: 'brief', text: 'x' })).status === 409);
check('an open chapter has no summary yet',
  (await press('chapter-edit', { id: order, number: 2, field: 'summary', text: 'x' })).status === 409);
check("a closed chapter's summary can be rewritten",
  (await press('chapter-edit', { id: order, number: 1, field: 'summary', text: 'Five repairs.' })).status === 200);
check('a pivot is on the activity log',
  decided.events.some((e) => e.kind === 'pivot' && /Chapter 2 started/.test(e.detail)));

const third = await press('pivot', { id: order, name: 'Shop', decision: 'keep' });
check('pivots are not limited', third.status === 201 && third.out.number === 3);
const last = await ask(`/api/desk?action=person&id=${order}`);
check('Keep carries the decision', last.chapters[2].decision === 'no-go', last.chapters[2].decision);
check('nothing was removed', last.chapters.length === 3);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
