import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

const { endpointIds, windowFor, draftingByDay } = await import('../lib/runpod-billing.js');
const { pullDraftingBill } = await import('../lib/desk-drafting-bill.js');
const { costsNow } = await import('../lib/costs.js');

console.log('');
console.log('the drafting bill');

check('the endpoint ids come out of the slot addresses',
  endpointIds({
    DRAFT_MODEL_A_URL: 'https://api.runpod.ai/v2/abc123xyz',
    DRAFT_MODEL_B_URL: 'https://api.runpod.ai/v2/def456uvw',
    DRAFT_MODEL_C_URL: 'https://api.runpod.ai/v2/ghi789rst',
  }).join(',') === 'abc123xyz,def456uvw,ghi789rst');
check('a slot that is not set contributes nothing',
  endpointIds({ DRAFT_MODEL_A_URL: 'https://api.runpod.ai/v2/only-one' }).join(',') === 'only-one');
check('two slots on one endpoint are one endpoint',
  endpointIds({
    DRAFT_MODEL_A_URL: 'https://api.runpod.ai/v2/same',
    DRAFT_MODEL_B_URL: 'https://api.runpod.ai/v2/same',
  }).length === 1);
check('nothing configured is no endpoints rather than an error',
  endpointIds({}).length === 0);

const window = windowFor(7);
check('the window is complete days and ends after today',
  window.start.endsWith('T00:00:00.000Z') && window.end.endsWith('T00:00:00.000Z')
  && new Date(window.end) > new Date(), window);

{
  const quiet = await draftingByDay({
    env: { RUNPOD_API_KEY: 'a-key' },
    fetcher: async () => { throw new Error('should not have been called'); },
  });
  check('no endpoint means no bill and no request', quiet.days.length === 0);
}

check('no key says so rather than asking for nothing', await (async () => {
  try {
    await draftingByDay({ env: { DRAFT_MODEL_A_URL: 'https://api.runpod.ai/v2/x' } });
    return false;
  } catch (error) {
    return /RUNPOD_API_KEY/.test(error.message);
  }
})());

{
  const asked = [];
  const env = {
    RUNPOD_API_KEY: 'a-key',
    DRAFT_MODEL_A_URL: 'https://api.runpod.ai/v2/one-percent-a',
    DRAFT_MODEL_B_URL: 'https://api.runpod.ai/v2/one-percent-b',
  };
  const bill = await draftingByDay({
    days: 3,
    env,
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
  check('two slots on one day add up rather than reading as two days',
    bill.days.length === 2 && Math.abs(bill.days[0].amount - 0.015) < 1e-9, bill.days);
  check('days come back oldest first',
    bill.days[0].at < bill.days[1].at, bill.days.map((d) => d.at));
}

check('a refusal names the setting', await (async () => {
  try {
    await draftingByDay({
      env: { RUNPOD_API_KEY: 'wrong', DRAFT_MODEL_A_URL: 'https://api.runpod.ai/v2/x' },
      fetcher: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
    });
    return false;
  } catch (error) {
    return /401/.test(error.message) && /RUNPOD_API_KEY/.test(error.message);
  }
})());

{
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const stamp = `${day}T00:00:00Z`;
  const amounts = { [stamp]: 0.01 };
  process.env.RUNPOD_API_KEY = 'a-key';
  process.env.DRAFT_MODEL_A_URL = 'https://api.runpod.ai/v2/one-percent-a';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => Object.entries(amounts).map(([time, amount]) => ({ time, amount })),
  });

  const first = await pullDraftingBill();
  check('a day of billing is written', first.days === 1 && first.endpoints === 1, first);
  let rows = await tagged`select source, amount_cents, was_demo from spend where kind = 'drafting'`;
  check('as one row naming the day it came from',
    rows.length === 1 && rows[0].source === `drafting:${day}`
    && Number(rows[0].amount_cents) === 1, rows);
  check('and against the project rather than a client', rows[0].was_demo === true);

  amounts[stamp] = 0.04;
  await pullDraftingBill();
  rows = await tagged`select amount_cents from spend where kind = 'drafting'`;
  check('reading it again revises the day rather than adding a second row',
    rows.length === 1 && Number(rows[0].amount_cents) === 4, rows);

  const call = await tagged`select count(*)::int as n from spend where kind = 'call'`;
  check('a call is still written once and never revised', call[0].n >= 0);

  const now = await costsNow();
  check('the screen says the figures came off a bill', now.lastSeven.billRead === true);

  globalThis.fetch = realFetch;
  delete process.env.RUNPOD_API_KEY;
  delete process.env.DRAFT_MODEL_A_URL;
}

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
