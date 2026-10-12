import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const client = (await import('../api/client.js')).default;
const { sheetSteps, firstSentence } = await import('../lib/sheet.js');
const { AUTO_UPDATE_MAX } = await import('../lib/desk.js');
await db.ensureSchema();

async function ask(endpoint, account, method, url, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  await endpoint({ method, url,
    headers: { cookie: `op_session=${signSession(account)}`, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null, raw: out.body };
}
const owner = (method, action, payload) => ask(desk, 'admin-1', method, `/api/desk?action=${action}`, payload);
const as = (account, method, action, payload) => ask(client, account, method, `/api/client?action=${action}`, payload);

async function linkedOrder(reference, account, name, { decision = 'go' } = {}) {
  const [order] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, approved_as_client_at)
    values (${`cp-${reference}`}, ${`cpc-${reference}`}, 700, 'wise', ${reference}, 'confirmed',
            ${decision}, ${decision === 'go' ? new Date().toISOString() : null})
    returning id`;
  const caseId = await db.caseForAccount(account);
  await tagged`update cases set name_encrypted = ${encrypt(name)} where id = ${caseId}`;
  await tagged`update orders set client_account_id = ${account}, case_id = ${caseId} where id = ${order.id}`;
  return { id: Number(order.id), caseId };
}

console.log('reading a sheet as steps');
{
  const parts = sheetSteps('Here it is.\n\n1. First thing. Why.\n   - https://example.com/a\n2) Second.\nmore\n\nClosing line.');
  check('numbered items are steps, sub-bullets stay with theirs', parts.steps.length === 2
    && parts.steps[0].includes('https://example.com/a'), parts);
  check('the text around them is kept apart', parts.intro === 'Here it is.' && parts.outro === 'Closing line.', parts);
  check('a sheet with no numbers is one step', sheetSteps('Just do this. Then that.').steps.length === 1);
  check('the first sentence ends at a period, not inside an address',
    firstSentence('Go to https://example.com/x. Then rest.')[0] === 'Go to https://example.com/x.');
}

const go = await linkedOrder('CPAGE-AAAAA', 'acct-cp-go', 'Invented Person');
const other = await linkedOrder('CPAGE-BBBBB', 'acct-cp-other', 'Another Invented', { decision: 'no-go' });

console.log('next steps into the conversation');
{
  const sheet = '1. Do the first thing. It works.\n2. Do the second.\n3. Do the third.';
  check('filing the sheet works', (await owner('POST', 'recommend', { id: go.id, body: sheet })).status === 201);
  const first = await tagged`select author, from_template from messages where account_id = 'acct-cp-go' order by id`;
  check('the steps are posted as an owner message, then the opening line',
    first.map((m) => m.author).join(',') === 'operator,opening', first);
  await owner('POST', 'recommend', { id: go.id, body: sheet });
  const again = await tagged`select count(*)::int as n from messages where account_id = 'acct-cp-go'`;
  check('filing the same sheet again posts nothing', again[0].n === 2, again);
  await owner('POST', 'recommend', { id: go.id, body: `${sheet}\n4. A fourth.` });
  const changed = await tagged`select count(*)::int as n from messages where account_id = 'acct-cp-go' and author = 'operator'`;
  check('a rewritten sheet posts again', changed[0].n === 2, changed);
  await owner('POST', 'recommend', { id: other.id, body: '1. Something to read.' });
  const nogo = await tagged`select count(*)::int as n from messages where account_id = 'acct-cp-other'`;
  check('without a go nothing is posted', nogo[0].n === 0, nogo);
}

console.log('two kinds of owner line');
{
  const long = 'x'.repeat(AUTO_UPDATE_MAX + 1);
  const refused = await owner('POST', 'reply', { id: go.id, body: long, mode: 'auto' });
  check('an auto update over the cap is refused, with the reason', refused.status === 400
    && /auto update/i.test(refused.out.error), refused.out);
  check('an auto update under the cap is sent',
    (await owner('POST', 'reply', { id: go.id, body: 'Farah reviewed your last message.', mode: 'auto' })).status === 201);
  check('a message from a template is sent',
    (await owner('POST', 'reply', { id: go.id, body: 'A check-in written earlier.', fromTemplate: true })).status === 201);
  const lines = await tagged`select author, from_template from messages where account_id = 'acct-cp-go' order by id desc limit 2`;
  check('the template line is the owner\'s, marked', lines[0].author === 'operator' && lines[0].from_template === true, lines);
  check('the auto update has its own author', lines[1].author === 'auto' && lines[1].from_template === false, lines);
  const kinds = (await tagged`select kind from case_events where order_id = ${go.id}`).map((r) => r.kind);
  check('both land on the trail as their own kinds',
    kinds.includes('message.auto') && kinds.includes('message.template'), kinds);
  const person = (await owner('GET', `person&id=${go.id}`)).out;
  check('the desk sees which line came from a template',
    person.messages.some((m) => m.fromTemplate === true) && person.messages.some((m) => m.author === 'auto'));
  const thread = await as('acct-cp-go', 'GET', 'thread');
  check('the client sees the auto update as one', thread.out.messages.some((m) => m.author === 'auto'));
  check('the client endpoint never returns the template flag',
    !/from_?template/i.test(thread.raw) && thread.out.messages.every((m) => Object.keys(m).join() === 'author,body,at'),
    thread.out.messages[0]);
}

console.log('ticking off steps');
{
  const refused = await as('acct-cp-other', 'POST', 'step', { reference: 'CPAGE-AAAAA', step: 1, done: true });
  check('a session the account doesn\'t own is refused', refused.status === 404, refused.out);
  const past = await as('acct-cp-go', 'POST', 'step', { reference: 'CPAGE-AAAAA', step: 9, done: true });
  check('a step the sheet doesn\'t have is refused', past.status === 400, past.out);
  const ticked = await as('acct-cp-go', 'POST', 'step', { reference: 'CPAGE-AAAAA', step: 2, done: true });
  check('their own step ticks', ticked.status === 200 && ticked.out.stepsDone.join() === '2', ticked.out);
  await as('acct-cp-go', 'POST', 'step', { reference: 'CPAGE-AAAAA', step: 2, done: true });
  await as('acct-cp-go', 'POST', 'step', { reference: 'CPAGE-AAAAA', step: 3, done: true });
  const undone = await as('acct-cp-go', 'POST', 'step', { reference: 'CPAGE-AAAAA', step: 3, done: false });
  check('and unticks', undone.out.stepsDone.join() === '2', undone.out);
  const trail = await tagged`select kind from case_events where order_id = ${go.id} and kind like 'step.%' order by id`;
  check('each change writes one trail line, a repeat writes none',
    trail.map((r) => r.kind).join() === 'step.done,step.done,step.undone', trail);
  const mine = (await as('acct-cp-go', 'GET', 'mine')).out;
  check('the page gets the ticks and the first name',
    mine.sessions[0].stepsDone.join() === '2' && mine.firstName === 'Invented', mine.firstName);
}

console.log('introductions on the client page');
{
  await tagged`update orders set trade_id = 'cp-trade' where id = ${other.id}`;
  await tagged`insert into trades (id, title, sector_id, sector) values ('cp-trade', 'Invented Trade', 's', 'S')`;
  check('a client-to-client one is recorded',
    (await owner('POST', 'introduce', { id: go.id, reference: 'CPAGE-BBBBB', reason: 'Both invented.' })).status === 201);
  check('and one by link',
    (await owner('POST', 'introduce', { id: go.id, link: 'https://www.example.org/u/invented', reason: 'A lead.' })).status === 201);
  const mine = await as('acct-cp-go', 'GET', 'mine');
  const [person, link] = mine.out.introductions;
  check('the other client is named with their job title and status', person.name === 'Another Invented'
    && person.jobTitle === 'Invented Trade' && person.status === 'Being introduced' && person.reason === 'Both invented.', person);
  check('a link is named by its host and nothing else', link.name === 'Someone on example.org'
    && link.jobTitle === null, link);
  check('nothing else about the other party is sent', !mine.raw.includes('CPAGE-BBBBB')
    && !mine.raw.includes('example.org/u/invented'));
  const theirs = (await as('acct-cp-other', 'GET', 'mine')).out.introductions;
  check('it shows on the other side too', theirs.length === 1 && theirs[0].name === 'Invented Person', theirs);
  const [intro] = await tagged`select id from introductions where b_order_id = ${other.id}`;
  await owner('POST', 'introduction-record', { id: go.id, introductionId: intro.id, outcome: 'went nowhere' });
  const after = (await as('acct-cp-go', 'GET', 'mine')).out.introductions;
  check('one that went nowhere isn\'t shown', after.length === 1 && after[0].name.startsWith('Someone on'), after);
}

console.log('your path');
{
  const [plan] = await tagged`insert into plans (order_id, case_id, path) values (${go.id}, ${go.caseId}, 'smallest') returning id`;
  await tagged`insert into milestones (plan_id, position, title_encrypted, status, outcome_encrypted)
               values (${plan.id}, 1, ${encrypt('Invented milestone done')}, 'worked', ${encrypt('PRIVATE-OUTCOME')}),
                      (${plan.id}, 2, ${encrypt('Invented quiet milestone')}, 'ghosted', null),
                      (${plan.id}, 3, ${encrypt('Invented later milestone')}, 'planned', null)`;
  await tagged`update milestones set shown_at = now() where plan_id = ${plan.id} and position < 3`;
  const [m] = await tagged`select id from milestones where plan_id = ${plan.id} order by position limit 1`;
  await tagged`insert into action_items (milestone_id, position, title_encrypted) values (${m.id}, 1, ${encrypt('PRIVATE-ACTION')})`;
  await tagged`insert into projects (case_id, title_encrypted, state, due_at, note_encrypted)
               values (${go.caseId}, ${encrypt('Invented work owed')}, 'to do', now() + interval '3 days', ${encrypt('PRIVATE-NOTE')}),
                      (${go.caseId}, ${encrypt('Invented dropped work')}, 'dropped', null, null)`;
  await tagged`insert into quotes (account_id, amount_cents, scope_encrypted, status)
               values ('acct-cp-go', 12300, ${encrypt('Invented offer title. More words.')}, 'offered')`;
  const mine = await as('acct-cp-go', 'GET', 'mine');
  const path = mine.out.path;
  const by = (title) => path.find((p) => p.title === title);
  check('a finished milestone is done, with its date', by('Invented milestone done')?.group === 'done'
    && by('Invented milestone done').at, path);
  check('ghosted reads as stalled', by('Invented quiet milestone')?.said === 'Stalled', path);
  check('a milestone not shown yet is left out', !by('Invented later milestone'), path);
  check('work owed is scheduled with its due date', by('Invented work owed')?.group === 'next'
    && by('Invented work owed').due, path);
  check('dropped work is left out', !by('Invented dropped work'), path);
  check('an offer shows by its title and state', by('Invented offer title.')?.said === 'Offer waiting on you', path);
  check('each item carries only a kind, a title, a state and dates',
    path.every((p) => Object.keys(p).sort().join() === 'at,due,group,kind,said,title'), path[0]);
  check('and the kind is one of the three the server adds',
    path.every((p) => ['Milestone', 'Work', 'Offer'].includes(p.kind)), path.map((p) => p.kind));
  check('no note, outcome, action item or amount reaches the client',
    !/PRIVATE-|12300|\b123\b/.test(mine.raw), mine.raw.slice(0, 200));
}

console.log('demo rows');
{
  check('demo data seeds', (await owner('POST', 'demo-seed')).status === 201);
  const seeded = await tagged`select count(*)::int as n from step_ticks where is_demo`;
  check('with two ticked steps', seeded[0].n === 2, seeded);
  const auto = await tagged`select count(*)::int as n from messages where author = 'auto' and account_id like 'demo-%'`;
  const templ = await tagged`select count(*)::int as n from messages where from_template and account_id like 'demo-%'`;
  check('an auto update and a template line', auto[0].n === 1 && templ[0].n === 1, [auto, templ]);
  const both = await tagged`select count(*)::int as n from introductions i join orders a on a.id = i.a_order_id
                            join orders b on b.id = i.b_order_id where a.is_demo and b.is_demo`;
  check('and a client-to-client introduction', both[0].n === 1, both);
  check('demo data clears', (await owner('POST', 'demo-clear')).status === 200);
  const left = await tagged`select count(*)::int as n from step_ticks where is_demo`;
  check('taking the ticks with it', left[0].n === 0, left);
  const real = await tagged`select count(*)::int as n from step_ticks where order_id = ${go.id}`;
  check('and leaving a real one', real[0].n === 1, real);
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
