import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { encrypt, signSession } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();

const calls = 57;
for (let i = 0; i < calls; i += 1) {
  const [order] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status)
    values (${'tt-h-' + i}, ${'tt-c-' + i}, 700, 'wise', ${'TT' + String(i).padStart(8, '0')}, 'confirmed')
    returning id`;
  await tagged`insert into calls (order_id, call_id, transcript_encrypted, ended_at)
               values (${order.id}, ${'tt-call-' + i}, ${encrypt('Agent: Hello.')}, now())`;
}

let said = null;
const res = {
  statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
  end(text) { this.writableEnded = true; said = text; },
};
await desk({ method: 'GET', url: '/api/desk?action=today',
  headers: { cookie: `op_session=${signSession('admin-1')}` } }, res);
const today = JSON.parse(said);

console.log('the real total');
check('the list sends its oldest 50', today.calls.length === 50, today.calls.length);
check('and says how many there are in all', today.totals.calls === calls, today.totals);
check('a list that fits says its own length', today.totals.unread === today.unread.length, today.totals);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
