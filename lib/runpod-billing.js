import { SLOTS, runpodKey, settingsFor } from './draft.js';
const BILLING = 'https://rest.runpod.io/v1/billing/endpoints';

export async function endpointIds() {
  const ids = new Set();
  for (const slot of SLOTS) {
    const { endpointId } = await settingsFor(slot);
    if (endpointId) ids.add(endpointId);
  }
  return [...ids];
}

function dayStart(at) {
  const day = new Date(at);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

export function windowFor(days, now = new Date()) {
  const end = dayStart(now);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = dayStart(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function readOne(endpointId, key, window, fetcher) {
  const address = `${BILLING}?${new URLSearchParams({
    endpointId,
    bucketSize: 'day',
    startTime: window.start,
    endTime: window.end,
  })}`;

  const answer = await fetcher(address, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  });

  if (!answer.ok) {
    const body = await answer.text().catch(() => '');
    throw new Error(
      `Runpod answered ${answer.status} for the billing of endpoint ${endpointId}. `
        + `The key is RUNPOD_API_KEY and it has to be one this account issued. ${body}`.trim(),
    );
  }

  const rows = await answer.json();
  if (!Array.isArray(rows)) {
    throw new Error('Runpod billing came back as something other than a list of records.');
  }
  return rows;
}

export async function draftingByDay({ days = 35, fetcher = fetch } = {}) {
  const key = runpodKey();
  if (!key) {
    throw new Error(
      'RUNPOD_API_KEY is not set, so the drafting bill cannot be read. It goes in One Percent\'s '
        + 'own project in the settings store, never a value copied from anywhere else.',
    );
  }

  const ids = await endpointIds();
  if (!ids.length) return { days: [], endpoints: [] };

  const window = windowFor(days);
  const perDay = new Map();
  for (const id of ids) {
    for (const row of await readOne(id, key, window, fetcher)) {
      const at = dayStart(row.time || window.start).toISOString();
      const amount = Number(row.amount);
      if (!Number.isFinite(amount)) continue;
      const keyOf = `${id}|${at}`;
      perDay.set(keyOf, { endpointId: id, at, amount: (perDay.get(keyOf)?.amount || 0) + amount });
    }
  }

  return {
    endpoints: ids,
    days: [...perDay.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.endpointId < b.endpointId ? -1 : 1)),
  };
}
