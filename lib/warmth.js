import { sql } from './db.js';

export const WARMTH_DAYS = 30;
export const IDLE_NOW = 5;
export const COLD_SECONDS = 10;
export const IDLE_CHOICES = [60, 300, 900];
const FEWEST = 5;

function money(value) {
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

function span(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function warmthOf(presses, perSecond, { days = WARMTH_DAYS } = {}) {
  const timed = presses
    .filter((p) => p.waitMs !== null && p.runMs !== null)
    .map((p) => ({ at: new Date(p.at).getTime() / 1000, wait: p.waitMs / 1000, run: p.runMs / 1000 }))
    .sort((a, b) => a.at - b.at);

  const cold = timed.filter((p) => p.wait >= COLD_SECONDS);
  const waitSeconds = cold.reduce((sum, p) => sum + p.wait, 0);
  const billedSeconds = timed.reduce((sum, p) => sum + p.wait + p.run + IDLE_NOW, 0);
  const out = {
    days,
    timed: timed.length,
    wakeups: cold.length,
    averageWait: cold.length ? waitSeconds / cold.length : null,
    wakeShare: billedSeconds ? waitSeconds / billedSeconds : null,
    wakePerDay: perSecond === null ? null : (waitSeconds * perSecond) / days,
    coldPerDay: perSecond === null ? null : (billedSeconds * perSecond) / days,
    warmPerDay: perSecond === null ? null : perSecond * 86_400,
    idle: null,
  };

  let best = null;
  for (const window of IDLE_CHOICES) {
    let saved = 0;
    let extra = 0;
    let caught = 0;
    for (let i = 0; i < timed.length; i += 1) {
      const next = timed[i + 1];
      const gap = next ? next.at - (timed[i].at + timed[i].wait + timed[i].run) : Infinity;
      if (next && gap <= window) {
        extra += Math.max(0, gap - IDLE_NOW);
        if (next.wait >= COLD_SECONDS) {
          saved += next.wait;
          caught += 1;
        }
      } else {
        extra += window - IDLE_NOW;
      }
    }
    const net = saved - extra;
    if (net > 0 && (!best || net > best.net)) best = { window, net, caught };
  }
  if (best) {
    out.idle = {
      seconds: best.window,
      caught: best.caught,
      perMonth: perSecond === null ? null : (best.net * perSecond * 30) / days,
    };
  }

  out.verdict = verdictOf(out);
  return out;
}

function verdictOf(w) {
  if (w.timed < FEWEST) {
    return { tone: 'quiet', text: `${w.timed} timed ${w.timed === 1 ? 'press' : 'presses'} in ${w.days} days. Too few to judge. Stay cold.` };
  }
  const share = w.wakeShare === null ? '' : `${Math.round(w.wakeShare * 100)}% of the time this slot ran was waking up`;
  const wait = w.averageWait === null ? 'No press waited for a wake-up' : `${w.wakeups} wake-ups, ${span(w.averageWait)} each on average`;
  const facts = [wait, share].filter(Boolean).join(', ');
  if (w.wakePerDay === null) {
    return { tone: 'quiet', text: `${facts}. Read the bill to put a price on it.` };
  }
  if (w.coldPerDay >= w.warmPerDay) {
    return {
      tone: 'go',
      text: `${facts}. Keep one worker warm: this slot costs ${money(w.coldPerDay)} a day as it is, one worker kept up costs about ${money(w.warmPerDay)} a day.`,
    };
  }
  if (w.idle) {
    const saves = w.idle.perMonth === null ? '' : `, about ${money(w.idle.perMonth)} a month less`;
    return {
      tone: 'go',
      text: `${facts}. Stay cold, but set the idle timeout to ${span(w.idle.seconds)}: ${w.idle.caught} wake-ups came that soon after the last press${saves}.`,
    };
  }
  return {
    tone: 'quiet',
    text: `${facts}. Stay cold. Wake-ups cost ${money(w.wakePerDay)} a day of the ${money(w.coldPerDay)} this slot costs; one worker kept up costs about ${money(w.warmPerDay)} a day.`,
  };
}

export async function gpuRates(days = WARMTH_DAYS) {
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const rows = await sql()`
    select endpoint_id, sum(amount_cents)::bigint as cents, sum(seconds)::bigint as seconds from spend
     where kind = 'drafting' and endpoint_id is not null and seconds > 0 and at >= ${since}
     group by endpoint_id
  `;
  return new Map(rows.filter((r) => Number(r.seconds) > 0)
    .map((r) => [r.endpoint_id, Number(r.cents) / 100 / Number(r.seconds)]));
}

export async function warmthFor(endpointId, perSecond, days = WARMTH_DAYS) {
  if (!endpointId) return null;
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const rows = await sql()`
    select created_at, wait_ms, run_ms from drafts
     where endpoint_id = ${endpointId} and finished_at is not null and created_at >= ${since}
  `;
  return warmthOf(rows.map((r) => ({
    at: r.created_at,
    waitMs: r.wait_ms === null ? null : Number(r.wait_ms),
    runMs: r.run_ms === null ? null : Number(r.run_ms),
  })), perSecond, { days });
}
