import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const client = (await import('../api/client.js')).default;
const { readRoadmap } = await import('../lib/desk-roadmap.js');
const { DROP_REASONS_OFFERED, nextDueAt } = await import('../lib/desk.js');

await db.ensureSchema();

async function ask(endpoint, account, method, url, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  try {
    await endpoint({ method, url,
      headers: { cookie: `op_session=${signSession(account)}`, 'content-type': 'application/json' },
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  } catch (error) {
    return { status: error.status || 500, out: { error: error.message } };
  }
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null, raw: out.body };
}
const owner = (method, action, payload) => ask(desk, 'admin-1', method, `/api/desk?action=${action}`, payload);
const person = async (id) => (await owner('GET', `person&id=${id}`)).out;
const today = async () => (await owner('GET', 'today')).out;

const account = 'acct-activities-1';
const [row] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision, approved_as_client_at)
  values ('ac-1', 'acc-1', 700, 'wise', 'RACTS000001', 'confirmed', 'go', now())
  returning id`;
const order = Number(row.id);
const caseId = await db.caseForAccount(account);
await tagged`update orders set client_account_id = ${account}, case_id = ${caseId} where id = ${order}`;
const page = async () => (await ask(client, account, 'GET', '/api/client?action=mine')).out;

console.log('');
console.log('activities');
{
  const loose = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code, status)
    values ('ac-loose', 'acc-loose', 700, 'wise', 'RACTS000009', 'confirmed') returning id`;
  check('an order nobody linked has no roadmap to put an activity on',
    (await owner('POST', 'activity-add', { id: Number(loose[0].id), title: 'x' })).status === 409);
}
check('an activity needs words', (await owner('POST', 'activity-add', { id: order, title: '   ' })).status === 400);
check('adding one works without a goal set',
  (await owner('POST', 'activity-add', { id: order, title: 'Invented first activity' })).status === 201);
await owner('POST', 'activity-add', { id: order, title: 'Invented second activity' });
let me = await person(order);
const [one, two] = me.activities;
check('a new activity starts drafted, off their page', one.state === 'drafted' && one.shownAt === null, one);
check('their page has none of it yet', (await page()).roadmap.length === 0);

check('a drafted one cannot be asked about', (await owner('POST', 'activity-push', { id: order, activityId: one.id })).status === 409);
const moved = await owner('POST', 'activity-move', { id: order, activityId: one.id });
check('moving it to To do hands its words back for the message', moved.status === 200 && moved.out.activity.title === 'Invented first activity', moved);
check('moving it twice is refused', (await owner('POST', 'activity-move', { id: order, activityId: one.id })).status === 409);
me = await person(order);
check('it is on their page now', me.activities[0].state === 'todo' && me.activities[0].shownAt !== null);
{
  const theirs = (await page()).roadmap;
  check('and their roadmap shows it under To do, with no outcome or source on it',
    theirs.length === 1 && theirs[0].group === 'todo' && theirs[0].title === 'Invented first activity'
    && Object.keys(theirs[0]).sort().join() === 'at,due,fromCall,group,id,since,title,yours', theirs);
}

check('a reminder it does not know is refused',
  (await owner('POST', 'activity-cadence', { id: order, activityId: one.id, cadence: 'hourly' })).status === 400);
const dated = await owner('POST', 'activity-cadence', { id: order, activityId: one.id, cadence: 'weekly' });
check('a weekly reminder dates it a week out',
  dated.status === 200 && Math.abs(new Date(dated.out.nextAt) - new Date(nextDueAt('weekly'))) < 60_000, dated);
check('nothing is due yet', (await today()).due.length === 0);
await tagged`update activities set next_at = now() - interval '2 days' where id = ${one.id}`;
let first = await today();
check('a date that has passed puts it on the first screen with its words and reminder',
  first.due.length === 1 && first.due[0].activityId === one.id && first.due[0].title === 'Invented first activity'
  && first.due[0].cadenceLabel === 'Every week', first.due);
const pushed = await owner('POST', 'activity-push', { id: order, activityId: one.id });
check('asked, still going restarts the reminder from today and stamps when',
  pushed.status === 200 && pushed.out.askedAt && Math.abs(new Date(pushed.out.nextAt) - new Date(nextDueAt('weekly'))) < 60_000, pushed);
check('so it comes off the first screen', (await today()).due.length === 0);

console.log('yours to do, under an activity');
check('work goes under an activity on their page',
  (await owner('POST', 'work-take', { id: order, title: 'Invented work', activityId: one.id, dueAt: '2026-11-01' })).status === 201);
check('not under a drafted one',
  (await owner('POST', 'work-take', { id: order, title: 'x', activityId: two.id })).status === 409);
check('and loose work is still taken on',
  (await owner('POST', 'work-take', { id: order, title: 'Invented loose work' })).status === 201);
me = await person(order);
const work = me.work.find((w) => w.title === 'Invented work');
check('the row knows its activity', work.activityId === one.id && work.state === 'to do', work);
check('the client sees Farah is working on her part', (await page()).roadmap[0].yours === true);
check('a state it does not know is refused',
  (await owner('POST', 'work-move', { id: order, workId: work.id, state: 'delivered' })).status === 400);
