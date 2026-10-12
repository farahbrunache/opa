import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

const { warmthOf, warmthFor, gpuRates } = await import('../lib/warmth.js');

const at = (minutes) => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString();
const press = (minutes, waitS, runS = 30) => ({ at: at(minutes), waitMs: waitS * 1000, runMs: runS * 1000 });

console.log('');
console.log('warm or cold');

let w = warmthOf([press(0, 120), press(60, 120)], 0.001);
check('too few presses says stay cold', w.verdict.tone === 'quiet' && w.verdict.text.includes('Too few'), w.verdict);

const spread = [0, 200, 400, 600, 800, 1000].map((m) => press(m, 120));
w = warmthOf(spread, 0.0005);
check('spread-out presses stay cold', w.verdict.text.includes('Stay cold.') && !w.idle, w);
check('wake-up share counts only waits', w.wakeups === 6 && w.wakeShare > 0.7 && w.wakeShare < 0.8, w.wakeShare);
check('warm costs a day of the rate', Math.abs(w.warmPerDay - 43.2) < 1e-9, w.warmPerDay);

const runs = [0, 6, 12, 400, 406, 412].map((m) => press(m, 300));
w = warmthOf(runs, 0.0005);
check('presses in runs suggest a longer idle timeout', w.idle && w.idle.seconds === 60 && w.idle.caught === 4, w.idle);
check('the idle suggestion is the verdict', w.verdict.text.includes('idle timeout to 1 minute:'), w.verdict.text);

const busy = Array.from({ length: 60 }, (_, i) => press(i * 24, 900, 400));
w = warmthOf(busy, 0.0005, { days: 0.5 });
check('wake-ups past a day of warm say keep one warm', w.verdict.text.includes('Keep one worker warm'), w.verdict.text);

w = warmthOf(spread, null);
check('no rate asks for the bill', w.verdict.text.includes('Read the bill'), w.verdict.text);

w = warmthOf([...spread, { at: at(5), waitMs: null, runMs: null }], 0.0005);
check('untimed presses are left out', w.timed === 6, w.timed);

const [order] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code, status)
  values ('wm-h', 'wm-c', 700, 'wise', 'WARMTH0001', 'confirmed') returning id`;
for (const m of [0, 200, 400, 600, 800]) {
  await tagged`insert into drafts (order_id, slot, model, endpoint_id, created_at, finished_at, wait_ms, run_ms)
    values (${order.id}, 'C', 'qwen2.5:32b', 'ep-warm', now() - (${1000 - m} || ' minutes')::interval, now(), 90000, 20000)`;
}
await tagged`insert into spend (kind, source, amount_cents, was_demo, at, endpoint_id, seconds)
  values ('drafting', 'drafting:ep-warm:test', 50, true, now(), 'ep-warm', 1000)`;
const rates = await gpuRates();
check('the GPU rate is the bill over billed seconds', Math.abs(rates.get('ep-warm') - 0.0005) < 1e-12, rates.get('ep-warm'));
w = await warmthFor('ep-warm', rates.get('ep-warm'));
check('stored waits reach the verdict', w.timed === 5 && w.wakeups === 5, w);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
