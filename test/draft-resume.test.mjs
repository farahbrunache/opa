import { check, db, failureCount, seedPrompts, tagged } from './harness.mjs';

await db.ensureSchema();
await seedPrompts();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.DRAFT_MODEL_A_NAME = 'a-test-model';
process.env.DRAFT_MODEL_A_URL = 'https://api.runpod.ai/v2/a-test-endpoint';
process.env.DRAFT_MODEL_A_KEY = 'a-test-key';

const { signSession, encrypt, decrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const jobs = await import('../lib/draft-jobs.js');
const { DRAFTS_PER_ORDER } = await import('../lib/draft.js');

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (run, ms, ...rest) => realSetTimeout(run, ms === 1_500 ? 5 : ms, ...rest);

let submits = 0;
let statusAnswer = () => ({ status: 'IN_QUEUE' });
const realFetch = globalThis.fetch;
globalThis.fetch = async (address, init) => {
  const url = String(address);
  if (url.endsWith('/run') && init?.method === 'POST') {
    submits += 1;
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

async function newOrder(ref) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${`h-${ref}`}, ${`c-${ref}`}, 700, 'wise', ${ref}, 'confirmed')
    returning id`;
  const id = Number(row.id);
  await tagged`insert into calls (order_id, call_id, transcript_encrypted)
               values (${id}, ${`call-${ref}`}, ${encrypt('Agent: What do you do?\nCaller: I fix bikes.')})`;
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
console.log('a catch-up is saved');
{
  const made = await tagged`insert into cases (account_id) values ('acct-draft') returning id`;
  await tagged`update orders set case_id = ${Number(made[0].id)}, decision = 'go',
                 decision_at = now(), recommendations_encrypted = ${encrypt('Charge per job.')},
                 recommendations_written_at = now()
                where id = ${order}`;
  await tagged`insert into drafts (order_id, slot, model, job_id) values (${order}, 'A', 'a-test-model', 'sheet-job')`;
  const before = submits;
  statusAnswer = (job) => (job === `job-${before + 1}`
    ? { status: 'COMPLETED', output: { content: 'Go. Next steps written. Nothing moved since.' } }
    : { status: 'IN_QUEUE' });
  const recap = await pressDraft(order, 'recap');
  check('a catch-up starts', recap.status === 202, recap);
  check('its own job rather than a sheet job in flight', submits === before + 1, [before, submits]);
  await jobs.follow(recap.out.draftId);
  const saved = await tagged`
    select r.content_encrypted, d.kind from recaps r join drafts d on d.id = r.draft_id
     where r.order_id = ${order}`;
  check('its words are saved against the draft that says what it cost',
    saved.length === 1 && saved[0].kind === 'recap'
      && decrypt(saved[0].content_encrypted) === 'Go. Next steps written. Nothing moved since.',
    saved);
  check('and the record does not offer it again, because it is already saved',
    !(await offered(order)).some((j) => j.kind === 'recap'));
}

console.log('');
console.log('call lines do not pick up a sheet job');
{
  const [call] = await tagged`
    insert into calls (order_id, call_id, transcript_encrypted, ended_at)
    values (${order}, 'call-lines', ${encrypt('I bake bread.')}, now()) returning id`;
  const before = submits;
  statusAnswer = (job) => (job === `job-${before + 1}`
    ? { status: 'COMPLETED', output: { content: 'Trade: Baker' } }
    : { status: 'COMPLETED', output: { content: 'A sheet.' } });
  const pressed = await desk('POST', 'call-fields-draft', { id: order, call: Number(call.id) });
  check('call lines start their own job', submits === before + 1, [before, submits, pressed]);
  await jobs.settleAll();
  const out = await result(pressed.out.draftId);
  check('and come back as the four lines', out.payload?.fields?.trade === 'Baker', out);
  const saved = await desk('POST', 'call-fields', { id: order, call: Number(call.id), fields: { trade: 'Baker' } });
  check('saving the lines', saved.status === 200, saved);
  check('marks the draft used', !(await offered(order)).some((j) => j.kind === `fields:${call.id}`));
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
