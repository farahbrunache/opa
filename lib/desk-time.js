import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { send } from './http.js';

const IDLE_MINUTES = 30;
const REPORT_DAYS = 30;

export const STEPS = {
  'call-fields': 'Reading the call',
  decide: 'Go or no-go',
  recommend: 'Writing the next steps',
  reply: 'Replying',
  introduce: 'An introduction',
  trade: 'Job title',
  skills: 'Job title',
  'own-profile': 'Job title',
  plan: 'The roadmap', 'activity-add': 'The roadmap', 'activity-done': 'The roadmap',
  'activity-drop': 'The roadmap', 'activity-move': 'The roadmap',
  'activity-push': 'Following up', 'activity-cadence': 'Following up',
  'session-use': 'Sessions',
  'contact-add': 'People to approach', 'contact-reach': 'People to approach',
  'contact-move': 'People to approach',
  'work-take': 'Work you owe', 'work-move': 'Work you owe',
  note: 'A note',
};

function asOrder(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function startClock(value) {
  const id = asOrder(value);
  if (!id) return;
  await sql()`
    insert into desk_clock (order_id, at) values (${id}, now())
    on conflict (order_id) do update set at = now()
     where desk_clock.at < now() - (${IDLE_MINUTES} || ' minutes')::interval
  `;
}

export async function timeStep(value, action) {
  const id = asOrder(value);
  if (!id || !STEPS[action]) return;
  await sql()`
    insert into step_times (order_id, step, seconds)
    select ${id}, ${action}, greatest(1, extract(epoch from now() - at))::int
      from desk_clock
     where order_id = ${id} and at > now() - (${IDLE_MINUTES} || ' minutes')::interval
  `;
  await sql()`
    insert into desk_clock (order_id, at) values (${id}, now())
    on conflict (order_id) do update set at = now()
  `;
}

export async function timeReport(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const rows = await sql()`
    select t.step, count(*)::int as times,
           percentile_cont(0.5) within group (order by t.seconds) as typical,
           sum(t.seconds)::int as total,
           bool_or(o.is_demo) as demo
      from step_times t join orders o on o.id = t.order_id
     where t.at > now() - (${REPORT_DAYS} || ' days')::interval
     group by t.step
  `;
  const people = await sql()`
    select count(distinct order_id)::int as people, coalesce(sum(seconds), 0)::int as total
      from step_times where at > now() - (${REPORT_DAYS} || ' days')::interval
  `;
  const byLabel = new Map();
  for (const row of rows) {
    const label = STEPS[row.step] || row.step;
    const was = byLabel.get(label) || { label, times: 0, total: 0, typical: 0, demo: false };
    was.times += row.times;
    was.total += row.total;
    was.typical = Math.max(was.typical, Math.round(Number(row.typical)));
    was.demo ||= row.demo;
    byLabel.set(label, was);
  }
  const order = [...new Set(Object.values(STEPS))];
  send(res, 200, {
    days: REPORT_DAYS,
    people: people[0].people,
    total: people[0].total,
    steps: [...byLabel.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)),
  });
}
