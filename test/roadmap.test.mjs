import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const client = (await import('../api/client.js')).default;
const { readRoadmap } = await import('../lib/desk-roadmap.js');

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
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
}
const owner = (method, action, payload) => ask(desk, 'admin-1', method, `/api/desk?action=${action}`, payload);
const person = async (id) => (await owner('GET', `person&id=${id}`)).out;

const account = 'acct-roadmap-1';
const [row] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status, decision, approved_as_client_at)
  values ('rm-1', 'rmc-1', 700, 'wise', 'RMAP0000001', 'confirmed', 'go', now())
  returning id`;
const order = Number(row.id);
const caseId = await db.caseForAccount(account);
await tagged`update orders set client_account_id = ${account}, case_id = ${caseId} where id = ${order}`;

console.log('');
console.log('the roadmap');

check('no goal, nothing to draw', (await owner('POST', 'roadmap-draft', { id: order })).status === 409);
await owner('POST', 'plan', { id: order, path: 'smallest' });
await owner('POST', 'milestone-add', { id: order, title: 'Invented first step' });
await owner('POST', 'milestone-add', { id: order, title: 'Invented second step' });
let me = await person(order);
const [one, two] = me.milestones;
check('a new milestone is not on their page', one.shownAt === null && two.shownAt === null, me.milestones);
check('the record carries a roadmap with nothing due', me.roadmap && me.roadmap.due === null, me.roadmap);

const page = async () => (await ask(client, account, 'GET', '/api/client?action=mine')).out;
check('their page has no milestones yet', !(await page()).path.some((p) => p.kind === 'Milestone'));
check('showing one is accepted',
  (await owner('POST', 'milestone-show', { id: order, milestoneId: one.id })).status === 200);
const shown = (await page()).path.filter((p) => p.kind === 'Milestone');
check('and only that one reaches their page', shown.length === 1 && shown[0].title === 'Invented first step', shown);
await owner('POST', 'milestone-show', { id: order, milestoneId: one.id, shown: false });
check('hiding takes it back off', !(await page()).path.some((p) => p.kind === 'Milestone'));
await owner('POST', 'milestone-show', { id: order, milestoneId: one.id });

await owner('POST', 'action-add', { id: order, milestoneId: one.id, title: 'Invented action' });
me = await person(order);
check('an action waiting with nothing sent asks for the next one to go out', me.roadmap.due === 'send', me.roadmap);
check('so Do this next has it', me.milestones[0].actions[0].shownAt === null);

check('drafting with no model set up says so',
  (await owner('POST', 'roadmap-draft', { id: order })).status === 503);

{
  const rows = {
    milestones: [
      { id: 11, title_encrypted: encrypt('Shown step'), shown_at: new Date() },
      { id: 12, title_encrypted: encrypt('Hidden step'), shown_at: null },
    ],
    actions: [
      { id: 21, milestone_id: 11, title_encrypted: encrypt('Sent action'), status: 'open', shown_at: new Date() },
      { id: 22, milestone_id: 12, title_encrypted: encrypt('Waiting action'), status: 'open', shown_at: null },
    ],
  };
  const read = readRoadmap([
    'Summary: It is moving.',
    '1. ADD MILESTONE: Invented new step | because',
    'ADD ACTION under NEW 1: Invented new action | why',
    'ADD ACTION under M1: Under the shown one',
    'SHOW M2 | ready',
    'SHOW M1 | already shown',
    'SEND A1 | already sent',
    'SEND A2 | next',
    'DROP A9 | nothing there',
    'Some prose the model added.',
  ].join('\n'), rows);
  check('the summary is read', read.summary === 'It is moving.', read);
  check('only changes that can be made are kept',
    read.changes.map((c) => c.op).join(',') === 'add-milestone,add-action,add-action,show-milestone,send-action', read.changes);
  check('an action under a new milestone points at that change',
    read.changes[1].change === 0 && read.changes[1].under === 'Invented new step', read.changes[1]);
  check('the reason is kept apart from the words',
    read.changes[0].title === 'Invented new step' && read.changes[0].reason === 'because', read.changes[0]);
  check('the targets are ids', read.changes[3].milestoneId === 12 && read.changes[4].actionId === 22, read.changes);
}

{
  const [plan] = await tagged`select id from plans where case_id = ${caseId} and in_force`;
  const waiting = me.milestones[0].actions[0];
  const content = {
    plan: Number(plan.id),
    summary: 'Invented summary.',
    changes: [
      { op: 'add-milestone', title: 'Invented added step', reason: 'r', state: 'open' },
      { op: 'add-action', title: 'Invented added action', reason: 'r', change: 0, under: 'Invented added step', state: 'open' },
      { op: 'show-milestone', milestoneId: two.id, title: 'Invented second step', reason: 'r', state: 'open' },
      { op: 'send-action', actionId: waiting.id, title: 'Invented action', reason: 'r', state: 'open' },
      { op: 'drop-action', actionId: waiting.id, title: 'Invented action', reason: 'r', state: 'open' },
    ],
  };
  const [draft] = await tagged`insert into drafts (order_id, slot, model) values (${order}, 'A', 'invented-model') returning id`;
  const [saved] = await tagged`
    insert into roadmap_drafts (draft_id, order_id, content_encrypted)
    values (${draft.id}, ${order}, ${encrypt(JSON.stringify(content))}) returning id`;
  const id = Number(saved.id);
  me = await person(order);
  check('a draft with open changes asks for review', me.roadmap.due === 'review' && me.roadmap.draft.changes.length === 5, me.roadmap);

  const early = await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 1, decision: 'accept' });
  check('an action under a milestone not accepted yet waits for it', early.status === 409, early);
  const added = await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 0, decision: 'accept', title: 'Invented step, reworded' });
  check('accepting a milestone adds it, with the words as changed', added.status === 200, added);
  await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 1, decision: 'accept' });
  me = await person(order);
  const third = me.milestones.find((m) => m.title === 'Invented step, reworded');
  check('hidden, with the action under it', third && third.shownAt === null
    && third.actions[0]?.title === 'Invented added action' && third.actions[0].shownAt === null, me.milestones);

  await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 2, decision: 'accept' });
  check('accepting a show puts it on their page',
    (await page()).path.filter((p) => p.kind === 'Milestone').length === 2);

  const send = await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 3, decision: 'accept' });
  check('accepting a send hands the action back to write into a message',
    send.status === 200 && send.out.send?.id === waiting.id, send);
  me = await person(order);
  check('without sending it on its own', me.milestones[0].actions[0].shownAt === null);

  const twice = await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 3, decision: 'skip' });
  check('a change is decided once', twice.status === 409, twice);
  await owner('POST', 'roadmap-decide', { id: order, draft: id, index: 4, decision: 'skip' });
  me = await person(order);
  check('every change decided, nothing to review',
    me.roadmap.draft.changes.every((c) => c.state !== 'open') && me.roadmap.due !== 'review', me.roadmap);

  await owner('POST', 'reply', { id: order, body: 'Your next step:\n• Invented action', actions: [waiting.id] });
  me = await person(order);
  const sent = me.milestones[0].actions[0];
  check('the message marks it sent', sent.shownAt !== null, sent);
  check('their page still has no actions on it', !(await page()).path.some((p) => p.kind === 'Action'));

  await owner('POST', 'action-record', { id: order, actionId: sent.id, status: 'done', outcome: 'Invented outcome.' });
  me = await person(order);
  check('an outcome after the draft asks for a redraw', me.roadmap.due === 'redraw', me.roadmap);
  check('and Do this next can say so', me.roadmap.draft.id === id);

  const trail = await tagged`select kind from case_events where order_id = ${order}`;
  const kinds = new Set(trail.map((t) => t.kind));
  check('every step is on the trail',
    ['milestone.shown', 'milestone.hidden', 'action.sent', 'roadmap.accepted', 'roadmap.skipped'].every((k) => kinds.has(k)), [...kinds]);
}

const failures = failureCount();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
