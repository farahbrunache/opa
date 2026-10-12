import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const speed = await import('../lib/confirm-speed.js');
const payments = (await import('../api/payments.js')).default;
await db.ensureSchema();

const H = 3_600_000;
const now = Date.parse('2026-10-07T12:00:00Z');
const at = (hoursAgo) => new Date(now - hoursAgo * H).toISOString();
const row = (paidHoursAgo, tookHours, extra = {}) => ({
  reference: 'X', createdAt: at(paidHoursAgo), decidedAt: at(paidHoursAgo - tookHours), ...extra,
});

console.log('');
console.log('the tiles');
const odd = speed.speedFigures([row(30, 2), row(40, 14), row(50, 5)], 12);
check('median of an odd count is the middle one', odd.median === 5 * 3600, odd);
check('within counts the ones at or under the target', odd.within === 2 && odd.decided === 3, odd);
check('slowest is the longest', odd.slowest === 14 * 3600, odd);
const even = speed.speedFigures([row(30, 2), row(40, 4), row(50, 12), row(60, 20)], 12);
check('median of an even count is halfway between the middle two', even.median === 8 * 3600, even);
check('exactly the target is within it', even.within === 3, even);
const mixed = speed.speedFigures([
  row(30, 1), row(40, 30, { isDemo: true }), row(50, 25, { isMine: true }),
  { reference: 'W', createdAt: at(3), decidedAt: null },
], 12);
check('demo, yours and waiting are left out', mixed.decided === 1 && mixed.slowest === 3600, mixed);
const empty = speed.speedFigures([], 12);
check('nothing decided gives nothing, not zero', empty.median === null && empty.slowest === null && empty.decided === 0);

console.log('the weeks');
const weeks = speed.speedWeeks([
  row(3, 2), row(30, 14), row(26, 6),
  row(24 * 8 + 10, 1), row(24 * 9, 13),
  row(24 * 70, 1),
  row(5, 20, { isDemo: true }), row(5, 20, { isMine: true }),
], 12, now);
check('only weeks with something decided', weeks.length === 2, weeks);
check('this week counts three', weeks[0].ago === 0 && weeks[0].decided === 3, weeks[0]);
check('with its median and how many went past', weeks[0].median === 6 * 3600 && weeks[0].past === 1, weeks[0]);
check('a week back is its own row', weeks[1].ago === 1 && weeks[1].decided === 2 && weeks[1].past === 1, weeks[1]);
check('past the last week is dropped', weeks.every((w) => w.ago < speed.SPEED_WEEKS));

console.log('a waiting row');
const waiting = speed.speedRow({ reference: 'W', createdAt: at(14), decidedAt: null, status: 'pending' }, now);
check('a waiting row carries how long so far', waiting.waiting && waiting.seconds === 14 * 3600, waiting);

async function order(ref, { method = 'wise', status = 'pending', paid = 3, took = null, demo = false, mine = false } = {}) {
  await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, is_demo, is_mine, created_at, decided_at)
    values (${'sp-h-' + ref}, ${'sp-c-' + ref}, 700, ${method}, ${ref}, ${status}, ${demo}, ${mine},
            now() - make_interval(secs => ${paid * 3600}),
            ${took === null ? null : new Date(Date.now() - (paid - took) * H).toISOString()})`;
}

async function list() {
  let body = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; body = text; },
  };
  await payments({ method: 'GET', url: '/api/payments?action=list',
    headers: { cookie: `op_session=${signSession('admin-1')}` } }, res);
  return JSON.parse(body);
}

console.log('only demo data');
await order('DEMOA-AAAAA', { status: 'confirmed', paid: 40, took: 19, demo: true });
await order('DEMOB-BBBBB', { method: 'amazon', paid: 14, demo: true });
let money = await list();
check('the tiles stay empty', money.speed.decided === 0 && money.speed.median === null, money.speed);
check('and the table too', money.speed.weeks.length === 0);
check('the bars show the demo rows instead, marked', money.speed.rows.length === 2
  && money.speed.rows.every((r) => r.isDemo), money.speed.rows);
check('the list no longer carries the waiting payments', !('pending' in money));
check('the counts still come with it', money.counts.pending === 1 && money.counts.confirmed === 1, money.counts);
check('the target defaults to 12', money.speed.targetHours === 12);

console.log('real payments beside them');
await order('RSPD0-00001', { status: 'confirmed', paid: 30, took: 2 });
await order('RSPD0-00002', { status: 'rejected', paid: 40, took: 14 });
await order('RSPD0-00003', { status: 'confirmed', paid: 50, took: 5, mine: true });
await order('RSPD0-00004', { method: 'amazon', paid: 13 });
process.env.CONFIRM_TARGET_HOURS = '10';
money = await list();
check('the setting moves the target', money.speed.targetHours === 10);
check('only real decisions count, yours left out', money.speed.decided === 2 && money.speed.within === 1, money.speed);
check('the slowest is the 14-hour reject', money.speed.slowest === 14 * 3600, money.speed);
check('this week has both', money.speed.weeks.length === 1 && money.speed.weeks[0].past === 1, money.speed.weeks);
check('the bars drop the demo rows once there are real ones', money.speed.rows.every((r) => !r.isDemo)
  && money.speed.rows.length === 3, money.speed.rows);
check('newest first, the waiting one on top', money.speed.rows[0].reference === 'RSPD0-00004'
  && money.speed.rows[0].waiting, money.speed.rows[0]);
delete process.env.CONFIRM_TARGET_HOURS;

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
