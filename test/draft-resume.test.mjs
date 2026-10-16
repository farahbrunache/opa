import { check, db, failureCount, seedPrompts, tagged, useSlot } from './harness.mjs';

await db.ensureSchema();
await useSlot('A', 'a-test-endpoint', 'a-test-model');
await seedPrompts();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.RUNPOD_API_KEY = 'a-test-key';

const { signSession, encrypt, decrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const jobs = await import('../lib/draft-jobs.js');
const { DRAFTS_PER_ORDER } = await import('../lib/draft.js');

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (run, ms, ...rest) => realSetTimeout(run, ms === 1_500 ? 5 : ms, ...rest);

let submits = 0;
let lastRun = null;
let statusAnswer = () => ({ status: 'IN_QUEUE' });
const realFetch = globalThis.fetch;
globalThis.fetch = async (address, init) => {
  const url = String(address);
  if (url.endsWith('/run') && init?.method === 'POST') {
    submits += 1;
    lastRun = String(init.body || '');
    return { ok: true, text: async () => JSON.stringify({ id: `job-${submits}` }) };
  }
  if (url.includes('/status/')) {
    const job = url.slice(url.lastIndexOf('/') + 1);
    return { ok: true, text: async () => JSON.stringify(statusAnswer(job)) };
  }
  return realFetch(address, init);
};

function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null,
    setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}

