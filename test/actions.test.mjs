import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const { CADENCES, CADENCES_OFFERED, nextDueAt } = await import('../lib/desk.js');

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

console.log('');
console.log('actions, outcomes and a cadence');

const account = 'acct-actions-1';
const rows = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision, client_account_id)
  values ('h-actions', 'c-actions', 700, 'wise', 'RACTIONS01', 'confirmed', 'go', ${account})
  returning id`;
const order = Number(rows[0].id);
const caseId = await db.caseForAccount(account);
await tagged`update orders set case_id = ${caseId} where id = ${order}`;

check('a path can be set', (await press('plan', { id: order, path: 'smallest' })).status === 200);
check('and a milestone under it',
  (await press('milestone-add', { id: order, title: 'Set a rate per job' })).status === 201);

let person = await ask(`/api/desk?action=person&id=${order}`);
const step = person.milestones[0];
check('a milestone with nothing under it comes back with an empty list, not undefined',
  Array.isArray(step.actions) && step.actions.length === 0, step.actions);

check('an action needs words', (await press('action-add', {
  id: order, milestoneId: step.id, title: '   ',
})).status === 400);
check('and a cadence it knows', (await press('action-add', {
  id: order, milestoneId: step.id, title: 'Ask the garage', cadence: 'hourly',
})).status === 400);
check('a milestone under somebody else is not reachable', (await press('action-add', {
  id: order, milestoneId: step.id + 9999, title: 'Ask the garage',
})).status === 404);

check('adding one is accepted', (await press('action-add', {
  id: order, milestoneId: step.id, title: 'Ask the garage what they paid', cadence: 'weekly',
})).status === 201);
check('and one with no reminder on it', (await press('action-add', {
  id: order, milestoneId: step.id, title: 'Write the rate on a card',
})).status === 201);

person = await ask(`/api/desk?action=person&id=${order}`);
{
  const [unsent] = person.milestones[0].actions;
  check('a new action is not sent yet, and has no date',
    unsent.shownAt === null && unsent.nextAt === null, unsent);
  check('so asking about it is refused',
    (await press('action-push', { id: order, actionId: unsent.id })).status === 409);
  const sent = await press('reply', {
    id: order, body: 'Your next step:\n• Ask the garage what they paid\n• Write the rate on a card',
    actions: person.milestones[0].actions.map((a) => a.id),
  });
  check('sending them in a message marks both sent', sent.status === 201 && sent.out.sent === 2, sent);
}
person = await ask(`/api/desk?action=person&id=${order}`);
const [first, second] = person.milestones[0].actions;
check('both come back under the milestone, in the order they were added',
  person.milestones[0].actions.length === 2
  && first.title === 'Ask the garage what they paid'
  && second.title === 'Write the rate on a card', person.milestones[0].actions);
check('the one with a cadence carries a date and a label',
  first.cadence === 'weekly' && first.nextAt !== null
  && first.cadenceLabel === 'Every week', first);
check('and it is not due yet, because a week has not passed',
  first.due === false, [first.due, first.nextAt]);
check('the one with no reminder has no date at all',
  second.cadence === 'none' && second.nextAt === null && second.due === false, second);

check('nothing is due yet', (await ask('/api/desk?action=today')).due.length === 0);

await tagged`update action_items set next_at = now() - interval '2 days' where id = ${first.id}`;
const today = await ask('/api/desk?action=today');
check('a date that has passed puts it on the first screen',
  today.due.length === 1 && Number(today.due[0].actionId) === first.id, today.due);
check('with the words, the step it is under, and how often it comes back',
  today.due[0].title === 'Ask the garage what they paid'
  && today.due[0].milestone === 'Set a rate per job'
  && today.due[0].cadenceLabel === 'Every week', today.due[0]);

person = await ask(`/api/desk?action=person&id=${order}`);
check('and the record says it is due rather than making the screen work it out',
  person.milestones[0].actions[0].due === true);

const pushed = await press('action-push', { id: order, actionId: first.id });
check('pushing it is accepted', pushed.status === 200, pushed);
check('the new date is a full cycle from today, not from the date it was due',
  Math.abs(new Date(pushed.out.nextAt).getTime() - new Date(nextDueAt('weekly')).getTime())
    < 60_000, pushed.out.nextAt);
check('so it comes off the first screen', (await ask('/api/desk?action=today')).due.length === 0);
const askedNone = await press('action-push', { id: order, actionId: second.id });
check('an action with no reminder can still be asked about, and gets no date',
  askedNone.status === 200 && askedNone.out.nextAt === null && askedNone.out.askedAt, askedNone);
person = await ask(`/api/desk?action=person&id=${order}`);
const wasAsked = person.milestones[0].actions.find((a) => a.id === first.id);
check('the record says when it was last asked', wasAsked.askedAt !== null
  && Math.abs(new Date(wasAsked.askedAt).getTime() - Date.now()) < 60_000, wasAsked);
check('and the line on the trail names the action',
  person.events.some((e) => e.kind === 'action.asked' && e.detail === 'Write the rate on a card'), person.events);

console.log('');
console.log('cadence arithmetic');
const from = new Date('2026-10-07T12:00:00Z');
const days = (cadence) => (nextDueAt(cadence, from) === null ? null
  : (new Date(nextDueAt(cadence, from)) - from) / 86_400_000);
check('every day comes back a day later', days('daily') === 1, days('daily'));
check('every 3 days, three days later', days('three-days') === 3, days('three-days'));
check('every week, seven', days('weekly') === 7, days('weekly'));
check('the older two still work: fourteen and thirty',
  days('fortnightly') === 14 && days('monthly') === 30, [days('fortnightly'), days('monthly')]);
check('no reminder has no date', days('none') === null);
check('the picker offers the four in the design, in order',
  JSON.stringify(CADENCES_OFFERED) === JSON.stringify(['none', 'daily', 'three-days', 'weekly']), CADENCES_OFFERED);
check('and every one it offers is a cadence the server knows', CADENCES_OFFERED.every((c) => CADENCES[c]));
check('the record carries the four, labeled', JSON.stringify(person.cadenceChoices.map((c) => c.label))
  === JSON.stringify(['No reminder', 'Every day', 'Every 3 days', 'Every week']), person.cadenceChoices);

check('a reminder it does not know is refused',
  (await press('action-cadence', { id: order, actionId: second.id, cadence: 'hourly' })).status === 400);
const changed = await press('action-cadence', { id: order, actionId: second.id, cadence: 'three-days' });
check('changing the reminder is accepted, and dates it from today',
  changed.status === 200 && Math.abs(new Date(changed.out.nextAt) - new Date(nextDueAt('three-days'))) < 60_000, changed);
await tagged`update action_items set cadence = 'fortnightly' where id = ${first.id}`;
person = await ask(`/api/desk?action=person&id=${order}`);
check('an older reminder still reads with its label',
  person.milestones[0].actions.find((a) => a.id === first.id).cadenceLabel === 'Every two weeks');
const restarted = await press('action-push', { id: order, actionId: first.id });
check('and asking restarts it a full fourteen days from today',
  Math.abs(new Date(restarted.out.nextAt) - new Date(nextDueAt('fortnightly'))) < 60_000, restarted);
const back = await press('action-cadence', { id: order, actionId: second.id, cadence: 'none' });
check('no reminder takes the date off', back.status === 200 && back.out.nextAt === null, back);

check('a status it does not know is refused',
  (await press('action-record', { id: order, actionId: first.id, status: 'finished' })).status === 400);

check('closing it out is accepted', (await press('action-record', {
  id: order, actionId: first.id, status: 'done', outcome: 'They paid 400 for the last one.',
})).status === 200);

person = await ask(`/api/desk?action=person&id=${order}`);
const closed = person.milestones[0].actions.find((a) => a.id === first.id);
check('the words are kept beside the status',
  closed.status === 'done' && closed.outcome === 'They paid 400 for the last one.'
  && closed.closedAt !== null, closed);
check('and its date is gone', closed.nextAt === null && closed.due === false, closed);
check('a closed one cannot be pushed',
  (await press('action-push', { id: order, actionId: first.id })).status === 409);

check('dropping one is accepted', (await press('action-record', {
  id: order, actionId: second.id, status: 'dropped', outcome: 'Carrying a card is not how they work.',
})).status === 200);

check('reopening it is accepted', (await press('action-record', {
  id: order, actionId: first.id, status: 'open',
})).status === 200);
person = await ask(`/api/desk?action=person&id=${order}`);
const reopened = person.milestones[0].actions.find((a) => a.id === first.id);
check('and it is back on its cadence with a fresh date',
  reopened.status === 'open' && reopened.nextAt !== null && reopened.closedAt === null,
  reopened);

const trail = person.events.map((e) => e.kind);
check('every one of those is a line on the record',
  trail.includes('action.added') && trail.includes('action.recorded')
  && trail.includes('action.asked') && trail.includes('action.cadence'), trail);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
