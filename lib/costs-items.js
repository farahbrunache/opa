import { sql } from './db.js';
import { DAYS_IN_A_MONTH } from './costs.js';

export async function chargesOf(days, lines, perSecond) {
  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const rows = await sql()`
    select s.at, s.kind, s.was_demo, s.amount_cents, s.seconds, o.reference_code
      from spend s left join orders o on o.id = s.order_id
     where s.at >= ${since}
     order by s.at desc
  `;
  const billRead = rows.some((r) => r.kind === 'drafting');

  const items = rows.map((r) => {
    const item = {
      at: r.at,
      reference: r.reference_code || null,
      project: Boolean(r.was_demo),
      kind: r.kind === 'call' ? 'call' : 'drafting',
    };
    if (r.kind === 'call') {
      return { ...item, what: 'Call', amount: Number(r.amount_cents || 0) / 100,
        how: "The voice service's charge, from its record of the call." };
    }
    if (r.kind === 'drafting') {
      return { ...item, what: 'Drafting, one day', amount: Number(r.amount_cents || 0) / 100,
        how: 'Read off the Runpod bill.' };
    }
    const seconds = Number(r.seconds || 0);
    if (billRead) {
      return { ...item, what: 'Drafting', amount: 0, seconds,
        how: `${seconds} seconds, already inside the day's Runpod bill.` };
    }
    if (perSecond === null) {
      return { ...item, what: 'Drafting', amount: null, seconds,
        how: `${seconds} seconds. No line says what a second costs, so it's not counted.` };
    }
    return { ...item, what: 'Drafting', amount: seconds * perSecond, seconds,
      how: `${seconds} seconds at $${perSecond} a second.` };
  });

  for (const line of lines.filter((l) => l.every === 'month')) {
    const share = line.sharePercent === 100 ? '' : `, ${line.sharePercent}% of it yours`;
    items.push({
      at: null,
      reference: line.forReference,
      project: !line.forReference,
      kind: 'month',
      what: line.name,
      amount: (line.costs * days) / DAYS_IN_A_MONTH,
      how: `$${line.amount} a month${share}, for ${days} of ${DAYS_IN_A_MONTH} days.`,
    });
  }

  const total = items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  return { days, items, total };
}
