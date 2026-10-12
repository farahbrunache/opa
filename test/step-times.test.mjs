import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();

const cookie = `op_session=${signSession('admin-1')}`;
function res() {
  return { statusCode: 200, writableEnded: false, body: null, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
}
async function get(url) {
  const out = res();
  await desk({ method: 'GET', url, headers: { cookie } }, out);
  return JSON.parse(out.body);
}
async function post(action, payload, on) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const out = res();
  await desk({ method: 'POST', url: `/api/desk?action=${action}${on ? `&on=${on}` : ''}`,
    headers: { cookie, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  return out.statusCode;
}

const [order] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                      reference_code, status)
  values ('st-h', 'st-c', 700, 'wise', 'STEPTIME01', 'confirmed') returning id`;
const id = Number(order.id);

console.log('timing a step');
await get(`/api/desk?action=person&id=${id}`);
await tagged`update desk_clock set at = now() - interval '4 minutes' where order_id = ${id}`;
check('a note writes', (await post('note', { id, note: 'Invented note.' }, id)) === 201);
const [first] = await tagged`select step, seconds from step_times where order_id = ${id}`;
check('and is timed from when the record was opened',
  first && first.step === 'note' && first.seconds >= 239 && first.seconds <= 260, first);

await tagged`update desk_clock set at = now() - interval '45 minutes' where order_id = ${id}`;
await post('note', { id, note: 'After lunch.' }, id);
const count = (await tagged`select count(*)::int as n from step_times where order_id = ${id}`)[0].n;
check('a gap over thirty minutes is not counted', count === 1, count);

await post('note', { id, note: 'Straight after.' }, id);
const after = (await tagged`select count(*)::int as n from step_times where order_id = ${id}`)[0].n;
check('but the clock starts again, so the next step is', after === 2, after);

await post('note', { id, note: 'Not from a record.' });
const unnamed = (await tagged`select count(*)::int as n from step_times where order_id = ${id}`)[0].n;
check('a write that names no record is not timed', unnamed === 2, unnamed);

console.log('the report');
const report = await get('/api/desk?action=time');
const notes = report.steps.find((s) => s.label === 'A note');
check('it groups by step', notes && notes.times === 2, report.steps);
check('and counts the person once', report.people === 1, report);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
