import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { check, db, failureCount, seedPrompts, tagged, useSlot } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { encrypt, decrypt, signSession } = await import('../lib/crypto.js');
const { gapNotes, readGaps, GAPS_TO_FIND } = await import('../lib/desk-gaps.js');
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();
await useSlot('A', 'a-test-endpoint', 'a-test-model');
await seedPrompts();

const cookie = `op_session=${signSession('admin-1')}`;
function res() {
  return {
    statusCode: 200, writableEnded: false, body: null, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}
async function post(action, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = { method: 'POST', url: `/api/desk?action=${action}`,
    headers: { cookie, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) };
  const out = res();
  try {
    await desk(req, out);
    return { status: out.statusCode, out: JSON.parse(out.body) };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}
async function person(id) {
  const out = res();
  await desk({ method: 'GET', url: `/api/desk?action=person&id=${id}`, headers: { cookie } }, out);
  return JSON.parse(out.body);
}

console.log('a paid button');
const ui = readFileSync(new URL('../desk-ui.js', import.meta.url), 'utf8');
check('call-gaps is in MODEL_ACTIONS', /MODEL_ACTIONS = \[[^\]]*'call-gaps'/.test(ui));

const [caseA] = await tagged`insert into cases (account_id) values ('acct-gaps-a') returning id`;
await tagged`insert into trades (id, title, sector_id, sector, sector_order, title_order)
             values ('gap-trade', 'Invented lawn care', 'gap-sector', 'Invented outdoors', 1, 1)`;
async function order(n, caseId) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, case_id, trade_id)
    values (${'gap-h-' + n}, ${'gap-c-' + n}, 700, 'wise', ${'GAP' + n}, 'confirmed', ${caseId},
            ${caseId ? 'gap-trade' : null})
    returning id`;
  return Number(row.id);
}
async function call(orderId, n, words, summary) {
  const [row] = await tagged`
    insert into calls (order_id, call_id, transcript_encrypted, summary_encrypted, fields_encrypted,
                       started_at, ended_at)
    values (${orderId}, ${'gap-call-' + n}, ${encrypt(words)},
            ${encrypt(JSON.stringify({ call_summary: summary }))},
            ${encrypt(JSON.stringify({ trade: 'Mows lawns', rate: '40 a yard', inTheWay: 'No mower', firstCustomer: 'not said' }))},
            now() - (${n} || ' minutes')::interval, now())
    returning id`;
  return Number(row.id);
}
const a = await order('A', Number(caseA.id));
const b = await order('B', null);
const a1 = await call(a, 1, 'Agent: What do you do?\nCaller: ZEBRA-WORDS mowing twice a month.', 'ZEBRA-SUMMARY');
const a2 = await call(a, 2, 'Agent: Anything else?\nCaller: OTTER-WORDS from a later call.', 'OTTER-SUMMARY');
await call(b, 3, 'Agent: What do you do?\nCaller: HERON-WORDS from somebody else.', 'HERON-SUMMARY');

const unset = await post('call-gaps', { id: a, call: a1 });
check('with no model set up it\'s refused, and nothing is saved', unset.status === 503, unset);
check('and no set exists', (await tagged`select count(*)::int as n from call_gaps`)[0].n === 0);

console.log('only this call');
const notes = (await gapNotes(a, a1)).join('\n');
check('the call\'s own transcript goes in', notes.includes('ZEBRA-WORDS'));
check('its summary, its four lines and the job title go in',
  notes.includes('ZEBRA-SUMMARY') && notes.includes('40 a yard') && notes.includes('Invented lawn care'));
check('another call of the same person\'s doesn\'t', !notes.includes('OTTER'));
check('another person\'s call doesn\'t', !notes.includes('HERON'));
check('a call on another order isn\'t read at all', (await gapNotes(b, a1)) === null);

console.log('reading the answer');
const read = readGaps('1. How big is a yard?\nWhy: They gave a price a yard and no size.\n'
  + '2) **How often do they come back?** Why: twice a month, from whom\nNot a question\n'
  + '3. One\n4. Two\n5. Three\n6. Four');
check('each question comes with its reason', read[0].question === 'How big is a yard?'
  && read[0].reason === 'They gave a price a yard and no size.', read);
check('a reason on the same line is read too', read[1].reason === 'twice a month, from whom', read);
check(`no more than ${GAPS_TO_FIND}`, read.length === GAPS_TO_FIND, read.length);

console.log('saved, sealed, newest first');
process.env.RUNPOD_API_KEY = 'a-test-key';
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (run, ms, ...rest) => realSetTimeout(run, ms === 1_500 ? 0 : ms, ...rest);
let answer = '';
let jobs = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (address, init) => {
  const url = String(address);
  if (url.endsWith('/run') && init?.method === 'POST') {
    jobs += 1;
    return { ok: true, text: async () => JSON.stringify({ id: `gap-job-${jobs}` }) };
  }
  if (url.includes('/status/')) {
    return { ok: true, text: async () => JSON.stringify({ status: 'COMPLETED', output: { content: answer } }) };
  }
  return realFetch(address, init);
};

const { settleAll } = await import('../lib/draft-jobs.js');
async function gaps(payload) {
  const pressed = await post('call-gaps', payload);
  await settleAll();
  if (pressed.status !== 202) return pressed;
  const out = res();
  await desk({ method: 'GET', url: `/api/desk?action=draft-result&id=${pressed.out.draftId}`, headers: { cookie } }, out);
  return JSON.parse(out.body);
}

answer = '1. How big is a yard?\nWhy: A price a yard, and no size.';
const first = await gaps({ id: a, call: a1 });
check('a set comes back', first.state === 'ready' && first.payload.set.questions.length === 1, first);
answer = '1. Who mowed for them before?\nWhy: No first customer named.\n2. What does a mower cost to rent?\nWhy: No mower.';
const second = await gaps({ id: a, call: a2 });
check('a second set comes back', second.state === 'ready' && second.payload.set.questions.length === 2, second);

const stored = await tagged`select content_encrypted from call_gaps order by id`;
check('both are saved', stored.length === 2);
check('sealed at rest', stored.every((r) => !r.content_encrypted.includes('yard')
  && !r.content_encrypted.includes('mower')));
check('and open to the right words', JSON.parse(decrypt(stored[0].content_encrypted))[0].question === 'How big is a yard?');

await tagged`update call_gaps set created_at = now() - interval '1 hour' where id = (select min(id) from call_gaps)`;
const listed = (await person(a)).gaps;
check('the record lists them newest first', listed.length === 2
  && listed[0].callId === a2 && listed[1].callId === a1, listed.map((g) => g.callId));
check('each with its model and seconds', listed.every((g) => g.model === 'a-test-model'));
check('the other person sees none of them', (await person(b)).gaps.length === 0);
const logged = await tagged`select count(*)::int as n from case_events where kind = 'call.gaps'`;
check('Gaps found is on the activity log', logged[0].n === 2);

answer = 'Nothing useful here.';
const empty = await gaps({ id: a, call: a1 });
check('an answer with no questions saves nothing and says so', empty.state === 'failed'
  && /without any questions/.test(empty.failure)
  && (await tagged`select count(*)::int as n from call_gaps`)[0].n === 2, empty);

globalThis.fetch = realFetch;
globalThis.setTimeout = realSetTimeout;

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
