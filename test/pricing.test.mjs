import { Readable } from 'node:stream';
import { check, db, failureCount, tagged, useSlot } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.RUNPOD_API_KEY = 'invented-key';
const { signSession } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const costsApi = (await import('../api/costs.js')).default;
const drafts = await import('../lib/desk-drafts.js');
const pricing = await import('../lib/pricing.js');
const sessions = await import('../lib/sessions.js');
const { draftCost } = await import('../lib/costs.js');

await db.ensureSchema();
await useSlot('A', 'invented-a', 'Invented Luna');
await useSlot('B', 'invented-b', 'Invented Sol');

const cookie = `op_session=${signSession('admin-1')}`;
async function ask(endpoint, method, url, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  try {
    await endpoint({ method, url, headers: { cookie, 'content-type': 'application/json' },
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  } catch (error) {
    return { status: error.status || 500, out: { error: error.message } };
  }
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
}
const owner = (action, payload) => ask(desk, 'POST', `/api/desk?action=${action}`, payload);

console.log('');
console.log('a slot per button');
check('every button starts on its tier, C falling to B while C is empty',
  (await drafts.familiesNow()).every((b) => b.inUse === (b.tier === 'A' ? 'A' : 'B') && b.chosen === b.tier));
check('a button it does not know is refused', (await owner('model', { slot: 'B', for: 'invented' })).status === 400);
check('a slot that is not set up is refused', (await owner('model', { slot: 'C', for: 'roadmap' })).status === 409);
const moved = await owner('model', { slot: 'A', for: 'roadmap' });
check('the roadmap moves to slot A', moved.status === 200 && moved.out.for === 'roadmap' && moved.out.chosen === 'A', moved.out);
const now = await drafts.familiesNow();
check('and only the roadmap', now.find((b) => b.family === 'roadmap').inUse === 'A'
  && now.find((b) => b.family === 'reply').inUse === 'B', now);
check('the record picker sets the sheet alone', (await owner('model', { slot: 'A' })).out.for === 'sheet'
  && (await drafts.slotFor('sheet')) === 'A' && (await drafts.slotFor('recap')) === 'A' && (await drafts.slotFor('reply')) === 'B');
check('a kind names its family', drafts.familyOf('fields:brief') === 'fields' && drafts.familyOf(null) === 'sheet'
  && drafts.familyOf('gaps:c-1') === 'gaps');

console.log('a draft priced by its seconds');
check('a draft is priced at the per-second line', Math.abs(draftCost({ seconds: 40 }, 0.01) - 0.4) < 1e-9);
check('and with no line it is not priced', draftCost({ seconds: 40 }, null) === null);

console.log('what to charge');
const [order] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code, status, decision, approved_as_client_at)
  values ('pr-h', 'pr-c', 700, 'wise', 'PRICE00001', 'confirmed', 'go', now()) returning id`;
const id = Number(order.id);
const caseId = await db.caseForAccount('acct-price');
await tagged`update orders set client_account_id = 'acct-price', case_id = ${caseId} where id = ${id}`;
await tagged`insert into step_times (order_id, step, seconds, at) values (${id}, 'reply', 600, now() - interval '2 days'), (${id}, 'recommend', 1200, now() - interval '1 day')`;
await tagged`insert into drafts (order_id, slot, model, job_id, kind, seconds, created_at, finished_at)
             values (${id}, 'A', 'Invented Luna', 'pj-1', 'reply', 30, now() - interval '2 days', now() - interval '2 days' + interval '30 seconds')`;
await tagged`insert into step_times (order_id, step, seconds, at) values (${id}, 'reply', 180, now() - interval '2 days' + interval '4 minutes')`;
await tagged`insert into held_sessions (case_id, rate, used_at) values (${caseId}, 'standard', now() - interval '1 day')`;
const save = (payload) => ask(costsApi, 'POST', '/api/costs?action=prices', payload);
let price = await pricing.priceNow(0.02);
check('with no rate set there is no suggestion', price.rates === null && price.suggested === null, price);
check('one working client, 33 minutes, sixty cents of AI, one session used',
  price.clients === 1 && Math.abs(price.minutesAClient - 33) < 1e-9 && Math.abs(price.aiAClient - 0.6) < 1e-9
  && price.sessionsAClient === 1, price);
const reply = price.buttons.find((b) => b.family === 'reply');
check('the reply button: one press, its cost, and your three minutes after it',
  reply.presses === 1 && Math.abs(reply.cost - 0.6) < 1e-9 && reply.seconds === 30 && reply.review === 180, reply);
check('prices save from Money', (await save({ hourLow: '200', hourHigh: '100', standard: '100', access: '25', aMonth: '20' })).status === 200);
price = await pricing.priceNow(0.02);
check('a session is worth its minutes at your rate plus the AI, rounded up to five',
  price.suggested.low === 60 && price.suggested.high === 115, price.suggested);
check('the posted standard rate says what it leaves at each end',
  Math.abs(price.posted.standard.leaves.high - (100 - 0.6 - 55)) < 1e-9
  && Math.abs(price.posted.standard.leaves.low - (100 - 0.6 - 110)) < 1e-9, price.posted);
check('Money carries the suggestion and what was saved',
  (await ask(costsApi, 'GET', '/api/costs?action=now')).out.price.suggested.low === 60
  && (await ask(costsApi, 'GET', '/api/costs?action=now')).out.price.set.standard === '100');
check('emptying a field clears it', (await save({ hourLow: '', hourHigh: '200' })).status === 200
  && (await pricing.hourRates()) === null && (await sessions.ratesNow()) === null);
await save({ hourLow: '200', hourHigh: '100', standard: '100', access: '25', aMonth: '20' });
check('the rate is a pair, low then high, whichever way it was typed', JSON.stringify(await pricing.hourRates()) === JSON.stringify({ low: 100, high: 200 }));
check('a demo press is left out', price.buttons.reduce((n, b) => n + b.presses, 0) === 1);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