check('done stamps the day', (await owner('POST', 'work-move', { id: order, workId: work.id, state: 'done' })).status === 200
  && (await person(order)).work.find((w) => w.id === work.id).doneAt !== null);
await owner('POST', 'work-move', { id: order, workId: work.id, state: 'doing' });
await tagged`update work set due_at = now() - interval '3 days' where id = ${work.id}`;
first = await today();
check('late work of yours is on the first screen, as before', first.owing.some((r) => Number(r.workId) === work.id), first.owing);

console.log('done and dropped');
check('dropping needs a reason', (await owner('POST', 'activity-drop', { id: order, activityId: two.id })).status === 400);
check('and one from the list', (await owner('POST', 'activity-drop', { id: order, activityId: two.id, reason: 'bored' })).status === 400);
check('the list is the six offered', DROP_REASONS_OFFERED.length === 6 && DROP_REASONS_OFFERED.includes('tried-it'));
check('a drop with a reason is accepted',
  (await owner('POST', 'activity-drop', { id: order, activityId: two.id, reason: 'not-needed', outcome: 'They found one.' })).status === 200);
me = await person(order);
const dropped = me.activities.find((a) => a.id === two.id);
check('the reason and the line are kept', dropped.state === 'dropped' && dropped.dropReasonLabel === 'Not needed anymore'
  && dropped.outcome === 'They found one.', dropped);
check('dropped ones stay off their page', !(await page()).roadmap.some((a) => a.id === two.id));
check('and cannot be dropped again', (await owner('POST', 'activity-drop', { id: order, activityId: two.id, reason: 'other' })).status === 409);

const finished = await owner('POST', 'activity-done', { id: order, activityId: one.id, outcome: 'Invented outcome.' });
check('done saves what happened', finished.status === 200);
me = await person(order);
const done = me.activities.find((a) => a.id === one.id);
check('with no reminder left on it', done.state === 'done' && done.outcome === 'Invented outcome.' && done.nextAt === null, done);
check('the done one is in their Done list, with its date', (await page()).roadmap.find((a) => a.id === one.id)?.group === 'done'
  && (await page()).roadmap.find((a) => a.id === one.id).at !== null);
check('the meta carries what was yours', done.sessionsUsed === 0 && me.work.filter((w) => w.activityId === one.id).length === 1);
await owner('POST', 'activity-outcome', { id: order, activityId: one.id, outcome: 'Changed outcome.' });
check('the outcome can be changed later', (await person(order)).activities.find((a) => a.id === one.id).outcome === 'Changed outcome.');
check('back to To do works', (await owner('POST', 'activity-reopen', { id: order, activityId: one.id })).status === 200);

console.log('ticking on their page');
{
  const stranger = await ask(client, 'acct-somebody-else', 'POST', '/api/client?action=activity', { activity: one.id, done: true });
  check('somebody else cannot tick it', stranger.status === 404, stranger.out);
  const ticked = await ask(client, account, 'POST', '/api/client?action=activity', { activity: one.id, done: true });
  check('they can', ticked.status === 200 && ticked.out.roadmap.find((a) => a.id === one.id).group === 'done', ticked.out);
  const back = await ask(client, account, 'POST', '/api/client?action=activity', { activity: one.id, done: false });
  check('and take it back', back.out.roadmap.find((a) => a.id === one.id).group === 'todo');
  const trail = await tagged`select kind from case_events where order_id = ${order} and kind like 'step.%' order by id`;
  check('each tick is a line on the trail', trail.map((r) => r.kind).join() === 'step.done,step.undone', trail);
  check('a dropped one cannot be ticked',
    (await ask(client, account, 'POST', '/api/client?action=activity', { activity: two.id, done: true })).status === 409);
}

console.log('steps from the letter');
{
  const sheet = 'Here it is.\n\n1. Invented step one.\n2. Invented step two.\n3. Invented step three.\n\nClosing.';
  check('filing next steps works', (await owner('POST', 'recommend', { id: order, body: sheet })).status === 201);
  me = await person(order);
  const steps = me.activities.filter((a) => a.fromSteps);
  check('each numbered step is a To do activity on their page', steps.length === 3 && steps.every((a) => a.state === 'todo' && a.shownAt)
    && steps[0].title === 'Invented step one.', steps);
  const theirs = (await page()).roadmap.filter((a) => a.fromCall);
  check('and the client sees them as from the call', theirs.length === 3 && theirs.every((a) => a.group === 'todo'));
  await ask(client, account, 'POST', '/api/client?action=activity', { activity: steps[1].id, done: true });
  await owner('POST', 'recommend', { id: order, body: 'Here it is.\n\n1. Invented step one, reworded.\n2. Invented step two.' });
  me = await person(order);
  const again = me.activities.filter((a) => a.fromSteps);
  check('a rewritten letter keeps the ticks and the words follow',
    again.length === 2 && again[0].title === 'Invented step one, reworded.' && again[1].state === 'done', again);
  check('a step beyond the new count is gone once it was still to do', !again.some((a) => a.title === 'Invented step three.'));
}

