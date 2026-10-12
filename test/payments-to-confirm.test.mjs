import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { encrypt, signSession } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const speed = await import('../lib/confirm-speed.js');
const payments = (await import('../api/payments.js')).default;
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();

const H = 3_600_000;

console.log('');
console.log('the target');
const { writeChoice } = await import('../lib/settings.js');
const target = async (value) => { await writeChoice('confirm:target-hours', value); return speed.confirmTargetHours(); };
check('empty reads as 12', (await target('')) === 12);
check('a number moves it', (await target('8')) === 8);
check('a fraction is allowed', (await target(' 6.5 ')) === 6.5);
check('zero is not a target', (await target('0')) === 12);
check('words are not a target', (await target('twelve')) === 12);
await writeChoice('confirm:target-hours', '');

async function order(ref, { method = 'wise', status = 'pending', paid = 3, took = null, demo = false, mine = false, code = null } = {}) {
  const [made] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_code_encrypted, card_amount_cents,
                        payment_method, reference_code, status, is_demo, is_mine, created_at, decided_at)
    values (${'cs-h-' + ref}, ${'cs-c-' + ref}, ${code ? encrypt(code) : null}, 700, ${method}, ${ref},
            ${status}, ${demo}, ${mine}, now() - make_interval(secs => ${paid * 3600}),
            ${took === null ? null : new Date(Date.now() - (paid - took) * H).toISOString()})
    returning id`;
  return Number(made.id);
}

const cookie = `op_session=${signSession('admin-1')}`;
function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}
async function get(handler, url) {
  const res = fakeRes();
  await handler({ method: 'GET', url, headers: { cookie } }, res);
  return JSON.parse(res.body);
}
async function post(url, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = { method: 'POST', url, headers: { cookie, 'content-type': 'application/json' } };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = fakeRes();
  try {
    await payments(req, res);
    return { status: res.statusCode, out: JSON.parse(res.body) };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

console.log('waiting and decided');
await order('DEMOB-BBBBB', { method: 'amazon', paid: 14, demo: true, code: 'DEMO-GIFTCD-0000' });
await order('RCSP0-00001', { status: 'confirmed', paid: 30, took: 2 });
const card = await order('RCSP0-00004', { method: 'amazon', paid: 13, code: 'TEST-CODE00-ABCD' });

console.log('on Today');
const today = await get(desk, '/api/desk?action=today');
check('every waiting payment, demo included, oldest first',
  today.toConfirm.map((o) => o.reference).join() === 'DEMOB-BBBBB,RCSP0-00004', today.toConfirm);
check('counted in the totals', today.totals.toConfirm === 2, today.totals);
check('the gift card code is there for the owner', today.toConfirm[1].code === 'TEST-CODE00-ABCD');
check('with the target', today.confirmTargetHours === 12);
check('and how long each has waited', Math.round(today.toConfirm[0].hoursWaiting) === 14, today.toConfirm[0]);
await writeChoice('confirm:target-hours', '8');
check('the setting moves the target on Today', (await get(desk, '/api/desk?action=today')).confirmTargetHours === 8);
await writeChoice('confirm:target-hours', '');

console.log('a reject from Today');
const wrong = await post('/api/payments?action=decide', { id: card, decision: 'reject', reason: 'not-a-reason' });
check('a reason the server does not take is refused', wrong.status === 400, wrong);
const rejected = await post('/api/payments?action=decide', { id: card, decision: 'reject', reason: 'used' });
check('goes through the same decide', rejected.status === 200 && rejected.out.status === 'rejected', rejected);
check('and says when it was paid and decided', rejected.out.paidAt && rejected.out.decidedAt, rejected.out);
const tookHours = (Date.parse(rejected.out.decidedAt) - Date.parse(rejected.out.paidAt)) / H;
check('which is how long it waited', Math.abs(tookHours - 13) < 0.01, tookHours);
const [after] = await tagged`select card_code_encrypted, reject_reason, decided_at from orders where id = ${card}`;
check('the card code is destroyed', after.card_code_encrypted === null, after);
check('the reason and the time are saved', after.reject_reason === 'used' && after.decided_at !== null, after);
check('a second press is refused', (await post('/api/payments?action=decide', { id: card, decision: 'confirm' })).status === 409);
const again = await get(desk, '/api/desk?action=today');
check('and it leaves Today', again.toConfirm.length === 1 && again.totals.toConfirm === 1, again.totals);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
