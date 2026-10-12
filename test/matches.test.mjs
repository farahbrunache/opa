import { check, db, failureCount, seedPrompts, tagged } from './harness.mjs';

await db.ensureSchema();
await seedPrompts();
await (await import('../lib/settings.js')).writeChoice('prompt:matches',
  (await import('../lib/crypto.js')).encrypt('Pick {matches}. Sources: {sources}.'));

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession, encrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const deskEndpoint = (await import('../api/desk.js')).default;
const { seedDemo, clearDemo } = await import('../lib/demo.js');
const { matchPrompt, readMatches, readSources } = await import('../lib/desk-matches.js');

function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null,
    setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}

async function press(action, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST',
    url: `/api/desk?action=${action}`,
    headers: { cookie: `op_session=${signSession('admin-1')}`, 'content-type': 'application/json' },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = fakeRes();
  try {
    await deskEndpoint(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

async function ask(action) {
  const req = {
    method: 'GET',
    url: `/api/desk?action=${action}`,
    headers: { cookie: `op_session=${signSession('admin-1')}` },
  };
  const res = fakeRes();
  await deskEndpoint(req, res);
  return JSON.parse(res.body);
}

let n = 0;
async function newOrder({ account = null, decision = 'go', name = null, demo = false, fields = null,
  words = 'Agent: Invented.\nCaller: Invented.' } = {}) {
  n += 1;
  const rows = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision, client_account_id, is_demo)
    values (${'hm-' + n}, ${'cm-' + n}, 700, 'wise', ${'RM' + String(n).padStart(8, '0')},
            'confirmed', ${decision}, ${account}, ${demo})
    returning id`;
  const id = Number(rows[0].id);
  if (account) {
    const caseId = await db.caseForAccount(account);
    await tagged`update orders set case_id = ${caseId} where id = ${id}`;
    if (name) await tagged`update cases set name_encrypted = ${encrypt(name)} where id = ${caseId}`;
  }
  await tagged`
    insert into calls (order_id, call_id, transcript_encrypted, summary_encrypted, fields_encrypted,
                       started_at, ended_at)
    values (${id}, ${'m-call-' + n}, ${encrypt(words)}, ${encrypt('Invented summary SUMMARYLEAK')},
            ${fields ? encrypt(JSON.stringify(fields)) : null}, now(), now())`;
  return id;
}

console.log('');
console.log('skipping a suggested pair');

const a = await newOrder({ account: 'client-m-a', name: 'Invented Alder' });
const b = await newOrder({ account: 'client-m-b', name: 'Invented Birch' });

{
  const self = await press('skip', { id: a, order: a });
  check('a person paired with themselves is refused', self.status === 400, self);
  const second = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, client_account_id, case_id)
    select 'hm-x', 'cm-x', 700, 'wise', 'RMX0000001', 'confirmed', client_account_id, case_id
      from orders where id = ${a}
    returning id`;
  const same = await press('skip', { id: a, order: Number(second[0].id) });
  check('two sessions of one person are refused too', same.status === 400, same);

  const one = await press('skip', { id: a, order: b });
  check('a pair is skipped', one.status === 200 && one.out.skipped === true, one);
  const other = await press('skip', { id: b, order: a });
  check('skipping it from the other end is the same pair',
    other.status === 200 && other.out.skipped === false, other);
  const rows = await tagged`select pair_key from pair_skips`;
  check('one row, order-independent',
    rows.length === 1 && rows[0].pair_key === `o:${Math.min(a, b)}|o:${Math.max(a, b)}`, rows);

  const person = await ask(`person&id=${b}`);
  check('the trail says so', person.events.some((e) => e.kind === 'pair.skipped'), person.events);

  const undo = await press('unskip', { id: b, order: a });
  const left = await tagged`select count(*)::int as n from pair_skips`;
  check('Undo puts it back', undo.status === 200 && left[0].n === 0, left);

  const profile = await press('skip', { id: a, profile: 'https://example.com/apps/directory/profile/invented-1' });
  check('a Directory profile is skipped by its link', profile.status === 200 && profile.out.skipped, profile);
  const byId = await press('skip', { id: a, profile: 'invented-1' });
  check('and by its id it is the same pair', byId.status === 200 && byId.out.skipped === false, byId);
  const stored = await tagged`select pair_key from pair_skips where pair_key like ${`o:${a}|p:%`}`;
  check('kept as a keyed hash, not the id',
    stored.length === 1 && !stored[0].pair_key.includes('invented-1'), stored);
  const bad = await press('skip', { id: a, profile: 'https://example.com/not/a/profile' });
  check('a link that is not a profile is refused', bad.status === 400, bad);
}

{
  await seedDemo();
  const before = await ask('pairs');
  const pair = before.pairs[0];
  check('the demo leaves pairs to introduce', Boolean(pair), before);
  const skipped = await tagged`select count(*)::int as n from pair_skips where is_demo`;
  check('and seeds two skipped suggestions', skipped[0].n === 2, skipped);
  await press('skip', { id: pair.a.id, order: pair.b.id });
  const after = await ask('pairs');
  check('a skipped pair is gone from Everyone',
    !after.pairs.some((p) => p.a.id === pair.a.id && p.b.id === pair.b.id), after.pairs);
  await clearDemo();
  const gone = await tagged`select count(*)::int as n from pair_skips where is_demo`;
  check('the demo delete takes demo skips', gone[0].n === 0, gone);
  const kept = await tagged`select count(*)::int as n from pair_skips where not is_demo`;
  check('and leaves real ones', kept[0].n === 1, kept);
}

console.log('');
console.log('find matches');

{
  const blank = { rate: '', inTheWay: '', firstCustomer: '' };
  const me = await newOrder({ account: 'client-m-me', name: 'Invented Mesubject',
    fields: { trade: 'Invented plumber', ...blank } });
  const them = await newOrder({
    account: 'client-m-them', name: 'Zebulon Quixtrade',
    words: 'Agent: What do you do?\nCaller: TRANSCRIPTLEAK framing houses.',
    fields: { trade: 'Invented carpenter', rate: 'Invented forty a job', inTheWay: '', firstCustomer: '' },
  });
  await tagged`insert into messages (account_id, author, body_encrypted)
               values ('client-m-them', 'client', ${encrypt('MESSAGELEAK in their own words')})`;
  await tagged`insert into case_events (order_id, kind, detail_encrypted)
               values (${them}, 'note', ${encrypt('Invented owner note on them')})`;
  await newOrder({ demo: true, account: 'client-m-demo', name: 'Invented Demoperson',
    fields: { trade: 'DEMOONLY welder', ...blank } });
  const mine = await newOrder({ account: 'client-m-mine', fields: { trade: 'MINEONLY tester', ...blank } });
  await tagged`update orders set is_mine = true where id = ${mine}`;

  const { messages, index, said, self } = await matchPrompt(me);
  const prompt = messages.map((m) => m.content).join('\n');
  check("the owner's typed lines about another client go in",
    /Invented carpenter/.test(prompt) && /Invented forty a job/.test(prompt), prompt);
  check("and the owner's notes", /Invented owner note on them/.test(prompt), prompt);
  check('never their name', !/Zebulon|Quixtrade|Alder|Birch|Mesubject/.test(prompt), prompt);
  check('never a transcript or a call summary', !/TRANSCRIPTLEAK|SUMMARYLEAK/.test(prompt), prompt);
  check('never a message', !/MESSAGELEAK/.test(prompt), prompt);
  check('no demo record on a real one', !/DEMOONLY/.test(prompt), prompt);
  check("never a session marked as the owner's own", !/MINEONLY/.test(prompt), prompt);
  check('clients are an index', /^C\d+: /m.test(prompt), prompt);
  check('the Directory says it is not connected', said === 'Directory not connected', said);

  const key = [...index.entries()].find(([, v]) => v.kind === 'client' && Number(v.row.id) === them)?.[0];
  const back = readMatches(`${key}: Both build; they can send each other jobs.\nC999: nobody\n${key}: twice`, index);
  check('the answer is turned back into the person, once',
    back.length === 1 && back[0].orderId === them && back[0].name === 'Zebulon Quixtrade', back);

  check('the prompt fills in the count and the sources the model may pick from',
    /Pick 5\. Sources: job title, call line,/.test(prompt), prompt);
  check("this person is named on a chip by first name, and it stays out of the prompt",
    self === 'Invented' && !/Mesubject/.test(prompt), self);
  const [withChips] = readMatches(`${key}: Both build. | sources: this job title, them call line, `
    + 'them TRANSCRIPTLEAK framing houses, them Invented forty a job, them profile, this note, them skills', index, self);
  check('the chips are the fixed labels, with first names',
    JSON.stringify(withChips.sources) === JSON.stringify([
      "Invented's job title", "Zebulon's call line", 'Your note on Invented', "Zebulon's skills",
    ]), withChips.sources);
  check("and never another client's material",
    !withChips.sources.some((c) => /TRANSCRIPTLEAK|forty|framing|Quixtrade/.test(c)), withChips.sources);
  check('the reason stops at the bar', withChips.reason === 'Both build.', withChips.reason);
  check('a Directory profile is named only as one',
    JSON.stringify(readSources('them profile, them call line, this skills', { kind: 'directory', self: 'Invented' }))
      === JSON.stringify(['Directory profile', "Invented's skills"]));
  check('no bar, no chips', readMatches(`${key}: Both build.`, index, self)[0].sources.length === 0);

  const refused = await press('find-matches', { id: me });
  check('with no model set up it is refused and says so', refused.status === 503, refused);

  const person = await ask(`person&id=${me}`);
  check('and the record carries no model, so the button hides', person.drafting.models.length === 0, person.drafting);
}

const failures = failureCount();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