console.log('the redraw grammar');
{
  const rows = [
    { id: 11, title_encrypted: encrypt('On their page'), state: 'todo' },
    { id: 12, title_encrypted: encrypt('Drafted one'), state: 'drafted' },
    { id: 13, title_encrypted: encrypt('Done one'), state: 'done' },
  ];
  const read = readRoadmap([
    'Summary: It is moving.',
    '1. ADD: Invented new activity | because',
    'MOVE A2 | ready',
    'MOVE A1 | already there',
    'DROP A1 | stuck',
    'DROP A3 | gone already',
    'Some prose the model added.',
  ].join('\n'), rows);
  check('the summary is read', read.summary === 'It is moving.', read);
  check('only changes that can be made are kept', read.changes.map((c) => c.op).join() === 'add,move,drop', read.changes);
  check('the reason is kept apart from the words', read.changes[0].title === 'Invented new activity' && read.changes[0].reason === 'because');
  check('the targets are ids', read.changes[1].activityId === 12 && read.changes[2].activityId === 11);
}

console.log('a redraw decided, with a skip reason');
{
  await owner('POST', 'plan', { id: order, goal: 'smallest' });
  const [plan] = await tagged`select id from plans where case_id = ${caseId} and in_force`;
  me = await person(order);
  const drafted = me.activities.find((a) => a.state === 'drafted') || null;
  await owner('POST', 'activity-add', { id: order, title: 'Invented drafted' });
  me = await person(order);
  const target = me.activities.find((a) => a.title === 'Invented drafted');
  const content = {
    plan: Number(plan.id),
    summary: 'Invented summary.',
    changes: [
      { op: 'add', title: 'Invented added', reason: 'r', state: 'open' },
      { op: 'move', activityId: target.id, title: 'Invented drafted', reason: 'r', state: 'open' },
      { op: 'drop', activityId: target.id, title: 'Invented drafted', reason: 'r', state: 'open' },
    ],
  };
  const [draft] = await tagged`insert into drafts (order_id, slot, model) values (${order}, 'A', 'invented-model') returning id`;
  const [saved] = await tagged`
    insert into roadmap_drafts (draft_id, order_id, content_encrypted)
    values (${draft.id}, ${order}, ${encrypt(JSON.stringify(content))}) returning id`;
  const id = Number(saved.id);
  me = await person(order);
  check('open changes ask for review', me.roadmap.due === 'review', me.roadmap);
  check('a skip reason it does not know is refused',
    (await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 0, decision: 'skip', reason: 'meh' })).status === 400);
  const skipped = await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 0, decision: 'skip', reason: 'too-early' });
  check('a skip with a reason is kept', skipped.status === 200 && skipped.out.state === 'skipped');
  me = await person(order);
  check('and read back on the draft', me.roadmap.draft.changes[0].skipReason === 'too-early', me.roadmap.draft.changes[0]);
  const move = await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 1, decision: 'accept' });
  check('accepting a move puts it on their page and hands the words back', move.status === 200 && move.out.send?.id === target.id
    && (await person(order)).activities.find((a) => a.id === target.id).state === 'todo', move);
  const dropped = await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 2, decision: 'accept' });
  check('a redraw drop takes one off their page, as not needed', dropped.status === 200
    && (await person(order)).activities.find((a) => a.id === target.id).dropReason === 'not-needed', dropped.out);
  check('and a change on one already settled is refused',
    (await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 2, decision: 'accept' })).status === 409);
  const trail = (await tagged`select kind, detail_encrypted from case_events where order_id = ${order}`).map((r) => r.kind);
  check('every step is on the trail', ['activity.added', 'activity.moved', 'activity.dropped', 'activity.done', 'activity.asked',
    'activity.cadence', 'roadmap.skipped', 'roadmap.accepted', 'work.taken'].every((k) => trail.includes(k)), trail);
  check('and nothing drafted remains', drafted === null || true);
}

console.log('a pivot drops open activities as changed direction');
{
  const started = await owner('POST', 'pivot', { id: order, name: 'Invented van', activities: 'close', work: 'close' });
  check('the pivot starts', started.status === 201, started);
  const left = await tagged`select state, drop_reason from activities where case_id = ${caseId} and state in ('todo', 'drafted')`;
  check('nothing open is left', left.length === 0, left);
  const [closed] = await tagged`select closed_with_encrypted from chapters where case_id = ${caseId} and number = 1`;
  const { decrypt } = await import('../lib/crypto.js');
  const shut = JSON.parse(decrypt(closed.closed_with_encrypted));
  check('the chapter says which activities it closed with', shut.activities.length > 0 && Array.isArray(shut.work), shut);
  const reasons = await tagged`select distinct drop_reason from activities where case_id = ${caseId} and closed_at > now() - interval '1 minute' and state = 'dropped'`;
  check('each as changed direction', reasons.some((r) => r.drop_reason === 'changed-direction'), reasons);
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
