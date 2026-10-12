import { check, db, failureCount, tagged, useSlot } from './harness.mjs';

await db.ensureSchema();

const { endpointIds, windowFor, draftingByDay } = await import('../lib/runpod-billing.js');
const { pullDraftingBill } = await import('../lib/desk-drafting-bill.js');
const { costsNow, endpointRates, draftCost } = await import('../lib/costs.js');

async function slots(a, b, c) {
  await useSlot('A', a, a ? 'small' : '');
  await useSlot('B', b, b ? 'mid' : '');
  await useSlot('C', c, c ? 'large' : '');
}

console.log('');
console.log('the drafting bill');

await slots('abc123xyz', 'def456uvw', 'ghi789rst');
check('the endpoint ids are the slots\' endpoints', (await endpointIds()).join(',') === 'abc123xyz,def456uvw,ghi789rst');
await slots('only-one', '', '');
check('a slot that is not set contributes nothing', (await endpointIds()).join(',') === 'only-one');
await slots('same', 'same', '');
check('two slots on one endpoint are one endpoint', (await endpointIds()).length === 1);
await slots('', '', '');
check('nothing set is no endpoints rather than an error', (await endpointIds()).length === 0);

const window = windowFor(7);
check('the window is complete days and ends after today',
  window.start.endsWith('T00:00:00.000Z') && window.end.endsWith('T00:00:00.000Z')
  && new Date(window.end) > new Date(), window);

process.env.RUNPOD_API_KEY = 'a-key';
{
  const quiet = await draftingByDay({ fetcher: async () => { throw new Error('should not have been called'); } });
  check('no endpoint means no bill and no request', quiet.days.length === 0);
}

delete process.env.RUNPOD_API_KEY;
await slots('x', '', '');
check('no key says so rather than asking for nothing', await (async () => {
  try {
    await draftingByDay();
    return false;
  } catch (error) {
    return /RUNPOD_API_KEY/.test(error.message);
  }
})());

process.env.RUNPOD_API_KEY = 'a-key';
{
  const asked = [];
  await slots('one-percent-a', 'one-percent-b', '');
  const bill = await draftingByDay({
    days: 3,
    fetcher: async (address) => {
      asked.push(address);
      const which = new URL(address).searchParams.get('endpointId');
      return {
        ok: true,
        json: async () => [
          { time: '2026-09-29T00:00:00Z', amount: which === 'one-percent-a' ? 0.01 : 0.005 },
          { time: '2026-09-30T00:00:00Z', amount: 0.002 },
        ],
      };
    },
  });

  check('every request names an endpoint of this product', asked.length === 2
    && asked.every((a) => /endpointId=one-percent-[ab]/.test(a)), asked);
  check('and none of them asks for the account',
    asked.every((a) => a.startsWith('https://rest.runpod.io/v1/billing/endpoints?')), asked);
  check('each endpoint keeps its own day', bill.days.length === 4
    && bill.days.filter((d) => d.endpointId === 'one-percent-a').length === 2, bill.days);
  check('days come back oldest first', bill.days[0].at <= bill.days.at(-1).at, bill.days.map((d) => d.at));
}

check('a refusal names the setting', await (async () => {
  try {
    await draftingByDay({ fetcher: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) });
    return false;
  } catch (error) {
    return /401/.test(error.message) && /RUNPOD_API_KEY/.test(error.message);
  }
})());

{
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const stamp = `${day}T00:00:00Z`;
  const amounts = { [stamp]: 0.01 };
  await slots('one-percent-a', '', '');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => Object.entries(amounts).map(([time, amount]) => ({ time, amount })),
  });

  const first = await pullDraftingBill();
  check('a day of billing is written', first.days === 1 && first.endpoints === 1, first);
  let rows = await tagged`select source, amount_cents, was_demo, endpoint_id from spend where kind = 'drafting'`;
  check('as one row naming the endpoint and the day',
    rows.length === 1 && rows[0].source === `drafting:one-percent-a:${day}` && rows[0].endpoint_id === 'one-percent-a'
    && Number(rows[0].amount_cents) === 1, rows);
  check('and against the project rather than a client', rows[0].was_demo === true);

  amounts[stamp] = 0.04;
  await pullDraftingBill();
  rows = await tagged`select amount_cents from spend where kind = 'drafting'`;
  check('reading it again revises the day rather than adding a second row',
    rows.length === 1 && Number(rows[0].amount_cents) === 4, rows);

  const now = await costsNow();
  check('the screen says the figures came off a bill', now.lastSeven.billRead === true);

  const [order] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code, status)
    values ('db-h', 'db-c', 700, 'wise', 'BILLRATE01', 'confirmed') returning id`;
  await tagged`insert into drafts (order_id, slot, model, job_id, seconds, endpoint_id, created_at)
               values (${order.id}, 'A', 'small', 'r-1', 80, 'one-percent-a', now() - interval '1 day')`;
  const rates = await endpointRates();
  check('an endpoint\'s rate is what it billed over the seconds drafted on it',
    Math.abs(rates.get('one-percent-a') - 0.04 / 80) < 1e-12, [...rates]);
  check('a press on it is priced at that rate, not the typed line',
    Math.abs(draftCost({ seconds: 20, endpoint_id: 'one-percent-a' }, 1, rates) - 0.01) < 1e-12);
  check('a press with no endpoint falls back to the typed line',
    Math.abs(draftCost({ seconds: 20 }, 0.002, rates) - 0.04) < 1e-12);

  globalThis.fetch = realFetch;
  delete process.env.RUNPOD_API_KEY;
}

console.log('an old day row from before the bill was split');
{
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const old = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  await tagged`insert into spend (kind, source, amount_cents, was_demo, at)
               values ('drafting', ${`drafting:${day}`}, 9, true, ${`${day}T00:00:00Z`}),
                      ('drafting', ${`drafting:${old}`}, 7, true, ${`${old}T00:00:00Z`})`;
  db.useDatabase(tagged);
  await db.ensureSchema();
  const left = (await tagged`select source from spend where kind = 'drafting' and endpoint_id is null`).map((r) => r.source);
  check('one the reader rereads is cleared, so it is not counted twice', !left.includes(`drafting:${day}`), left);
  check('one older than that is kept', left.includes(`drafting:${old}`), left);
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
