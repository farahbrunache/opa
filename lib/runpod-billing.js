const BILLING = 'https://rest.runpod.io/v1/billing/endpoints';

export function endpointIds(env = process.env) {
  const ids = new Set();
  for (const name of ['DRAFT_MODEL_A_URL', 'DRAFT_MODEL_B_URL', 'DRAFT_MODEL_C_URL']) {
    const url = (env[name] || '').trim();
    if (!url) continue;
    const match = /\/v2\/([A-Za-z0-9_-]+)/.exec(url);
    if (match) ids.add(match[1]);
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

export async function draftingByDay({ days = 35, env = process.env, fetcher = fetch } = {}) {
  const key = (env === process.env ? process.env.RUNPOD_API_KEY || '' : env.RUNPOD_API_KEY || '').trim();
  if (!key) {
    throw new Error(
      'RUNPOD_API_KEY is not set, so the drafting bill cannot be read. It goes in One Percent\'s '
        + 'own project in the settings store, never a value copied from anywhere else.',
    );
  }

  const ids = endpointIds(env);
  if (!ids.length) return { days: [], endpoints: [] };

  const window = windowFor(days);
  const perDay = new Map();
  for (const id of ids) {
    for (const row of await readOne(id, key, window, fetcher)) {
      const at = dayStart(row.time || window.start).toISOString();
      const amount = Number(row.amount);
      if (!Number.isFinite(amount)) continue;
      perDay.set(at, (perDay.get(at) || 0) + amount);
    }
  }

  return {
    endpoints: ids,
    days: [...perDay.entries()]
      .map(([at, amount]) => ({ at, amount }))
      .sort((a, b) => (a.at < b.at ? -1 : 1)),
  };
}
