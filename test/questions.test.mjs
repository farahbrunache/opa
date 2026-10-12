import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const { seedDemo, clearDemo } = await import('../lib/demo.js');
const { stageFor } = await import('../lib/questions.js');

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

async function ask(action) {
  const req = {
    method: 'GET',
    url: `/api/desk?action=${action}`,
    headers: { cookie: `op_session=${signSession('admin-1')}` },
  };
  const res = fakeRes();
  await deskEndpoint(req, res);
  return JSON.parse(res.body);
}

let n = 0;
async function newOrder({ account = null, decision = null } = {}) {
  n += 1;
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, client_account_id)
    values (${'hq-' + n}, ${'cq-' + n}, 700, 'wise', ${'RQ' + String(n).padStart(8, '0')},
            'confirmed', ${decision}, ${account})
    returning id`;
  const id = Number(rows[0].id);
  if (account) {
    const caseId = await db.caseForAccount(account);
    await tagged`update orders set case_id = ${caseId} where id = ${id}`;
  }
  return id;
}

console.log('');
console.log('questions to ask');

check('no decision is working out the offer', stageFor({ decision: null }) === 'start');
check('a go is toward a first customer', stageFor({ decision: 'go' }) === 'first');
check('a quoted no-go is toward a first customer', stageFor({ decision: 'no-go', openQuote: true }) === 'first');
check('a no-go with nothing quoted has nothing to ask', stageFor({ decision: 'no-go', openQuote: false }) === null);
check('a first customer on the smallest number is keeping it steady',
  stageFor({ decision: 'go', firstCustomerAt: new Date(), path: 'smallest' }) === 'steady');
check('a first customer reaching past the average is going further',
  stageFor({ decision: 'go', firstCustomerAt: new Date(), path: 'reach' }) === 'further');

{
  const empty = await press('question-add', { stage: 'first', body: '   ' });
  check('an empty question is refused', empty.status === 400, empty);
  const nowhere = await press('question-add', { stage: 'later', body: 'When?' });
  check('an unknown stage is refused', nowhere.status === 400, nowhere);
}
const added = await press('question-add', { stage: 'first', body: 'How long have you had it?' });
check('a question is added', added.status === 201 && added.out.ids.length === 1 && added.out.ids[0] > 0, added);
const reading = await press('question-add', { stage: 'start', body: "Why haven't they solved it already?" });
check('one for reading the call', reading.status === 201, reading);

{
  const list = await ask('questions');
  check('the list carries the stages in order',
    list.stages.map((s) => s.stage).join(',') === 'any,start,first,steady,further', list.stages);
  check('the list is the questions, sealed on the way in and read back',
    list.questions.some((q) => q.id === added.out.ids[0] && q.stage === 'first' && q.body === 'How long have you had it?'),
    list.questions);
}

{
  const undecided = await newOrder();
  const person = await ask(`person&id=${undecided}`);
  check('an undecided record is working out the offer', person.questionStage === 'start', person.questionStage);
  const own = person.questions.filter((q) => q.stage === person.questionStage);
  check('and its own set is the start question only',
    own.length === 1 && own[0].id === reading.out.ids[0], person.questions);
  check('with every other stage beside it, to pick from',
    person.questions.some((q) => q.stage === 'first'), person.questions);

  const go = await newOrder({ account: 'client-q-go', decision: 'go' });
  const after = await ask(`person&id=${go}`);
  check('a go is toward a first customer', after.questionStage === 'first', after.questionStage);
  check('and shows the first customer question', after.questions.some((q) => q.id === added.out.ids[0]), after.questions);

  await tagged`update cases set first_customer_at = now()
                where id = (select case_id from orders where id = ${go})`;
  const won = await ask(`person&id=${go}`);
  check('a first customer with no path is keeping it steady', won.questionStage === 'steady', won.questionStage);
  await tagged`insert into plans (order_id, case_id, path, in_force)
               select id, case_id, 'reach', true from orders where id = ${go}`;
  const reaching = await ask(`person&id=${go}`);
  check('reaching past the average is going further', reaching.questionStage === 'further', reaching.questionStage);

  const no = await newOrder({ account: 'client-q-no', decision: 'no-go' });
  const refused = await ask(`person&id=${no}`);
  check('a no-go with nothing quoted has no stage', refused.questionStage === null && refused.questions.length === 0, refused.questionStage);
}

{
  const no = await newOrder({ account: 'client-q-no2', decision: 'no-go' });
  const nothing = await press('questions-draft', { id: no });
  check('nothing to ask on a no-go', nothing.status === 409, nothing);

  const quiet = await newOrder({ account: 'client-q-quiet', decision: 'go' });
  const noCall = await press('questions-draft', { id: quiet });
  check('no call, nothing to read', noCall.status === 409 && /No call/.test(noCall.out.error), noCall);

  await tagged`insert into calls (order_id, call_id, transcript_encrypted, started_at, ended_at)
               values (${quiet}, 'q-call-1', ${encrypt('Agent: Invented.\nCaller: Invented.')}, now(), now())`;
  const noModel = await press('questions-draft', { id: quiet });
  check('with a call and no model set up, it says so', noModel.status === 503, noModel);
}

{
  const { linesOf } = await import('../lib/desk-questions.js');
  check('numbers and bullets at the start of a line go',
    linesOf('1. One?\n- Two?\n\n  3) Three?\n\u2022 Four?').join('|') === 'One?|Two?|Three?|Four?');

  const tooLong = await press('question-add', { stage: 'steady', body: `Fine?\n${'x'.repeat(301)}` });
  check('a line over the limit is refused, naming the line', tooLong.status === 400 && /Line 2/.test(tooLong.out?.error || tooLong.message), tooLong);
  const none = await tagged`select count(*)::int as n from questions where stage = 'steady' and not is_demo`;
  check('and nothing from it was added', none[0].n === 0, none);

  const tooMany = await press('question-add', { stage: 'steady', body: Array.from({ length: 51 }, (_, i) => `Q${i}?`).join('\n') });
  check('more than fifty at once is refused', tooMany.status === 400, tooMany);

  const pasted = await press('question-add', { stage: 'steady', topic: ' Invented group ', body: '1. First invented?\n2. Second invented?' });
  check('a pasted list adds one question a line', pasted.status === 201 && pasted.out.ids.length === 2, pasted);

  const loose = await press('question-add', { stage: 'steady', body: 'Ungrouped invented?' });
  const list = await ask('questions');
  const quoteOnes = list.questions.filter((q) => q.stage === 'steady' && !q.isDemo);
  check('ungrouped comes first, then the group together',
    quoteOnes.map((q) => q.topic || '-').join(',') === '-,Invented group,Invented group'
      && quoteOnes[0].id === loose.out.ids[0], quoteOnes);
  check('the group is offered for the next add', list.topics.includes('Invented group'), list.topics);

  const quoted = await newOrder({ account: 'client-q-group', decision: 'go' });
  await tagged`insert into quotes (account_id, amount_cents, scope_encrypted, status)
               values ('client-q-group', 10000, ${encrypt('Invented scope')}, 'offered')`;
  const person = await ask(`person&id=${quoted}`);
  check('the record carries the group on each question',
    person.questions.filter((q) => q.topic === 'Invented group').length === 2, person.questions);
}

{
  const id = added.out.ids[0];
  const blank = await press('question-edit', { question: id, stage: 'first', body: '   ' });
  check('an edit to nothing is refused', blank.status === 400, blank);
  const long = await press('question-edit', { question: id, stage: 'first', body: 'x'.repeat(301) });
  check('an edit over the limit is refused', long.status === 400, long);
  const edited = await press('question-edit', { question: id, stage: 'steady', topic: 'Edited group', body: 'Edited invented?' });
  check('a question is edited', edited.status === 200, edited);
  const list = await ask('questions');
  const after = list.questions.find((q) => q.id === id);
  check('with its new words, stage and group',
    after && after.body === 'Edited invented?' && after.stage === 'steady' && after.topic === 'Edited group', after);
  const missing = await press('question-edit', { question: 999999, stage: 'first', body: 'Nobody?' });
  check('editing one not on the list is refused', missing.status === 404, missing);

  const gone = await press('question-delete', { question: id });
  check('a question is deleted', gone.status === 200, gone);
  const again = await press('question-delete', { question: id });
  check('deleting it twice is refused', again.status === 404, again);
  const rows = await tagged`select 1 from questions where id = ${id}`;
  check('and the row is gone', rows.length === 0, rows);
}

{
  const one = await press('question-add', { stage: 'first', body: 'Invented ask one?' });
  const two = await press('question-add', { stage: 'first', body: 'Invented ask two?' });
  const [q1, q2] = [one.out.ids[0], two.out.ids[0]];

  const nobody = await newOrder({ decision: 'go' });
  const kept = await press('reply', { id: nobody, body: 'Invented question?' });
  check('a reply to somebody with no account is kept for the order', kept.status === 201, kept);
  const held = await tagged`select account_id, order_id from messages where order_id = ${nobody}`;
  check('held by the order, not an account', held.length === 1 && held[0].account_id === null, held);

  const go = await newOrder({ account: 'client-q-asked', decision: 'go' });
  await tagged`update orders set approved_as_client_at = now() where id = ${go}`;
  const empty = await press('reply', { id: go, body: '   ', questions: [q1] });
  check('an empty message is refused', empty.status === 400, empty);
  const after = await tagged`select count(*)::int as n from question_asks where question_id = ${q1}`;
  check('and asks nothing either', after[0].n === 0, after);

  const auto = await press('reply', { id: go, mode: 'auto', body: 'Invented status.', questions: [q1] });
  check('an auto update sends', auto.status === 201, auto);
  const autoAsked = await tagged`select count(*)::int as n from question_asks where question_id = ${q1}`;
  check('and asks nothing: questions go as a message from you', autoAsked[0].n === 0, autoAsked);

  const sent = await press('reply', { id: go, body: 'Two invented questions.', questions: [q1, q2, q2, 'x', 999999] });
  check('a message carrying two questions sends', sent.status === 201 && sent.out.asked === 2, sent);
  const person = await ask(`person&id=${go}`);
  const marked = person.questions.filter((q) => q.askedAt);
  check('the record shows both as asked, with a date',
    marked.length === 2 && marked.every((q) => [q1, q2].includes(q.id)), marked);
  check('and the trail says so', person.events.some((e) => e.kind === 'questions.asked' && e.group === 'msg'), person.events);

  await tagged`update question_asks set asked_at = now() - interval '9 days' where question_id = ${q1}`;
  const again = await press('reply', { id: go, body: 'Asked again.', questions: [q1] });
  const rows = await tagged`select count(*)::int as n from question_asks where question_id = ${q1}`;
  check('asking again keeps the first and adds a second', again.status === 201 && rows[0].n === 2, rows);
  const later = (await ask(`person&id=${go}`)).questions.find((q) => q.id === q1);
  check('the record shows the latest date and how many times',
    later.asks === 2 && Math.abs(new Date(later.askedAt).getTime() - Date.now()) < 60_000, later);
  const onlyOnce = (await ask(`person&id=${go}`)).questions.find((q) => q.id === q2);
  check('and one asked once says once', onlyOnce.asks === 1, onlyOnce);

  const other = await newOrder({ account: 'client-q-other', decision: 'go' });
  const theirs = await ask(`person&id=${other}`);
  check('another person has asked nothing', !theirs.questions.some((q) => q.askedAt), theirs.questions);

  await press('question-delete', { question: q2 });
  const gone = await tagged`select count(*)::int as n from question_asks where question_id = ${q2}`;
  check('deleting a question takes its asked rows', gone[0].n === 0, gone);
}

{
  const { questionNotes } = await import('../lib/desk-questions.js');
  const first = await newOrder({ account: 'client-q-notes', decision: 'go' });
  const second = await newOrder({ account: 'client-q-notes' });
  const stranger = await newOrder({ account: 'client-q-stranger', decision: 'go' });
  const call = (order, words, fields, hours) => tagged`
    insert into calls (order_id, call_id, kind, transcript_encrypted, fields_encrypted, started_at, ended_at)
    values (${order}, ${'q-notes-' + order}, 'intake', ${encrypt(words)},
            ${fields ? encrypt(JSON.stringify(fields)) : null},
            now() - (${hours} || ' hours')::interval, now() - (${hours} || ' hours')::interval)`;
  await call(first, 'Agent: What do you do?\nUser: Invented FIRSTCALL welding.',
    { trade: 'Invented welder', rate: 'Invented sixty', inTheWay: '', firstCustomer: '' }, 48);
  await call(second, 'Agent: Anything new?\nUser: Invented SECONDCALL a van.', null, 2);
  await call(stranger, 'Agent: Hi.\nUser: STRANGERLEAK somebody else.', null, 1);
  const { calls, notes } = await questionNotes(second);
  const text = notes.join('\n');
  check('both calls of the person go in, newest first',
    calls === 2 && text.indexOf('SECONDCALL') < text.indexOf('FIRSTCALL') && text.includes('FIRSTCALL'), text);
  check('with the four lines and the decision',
    /Job title: Invented welder/.test(text) && /Rate: Invented sixty/.test(text) && /Decision: go/.test(text), text);
  check("and nothing from anybody else's call", !/STRANGERLEAK/.test(text), text);
}

{
  await tagged`insert into trades (id, title, sector_id, sector, sector_order, title_order, active)
               values ('q-t-doc', 'Invented Doctors', 'q-s-health', 'Invented Health', 1, 1, true),
                      ('q-t-aide', 'Invented Aides', 'q-s-health', 'Invented Health', 1, 2, true),
                      ('q-t-sit', 'Invented Sitters', 'q-s-care', 'Invented Care', 2, 1, true)`;
  const forDoc = await press('question-add', { stage: 'first', trade: 'q-t-doc', body: 'Invented doctor question?' });
  const forHealth = await press('question-add', { stage: 'first', sector: 'q-s-health', body: 'Invented health question?' });
  const forSit = await press('question-add', { stage: 'first', trade: 'q-t-sit', body: 'Invented sitter question?' });
  check('a question takes a job title or a sector', forDoc.status === 201 && forHealth.status === 201 && forSit.status === 201);
  const nowhere = await press('question-add', { stage: 'first', trade: 'q-t-none', body: 'Nowhere?' });
  check('a job title not in the copy is refused', nowhere.status === 400, nowhere);

  const doctor = await newOrder({ account: 'client-q-doc', decision: 'go' });
  await tagged`update orders set trade_id = 'q-t-doc' where id = ${doctor}`;
  const seen = await ask(`person&id=${doctor}`);
  const ids = seen.questions.map((q) => q.id);
  check('a doctor gets the doctor and health questions',
    ids.includes(forDoc.out.ids[0]) && ids.includes(forHealth.out.ids[0]), seen.questions);
  check('and not the sitter one', !ids.includes(forSit.out.ids[0]), seen.questions);
  check('the job title comes before the sector, then everyone',
    seen.questions[0].id === forDoc.out.ids[0] && seen.questions[1].id === forHealth.out.ids[0]
      && seen.questions[0].scope === 'Invented Doctors', seen.questions.slice(0, 3));

  const aide = await newOrder({ account: 'client-q-aide', decision: 'go' });
  await tagged`update orders set trade_id = 'q-t-aide' where id = ${aide}`;
  const aideIds = (await ask(`person&id=${aide}`)).questions.map((q) => q.id);
  check('an aide gets the health question but not the doctor one',
    aideIds.includes(forHealth.out.ids[0]) && !aideIds.includes(forDoc.out.ids[0]));

  const none = await newOrder({ account: 'client-q-none', decision: 'go' });
  const noneIds = (await ask(`person&id=${none}`)).questions.map((q) => q.id);
  check('nobody with no job title gets a sector question', !noneIds.includes(forHealth.out.ids[0]));
  await press('reply', { id: none, body: 'Invented.', questions: [forSit.out.ids[0]] });
  const askedAnyway = (await ask(`person&id=${none}`)).questions;
  check('a question asked by hand stays on their record',
    askedAnyway.some((q) => q.id === forSit.out.ids[0] && q.fit === 'other' && q.askedAt), askedAnyway);

  const bank = [
    '# Everyone', '### Keeping it steady', '- Invented everyone question?',
    '# Invented Health', '- Invented health any-stage question?',
    '## Invented Doctors', '### first', '- Invented doctor question?', '- Invented second doctor question?',
    '## Invented Surgeons', '- Invented surgeon question?',
    '# Invented Nowhere', '- Invented lost question?',
    'A line of prose is skipped.',
  ].join('\n');
  const imported = await press('questions-import', { text: bank });
  check('a bank adds what is new and skips what is there',
    imported.status === 200 && imported.out.added === 3 && imported.out.skipped === 1, imported);
  check('and names what the taxonomy copy does not have',
    imported.out.unknown.join('|') === 'Invented Health · Invented Surgeons|Invented Nowhere', imported.out);
  const again = await press('questions-import', { text: bank });
  check('pasting it twice adds nothing', again.out.added === 0 && again.out.skipped === 4, again);
  const listed = await ask('questions');
  const steady = listed.questions.find((q) => q.body === 'Invented everyone question?');
  const anyHealth = listed.questions.find((q) => q.body === 'Invented health any-stage question?');
  const second = listed.questions.find((q) => q.body === 'Invented second doctor question?');
  check('with stage, sector and job title read from the headings',
    steady?.stage === 'steady' && !steady.sectorId && anyHealth?.stage === 'any' && anyHealth.sectorId === 'q-s-health'
      && second?.stage === 'first' && second.tradeId === 'q-t-doc' && second.sectorId === 'q-s-health', listed.questions);
  check('the list carries the sectors with their job titles',
    listed.sectors.some((s) => s.id === 'q-s-health' && s.trades.length === 2), listed.sectors);
  await tagged`delete from trades where id like 'q-t-%'`;
}

{
  await seedDemo();
  const seededAsks = await tagged`select count(*)::int as n from question_asks where is_demo`;
  check('seeding asks the working client two questions, one of them twice', seededAsks[0].n === 3, seededAsks);
  const demo = await tagged`select stage, topic_encrypted, sector_id, trade_id from questions where is_demo order by stage, id`;
  check('seeding makes demo questions across the stages, one in a group, one per job title and one per sector',
    demo.map((r) => r.stage).join(',') === 'any,first,first,first,start,steady'
      && demo.filter((r) => r.topic_encrypted !== null).length === 1
      && demo.filter((r) => r.trade_id).length === 1
      && demo.filter((r) => r.sector_id && !r.trade_id).length === 1, demo);
  await clearDemo();
  const left = await tagged`select count(*)::int as n from questions where is_demo`;
  check('clearing takes the demo questions', left[0].n === 0, left);
  const asks = await tagged`select count(*)::int as n from question_asks where is_demo`;
  check('and the demo asked rows', asks[0].n === 0, asks);
  const kept = await tagged`select count(*)::int as n from questions where id = ${reading.out.ids[0]}`;
  check('and leaves the typed one', kept[0].n === 1, kept);
}

const failures = failureCount();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
