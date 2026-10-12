import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const { seedDemo, clearDemo } = await import('../lib/demo.js');

console.log('');
console.log('adding a cost line');
const costsEndpoint = (await import('../api/costs.js')).default;

async function press(action, body) {
  const { Readable } = await import('node:stream');
  const stream = Readable.from([JSON.stringify(body)]);
  const req = {
    method: 'POST', url: `/api/costs?action=${action}`,
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  let out = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; try { out = JSON.parse(text); } catch { out = text; } },
  };
  await costsEndpoint(req, res);
  return { status: res.statusCode, out };
}
const addLine = (body) => press('line-add', body);

const before = (await tagged`select count(*)::int as n from cost_lines`)[0].n;
const typedTheWords = await addLine({ name: 'Hosting', amount: '1.17', reference: 'The product' });
check('the words "the product" are refused, and the refusal says to leave the field empty',
  typedTheWords.status === 404 && /leave the field empty/.test(typedTheWords.out.error), typedTheWords);
const tooShort = await addLine({ name: 'Hosting', amount: '1.17', reference: 'product' });
check('anything not shaped like a reference says the same',
  tooShort.status === 400 && /leave it empty/.test(tooShort.out.error), tooShort);
const empty = await addLine({ name: 'Hosting', amount: '1.17', share: '100', reference: '',
  every: 'month' });
check('an empty field is the product, and the line is saved', empty.status === 201, empty);
const after = (await tagged`select count(*)::int as n from cost_lines`)[0];
const [added] = await tagged`select order_id from cost_lines order by id desc limit 1`;
check('one line more, against the product',
  after.n === before + 1 && added.order_id === null, { after, added });

{
  const [line] = await tagged`select id, note from cost_lines order by id desc limit 1`;
  const id = Number(line.id);
  const edited = await press('line-edit', { id, name: 'Hosting, corrected', amount: '2.50', share: '50', reference: '', every: 'month' });
  check('a cost line is edited', edited.status === 200, edited);
  const [now] = await tagged`select name, amount_cents, share_percent, note from cost_lines where id = ${id}`;
  check('with its new name, amount and share, and the note as it was',
    now.name === 'Hosting, corrected' && Number(now.amount_cents) === 250 && now.share_percent === 50
      && now.note === line.note, now);
  const bad = await press('line-edit', { id, name: 'Hosting', amount: '1', reference: 'The product' });
  check('an edit is refused for what an add would refuse', bad.status === 404, bad);
  const missing = await press('line-edit', { id: 999999, name: 'Nothing', amount: '1' });
  check('editing a line that isn\'t there is refused', missing.status === 404, missing);

  await addLine({ name: 'Rate one', amount: '0.001', every: 'draft-second' });
  const [rate] = await tagged`select id from cost_lines where every = 'draft-second'`;
  await press('line-edit', { id, name: 'Rate two', amount: '0.002', every: 'draft-second' });
  const rates = await tagged`select id from cost_lines where every = 'draft-second'`;
  check('editing a line into the drafting rate replaces the rate there was',
    rates.length === 1 && Number(rates[0].id) === id && Number(rate.id) !== id, rates);
  await press('line-edit', { id, name: 'Rate two, again', amount: '0.003', every: 'draft-second' });
  const still = await tagged`select id from cost_lines where every = 'draft-second'`;
  check('and editing the rate itself keeps it', still.length === 1 && Number(still[0].id) === id, still);
  await press('line-edit', { id, name: 'Hosting, corrected', amount: '2.50', share: '50', every: 'month' });
}

await seedDemo();
await clearDemo();
const kept = (await tagged`select count(*)::int as n from cost_lines`)[0].n;
check('adding and deleting demo data leaves the cost lines as they were', kept === after.n,
  { before: after.n, kept });

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
