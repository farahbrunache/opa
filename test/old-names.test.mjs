import { check, db, failureCount, tagged } from './harness.mjs';

const { encrypt, decrypt } = await import('../lib/crypto.js');
await db.ensureSchema();

const [order] = await tagged`
  insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method, reference_code, status)
  values ('on-h', 'on-c', 700, 'wise', 'OLDNAMES01', 'confirmed') returning id`;
const caseId = await db.caseForAccount('acct-old-names');
await tagged`update orders set case_id = ${caseId} where id = ${order.id}`;

console.log('');
console.log('a database still carrying the old names');
await tagged`alter table work rename column done_at to delivered_at`;
await tagged`alter table plans rename column goal to path`;
await tagged`alter table work rename to projects`;
await tagged`alter index work_case_idx rename to projects_case_idx`;
await tagged`insert into projects (case_id, title_encrypted, state, delivered_at) values (${caseId}, ${encrypt('Invented work')}, 'done', now())`;
await tagged`insert into case_events (order_id, case_id, kind, detail_encrypted)
             values (${order.id}, ${caseId}, 'milestone.recorded', ${encrypt('Invented.')}),
                    (${order.id}, ${caseId}, 'action.sent', ${encrypt('Invented.')}),
                    (${order.id}, ${caseId}, 'milestone.hidden', ${encrypt('Invented.')}),
                    (${order.id}, ${caseId}, 'project.taken', ${encrypt('Invented.')}),
                    (${order.id}, ${caseId}, 'quote.written', ${encrypt('Invented.')})`;
const [chapter] = await tagged`select id from chapters where case_id = ${caseId} limit 1`;
await tagged`update chapters set closed_with_encrypted = ${encrypt(JSON.stringify({ milestones: ['Invented step'], work: ['Invented work'] }))}
             where id = ${chapter.id}`;

process.env.PAY_WISE = 'invented-handle';
db.useDatabase(tagged);
await db.ensureSchema();
delete process.env.PAY_WISE;

const tables = (await tagged`select table_name from information_schema.tables where table_name in ('projects', 'work')`).map((r) => r.table_name);
check('the table is work', tables.length === 1 && tables[0] === 'work', tables);
const columns = (await tagged`select column_name from information_schema.columns where table_name = 'work'`).map((r) => r.column_name);
check('with done_at, not delivered_at', columns.includes('done_at') && !columns.includes('delivered_at'), columns);
const [kept] = await tagged`select state, done_at from work where case_id = ${caseId}`;
check('and the row kept its date', kept.state === 'done' && kept.done_at !== null, kept);
const indexes = (await tagged`select indexname from pg_indexes where tablename = 'work'`).map((r) => r.indexname);
check('its indexes are named for it', !indexes.some((n) => n.startsWith('projects_')) && indexes.includes('work_case_idx'), indexes);
const kinds = (await tagged`select kind from case_events where order_id = ${order.id} order by id`).map((r) => r.kind);
check('old event kinds take the activity and work names',
  ['activity.outcome', 'activity.moved', 'activity.drafted', 'work.taken'].every((k) => kinds.includes(k))
  && !kinds.some((k) => /^(milestone|action|project)\./.test(k)), kinds);
check('a quote stays a quote, because it was one', kinds.includes('quote.written'));
const { EVENT_KINDS } = await import('../lib/desk.js');
check('every kind has its words', kinds.every((k) => EVENT_KINDS[k]), kinds.filter((k) => !EVENT_KINDS[k]));
const [after] = await tagged`select closed_with_encrypted from chapters where id = ${chapter.id}`;
const closed = JSON.parse(decrypt(after.closed_with_encrypted));
check('a closed chapter names its activities', JSON.stringify(closed) === JSON.stringify({ work: ['Invented work'], activities: ['Invented step'] }), closed);
const goal = (await tagged`select column_name from information_schema.columns where table_name = 'plans'`).map((r) => r.column_name);
check('the goal is called goal', goal.includes('goal') && !goal.includes('path'), goal);
const [wise] = await tagged`select value from settings where name = 'pay:wise'`;
check('the Wise handle comes across from the old setting once', wise?.value === 'invented-handle', wise);
const synced = await tagged`select 1 from information_schema.columns where column_name = 'steps_synced_at'`;
check('the sync markers are gone', synced.length === 0);

db.useDatabase(tagged);
await db.ensureSchema();
check('running it again changes nothing', (await tagged`select count(*)::int as n from work where case_id = ${caseId}`)[0].n === 1);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