async function desk(method, action, body) {
  const req = {
    method,
    url: `/api/desk?action=${action}`,
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  if (body) {
    const stream = Readable.from([JSON.stringify(body)]);
    Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  }
  const res = fakeRes();
  try {
    await deskEndpoint(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

const pressDraft = (id, of = 'sheet') => desk('POST', 'draft', { id, of });
const result = async (draftId) => (await desk('GET', `draft-result&id=${draftId}`)).out;
const offered = async (id) => (await desk('GET', `person&id=${id}`)).out.drafting.jobs;

async function newOrder(ref, { strategy = true } = {}) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${`h-${ref}`}, ${`c-${ref}`}, 700, 'wise', ${ref}, 'confirmed')
    returning id`;
  const id = Number(row.id);
  await tagged`insert into calls (order_id, call_id, transcript_encrypted)
               values (${id}, ${`call-${ref}`}, ${encrypt('Agent: What do you do?\nCaller: I fix bikes.')})`;
  if (strategy) {
    await tagged`insert into strategies (order_id, version, body_encrypted, takeaways_encrypted)
                 values (${id}, 1, ${encrypt('Invented strategy.')}, ${encrypt('[]')})`;
  }
  return id;
}

const order = await newOrder('RDRAFT0001');

console.log('');
console.log('a press hands the job to the server');

statusAnswer = () => ({ status: 'IN_QUEUE' });
const started = Date.now();
const first = await pressDraft(order);
check('the press answers at once while RunPod still has it queued',
  first.status === 202 && first.out?.state === 'running' && Number.isInteger(first.out?.draftId)
    && Date.now() - started < 5000, first);
check('one job was submitted', submits === 1, submits);
check('and it reads as running', (await result(first.out.draftId)).state === 'running');

{
  const before = await tagged`select coalesce(sum(hits), 0)::int as n from rate_limits`;
  const second = await pressDraft(order);
  const after = await tagged`select coalesce(sum(hits), 0)::int as n from rate_limits`;
  check('pressing again while it runs hands back the same draft',
    second.status === 202 && second.out.draftId === first.out.draftId, second);
  check('and submits no second job', submits === 1, submits);
  check('and spends nothing against the limit', before[0].n === after[0].n, [before[0].n, after[0].n]);
}

const running = (await offered(order)).find((j) => j.kind === null);
check('the record shows it running', running?.state === 'running' && running.draftId === first.out.draftId, running);

statusAnswer = (job) => (job === 'job-1'
  ? { status: 'COMPLETED', output: { content: 'Ask for a rate per job. Post it this week.' } }
  : { status: 'IN_QUEUE' });
await jobs.settleAll();

const ready = await result(first.out.draftId);
check('the result is ready with nobody waiting on a request',
  ready.state === 'ready' && ready.payload?.content === 'Ask for a rate per job. Post it this week.', ready);
check('and it says what ran it', ready.model === 'a-test-model' && Number.isInteger(ready.seconds), ready);

let row = await tagged`select job_id, finished_at from drafts where order_id = ${order}`;
check('one row, finished, for one job',
  row.length === 1 && row[0].finished_at !== null && row[0].job_id === 'job-1', row);
check('the worker is charged once', (await tagged`select 1 from spend where kind = 'draft'`).length === 1);

const stored = await tagged`select result_encrypted from draft_jobs where draft_id = ${first.out.draftId}`;
check('the result is sealed at rest', stored.length === 1 && !stored[0].result_encrypted.includes('rate'), stored);

console.log('');
console.log('a ready draft waits on the record until it is sent');
{
  const waiting = (await offered(order)).find((j) => j.kind === null);
  check('the record offers it', waiting?.state === 'ready' && waiting.payload?.content.startsWith('Ask'), waiting);
  const sent = await desk('POST', 'recommend', { id: order, body: 'Ask for a rate per job, edited.' });
  check('next steps are sent', sent.status === 201, sent);
  const after = (await offered(order)).find((j) => j.kind === null);
  check('and the record stops offering the draft', !after, after);
  const [used] = await tagged`select used_at from draft_jobs where draft_id = ${first.out.draftId}`;
  check('because it is marked used', used.used_at !== null, used);
}

console.log('');
console.log('a failed job says why');
{
  statusAnswer = () => ({ status: 'FAILED', error: 'the worker ran out of memory' });
  const failed = await pressDraft(order);
  check('the press still answers at once', failed.status === 202, failed);
  check('a new job, because the first was finished', submits === 2, submits);
  await jobs.settleAll();
  const out = await result(failed.out.draftId);
  check('it reads as failed with the job and RunPod\'s reason',
    out.state === 'failed' && /job-2/.test(out.failure) && /out of memory/.test(out.failure), out);
  const [closed] = await tagged`select gave_up_at, failure from drafts where id = ${failed.out.draftId}`;
  check('the row is closed and keeps the reason', closed.gave_up_at !== null && /out of memory/.test(closed.failure), closed);
  check('and the worker is charged for it once',
    (await tagged`select 1 from spend where source = ${`draft:${failed.out.draftId}`}`).length === 1);
  const shown = (await offered(order)).find((j) => j.kind === null);
  check('the record shows the failure', shown?.state === 'failed' && /out of memory/.test(shown.failure), shown);
}

console.log('');
console.log('a job left in flight by a restart is picked up again');
{
  statusAnswer = () => ({ status: 'IN_QUEUE' });
  const [orphan] = await tagged`
    insert into drafts (order_id, slot, model, job_id, kind)
    values (${order}, 'A', 'a-test-model', 'left-behind', 'summary') returning id`;
  await tagged`insert into draft_jobs (draft_id, context_encrypted) values (${orphan.id}, ${encrypt('{}')})`;
  const resumed = await jobs.sweep();
  check('the sweep follows it', resumed === 1, resumed);
  check('and a second sweep does not follow it twice', (await jobs.sweep()) === 0);
  statusAnswer = (job) => (job === 'left-behind'
    ? { status: 'COMPLETED', output: { content: 'Worth a lot to a shop that has no mechanic.' } }
    : { status: 'IN_QUEUE' });
  await jobs.settleAll();
  const out = await result(Number(orphan.id));
  check('and finishes it', out.state === 'ready' && out.payload.content.startsWith('Worth'), out);
}

console.log('');
console.log('two followers of one job store one result');
{
  statusAnswer = () => ({ status: 'IN_QUEUE' });
  const pressed = await desk('POST', 'draft', { id: order });
  check('a press', pressed.status === 202, pressed);
  const firstFollower = jobs.settleAll();
  jobs.forgetFollows();
  check('a restart sweep starts a second follower', (await jobs.sweep()) === 1);
  statusAnswer = () => ({ status: 'COMPLETED', output: { content: '1. Worth more than the going rate.' } });
  await Promise.all([firstFollower, jobs.settleAll()]);
  const out = await result(pressed.out.draftId);
  check('one result is ready', out.state === 'ready' && out.payload.content === '1. Worth more than the going rate.', out);
  check('one result row', (await tagged`select 1 from draft_jobs where draft_id = ${pressed.out.draftId}`).length === 1);
  check('and the worker is charged once',
    (await tagged`select 1 from spend where source = ${`draft:${pressed.out.draftId}`}`).length === 1);
}

console.log('');
console.log('a job nothing starts is given up after ten minutes');
{
  statusAnswer = () => ({ status: 'IN_QUEUE' });
  const [late] = await tagged`
    insert into drafts (order_id, slot, model, job_id, kind, created_at)
    values (${order}, 'A', 'a-test-model', 'never-started', 'matches', now() - interval '11 minutes')
    returning id`;
  await tagged`insert into draft_jobs (draft_id, context_encrypted) values (${late.id}, ${encrypt('{}')})`;
  await jobs.follow(late.id);
  const out = await result(Number(late.id));
  check('it fails, saying it sat queued for ten minutes',
    out.state === 'failed' && /queued/.test(out.failure) && /10 minutes/.test(out.failure)
      && /never-started/.test(out.failure), out);
}

console.log('');
console.log('next steps are drafted from the strategy');
{
  const bare = await newOrder('RDRAFTBARE', { strategy: false });
  const before = submits;
  const refused = await pressDraft(bare);
  check('with no strategy the press is refused and says to write it first',
    refused.status === 409 && /strategy first/.test(refused.out?.error) && submits === before, refused);
  statusAnswer = () => ({ status: 'COMPLETED', output: { content: 'A sheet.' } });
  const pressed = await pressDraft(order);
  check('with one, it reads the strategy and not the call',
    pressed.status === 202 && lastRun.includes('Invented strategy.') && !lastRun.includes('I fix bikes'), lastRun);
  await jobs.settleAll();
}

console.log('');
console.log('a strategy is drafted, saved and kept in versions');
{
  const fresh = await newOrder('RDRAFTSTRAT', { strategy: false });
  const before = submits;
  statusAnswer = (job) => (job === `job-${before + 1}`
    ? { status: 'COMPLETED', output: { content: 'The problem\nInvented problem.\n\nKey takeaways:\n- First point.\n- Second point.' } }
    : { status: 'COMPLETED', output: { content: 'The problem\nRevised.\nWhat changed: Invented change.\nKey takeaways:\n- Third point.' } });
  const pressed = await desk('POST', 'strategy-draft', { id: fresh });
  check('a first draft reads the calls', pressed.status === 202 && lastRun.includes('I fix bikes'), pressed);
  await jobs.settleAll();
  const out = await result(pressed.out.draftId);
  check('and comes back as the strategy and its takeaways',
    out.payload?.body === 'The problem\nInvented problem.'
      && JSON.stringify(out.payload?.takeaways) === JSON.stringify(['First point.', 'Second point.']), out);
  check('nothing is saved until Save', (await tagged`select 1 from strategies where order_id = ${fresh}`).length === 0);
  check('so the record still offers it', (await offered(fresh)).some((j) => j.kind === 'strategy'));

  const saved = await desk('POST', 'strategy', { id: fresh, body: out.payload.body, takeaways: out.payload.takeaways, after: 0 });
  check('Save makes version 1', saved.status === 201 && saved.out.version === 1, saved);
  check('and marks the draft used', !(await offered(fresh)).some((j) => j.kind === 'strategy'));
  const same = await desk('POST', 'strategy', { id: fresh, body: out.payload.body, takeaways: out.payload.takeaways, after: 1 });
  check('saving the same again is refused', same.status === 409, same);
  const behind = await desk('POST', 'strategy', { id: fresh, body: 'Other.', takeaways: '', after: 0 });
  check('saving over a newer version is refused', behind.status === 409, behind);
  const empty = await desk('POST', 'strategy', { id: fresh, body: '  ', after: 1 });
  check('an empty strategy is refused', empty.status === 400, empty);

  const quiet = await desk('POST', 'strategy-draft', { id: fresh });
  check('a redraft with nothing new since is refused', quiet.status === 409 && /Nothing has come in/.test(quiet.out?.error), quiet);
  await tagged`insert into calls (order_id, call_id, transcript_encrypted, ended_at)
               values (${fresh}, 'call-strat-2', ${encrypt('Caller: Invented later call.')}, now() + interval '1 second')`;
  const again = await desk('POST', 'strategy-draft', { id: fresh });
  check('a redraft reads the current strategy and what is new since',
    again.status === 202 && lastRun.includes('Invented problem.') && lastRun.includes('First point.')
      && lastRun.includes('Invented later call.') && !lastRun.includes('I fix bikes'), lastRun);
  await jobs.settleAll();
  const revised = await result(again.out.draftId);
  check('and comes back with what changed', revised.payload?.changed === 'Invented change.'
    && revised.payload?.body === 'The problem\nRevised.', revised);
  const second = await desk('POST', 'strategy', {
    id: fresh, body: revised.payload.body, takeaways: '- Third point.', changed: revised.payload.changed, after: 1,
  });
  check('Save makes version 2', second.status === 201 && second.out.version === 2, second);
  const view = (await desk('GET', `person&id=${fresh}`)).out.strategy;
  check('the record shows version 2 live and version 1 in history',
    view.live.version === 2 && view.live.changed === 'Invented change.'
      && view.versions.length === 1 && view.versions[0].version === 1 && view.count === 2, view);
  const [sealed] = await tagged`select body_encrypted from strategies where order_id = ${fresh} and version = 2`;
  check('and it is stored sealed', !/Revised/.test(sealed.body_encrypted));
}

console.log('');
console.log('the roadmap redraw reads the strategy');
{
  const road = await newOrder('RDRAFTROAD');
  const [made] = await tagged`insert into cases (account_id) values ('acct-road') returning id`;
  await tagged`update orders set case_id = ${Number(made.id)} where id = ${road}`;
  await tagged`update strategies set case_id = ${Number(made.id)} where order_id = ${road}`;
  await tagged`insert into plans (order_id, case_id, goal) values (${road}, ${Number(made.id)}, 'smallest')`;
  statusAnswer = () => ({ status: 'COMPLETED', output: { content: 'Summary: Invented.' } });
  const pressed = await desk('POST', 'roadmap-draft', { id: road });
  check('its context carries the live strategy', pressed.status === 202 && lastRun.includes('Invented strategy.'), lastRun);
  await jobs.settleAll();

  await tagged`insert into activities (case_id, title_encrypted, state) values (${Number(made.id)}, ${encrypt('Invent a sample flyer for the market')}, 'done')`;
  await desk('POST', 'note', { id: road, note: 'Invented private note.' });
  statusAnswer = () => ({ status: 'COMPLETED', output: { content:
    'Summary: Invented.\nADD: Invent the sample flyers for a market | repeat\nADD: Invented brand new step | fresh' } });
  const again = await desk('POST', 'roadmap-draft', { id: road });
  check('the redraw context carries notes and earlier proposals',
    again.status === 202 && lastRun.includes('Invented private note.') && lastRun.includes('Everything proposed before'), lastRun);
  await jobs.settleAll();
  const [kept] = await tagged`select content_encrypted from roadmap_drafts where order_id = ${road} order by id desc limit 1`;
  const titles = JSON.parse(decrypt(kept.content_encrypted)).changes.map((c) => c.title);
  check('a proposal repeating a done activity is dropped and a new one kept',
    titles.length === 1 && titles[0] === 'Invented brand new step', titles);
}

console.log('');
console.log('the daily limit still holds');
{
  const capped = await newOrder('RDRAFTCAP1');
  statusAnswer = () => ({ status: 'COMPLETED', output: { content: 'Ask a neighbour first.' } });
  let ok = 0;
  for (let i = 0; i < DRAFTS_PER_ORDER; i += 1) {
    const pressed = await pressDraft(capped);
    if (pressed.status === 202) ok += 1;
    await jobs.settleAll();
  }
  const over = await pressDraft(capped);
  check(`${DRAFTS_PER_ORDER} presses start`, ok === DRAFTS_PER_ORDER, ok);
  check('and the next is refused', over.status === 429, over);
}

console.log('');
console.log('expiry');
{
  await tagged`update draft_jobs set created_at = now() - interval '8 days' where draft_id = ${first.out.draftId}`;
  await jobs.sweep();
  const [gone] = await tagged`select result_encrypted, context_encrypted from draft_jobs where draft_id = ${first.out.draftId}`;
  check('a result older than seven days is cleared', gone.result_encrypted === null && gone.context_encrypted === null, gone);
}

{
  const columns = await tagged`select column_name from information_schema.columns where table_name = 'drafts'`;
  check('the drafts table still holds no text',
    !columns.some((c) => /content|body|text|encrypted/.test(c.column_name)), columns.map((c) => c.column_name));
}

await jobs.settleAll();
globalThis.fetch = realFetch;
globalThis.setTimeout = realSetTimeout;
const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
