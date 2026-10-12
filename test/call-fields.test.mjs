import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { encrypt, signSession } = await import('../lib/crypto.js');
const { parseFields } = await import('../lib/desk-callfields.js');
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();

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
async function orderWithCall(n) {
  const [order] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${'cf-h-' + n}, ${'cf-c-' + n}, 700, 'wise', ${'CF' + n}, 'confirmed') returning id`;
  const [call] = await tagged`
    insert into calls (order_id, call_id, transcript_encrypted, ended_at)
    values (${order.id}, ${'cf-call-' + n}, ${encrypt('Agent: What do you do?\nCaller: Invented.')}, now())
    returning id`;
  return { order: Number(order.id), call: Number(call.id) };
}

const a = await orderWithCall('a');
const b = await orderWithCall('b');
const fields = { trade: 'Invented trade', rate: '40 a job', inTheWay: 'No tools', firstCustomer: 'not said' };

console.log('saving');
const saved = await post('call-fields', { id: a.order, call: a.call, fields });
check('the owner saves the four lines', saved.status === 200, saved);
check('and the record shows them on that call',
  JSON.stringify((await person(a.order)).calls[0].fields) === JSON.stringify(fields));
const elsewhere = await post('call-fields', { id: b.order, call: a.call, fields });
check('a call on another order is refused', elsewhere.status === 404, elsewhere);
check('and that call is untouched', (await person(b.order)).calls[0].fields === null);
await post('call-fields', { id: a.order, call: a.call, fields: {} });
check('saving them empty clears them', (await person(a.order)).calls[0].fields === null);

console.log('the paid half');
const unset = await post('call-fields-draft', { id: a.order, call: a.call });
check('with no model set up it says so, and nothing is saved', unset.status === 503, unset);

console.log('reading the answer');
const read = parseFields('Trade: Invented trade\n**Rate:** 40 a job\nIn the way: No tools\nFirst customer: not said');
check('each labeled line lands in its own field', JSON.stringify(read) === JSON.stringify(fields), read);
check('a line the model leaves out stays empty', parseFields('Trade: Only this').rate === '');

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
