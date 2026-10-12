import { check, db, failureCount, seedPrompts, tagged, useSlot } from './harness.mjs';

await db.ensureSchema();
await useSlot('A', 'a-test-endpoint', 'a-test-model');
await seedPrompts();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.RUNPOD_API_KEY = 'a-test-key';

const { signSession } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const { seedDemo } = await import('../lib/demo.js');
const { CHECKS } = await import('../lib/desk-ai.js');
const { settleAll } = await import('../lib/draft-jobs.js');

const ANSWER = [
  'Trade: Plumbing repairs',
  'Rate: $9 a visit',
  'In the way: Nobody knows the van',
  'First customer: A neighbour',
  '1. What do you charge for a call-out? Why: the rate is missing',
  '2. Who has paid you before? Why: no first customer yet',
  'ADD: Ask a neighbour | no first customer yet',
].join('\n');

let submits = 0;
let health = 0;
let answer = () => ({ status: 'COMPLETED', output: { content: ANSWER, model: 'a-test-model' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (address, init) => {
  const url = String(address);
  if (url.endsWith('/run') && init?.method === 'POST') {
    submits += 1;
    return { ok: true, text: async () => JSON.stringify({ id: `job-${submits}` }) };
  }
  if (url.includes('/status/')) return { ok: true, text: async () => JSON.stringify(answer()) };
  if (url.endsWith('/health')) {
    health += 1;
    return {
      ok: true,
      text: async () => JSON.stringify({
        jobs: { inQueue: 0, inProgress: 0, failed: 1 },
        workers: { ready: 0, idle: 0, running: 0, initializing: 0, throttled: 0, unhealthy: 0 },
      }),
    };
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

console.log('with no demo data');
{
  const page = await desk('GET', 'ai-check');
  check('the page answers', page.status === 200, page);
  check('every check says the demo data is missing',
    page.out.checks.every((c) => c.missing), page.out.checks);
  check('slot A is set up and its health was read',
    page.out.slots[0].set && page.out.slots[0].workers.ready === 0 && health === 1, page.out.slots[0]);
  check('slots B and C are not set up', !page.out.slots[1].set && !page.out.slots[2].set);
}

console.log('');
console.log('every AI button works on the demo people');
await seedDemo();
const page = await desk('GET', 'ai-check');
check('every button has a demo person to run on',
  page.out.checks.length === CHECKS.length && page.out.checks.every((c) => !c.missing),
  page.out.checks.filter((c) => c.missing));
const run = new Date().toISOString();
for (const target of page.out.checks) {
  const before = submits;
  const out = await desk('POST', target.action, { ...target.body, withSummary: false });
  check(`${target.button} on ${target.on}`, out.status === 202 && submits === before + 1,
    { status: out.status, message: out.message || out.out?.error });
  await settleAll();
  const done = (await desk('GET', `draft-result&id=${out.out?.draftId}`)).out;
  check('and it reaches ready', done?.state === 'ready' && done.payload, done);
  const saved = await desk('POST', 'ai-check-save', {
    run, button: target.button, orderId: target.body.id, ok: done?.state === 'ready', seconds: 3, said: '',
  });
  check(`and its result is saved`, saved.status === 201, saved);
}

const after = await desk('GET', 'ai-check');
check('the run shows every result',
  after.out.run?.results.length === CHECKS.length && after.out.run.results.every((r) => r.ok),
  after.out.run);
check('every press is in the history, newest first, a page at a time',
  after.out.presses.length >= CHECKS.length && after.out.presses.length <= 20
    && after.out.presses.every((p) => p.button && p.reference), after.out.presses.length);

console.log('');
console.log('a failed press says why');
{
  answer = () => ({ status: 'FAILED', error: 'out of memory' });
  const target = page.out.checks[0];
  const out = await desk('POST', target.action, { ...target.body, withSummary: false });
  await settleAll();
  const done = (await desk('GET', `draft-result&id=${out.out?.draftId}`)).out;
  check('the press fails', done?.state === 'failed' && done.failure.includes('out of memory'), done);
  const listed = await desk('GET', 'ai-check');
  const top = listed.out.presses[0];
  check('it shows as failed with RunPod\'s reason', top.state === 'Failed' && top.said.includes('out of memory'), top);
}

console.log('');
console.log('what a check refuses');
{
  const real = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code, status)
    values ('h-ai', 'c-ai', 700, 'wise', 'RAICHECK01', 'confirmed') returning id`;
  const onReal = await desk('POST', 'ai-check-save', {
    run: new Date().toISOString(), button: CHECKS[0].button, orderId: Number(real[0].id), ok: true,
  });
  check('a result against a real order', onReal.status === 400, onReal);
  const odd = await desk('POST', 'ai-check-save', { run: new Date().toISOString(), button: 'Something else', ok: true });
  check('a button it does not run', odd.status === 400, odd);
}

console.log('');
console.log('deleting the demo data takes the results with it');
{
  await desk('POST', 'demo-clear', {});
  const [{ n }] = await tagged`select count(*)::int as n from ai_checks`;
  check('no results are left', n === 0, n);
}

globalThis.fetch = realFetch;
const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
