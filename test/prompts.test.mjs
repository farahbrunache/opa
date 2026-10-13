import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const { prompt, sheetPrompt, sheetAids } = await import('../lib/prompts.js');
const desk = (await import('../api/desk.js')).default;
await db.ensureSchema();

const cookie = `op_session=${signSession('admin-1')}`;
async function ask(method, action, payload) {
  const stream = Readable.from(payload ? [JSON.stringify(payload)] : []);
  const req = { method, url: `/api/desk?action=${action}`,
    headers: { cookie, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) };
  const out = {
    statusCode: 200, writableEnded: false, body: null, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
  await desk(req, out);
  return { status: out.statusCode, out: JSON.parse(out.body) };
}

console.log('prompts kept in the database');

let missing = null;
try { await prompt('gaps'); } catch (error) { missing = error; }
check('an unset prompt refuses and names itself',
  missing?.status === 503 && /gaps/.test(missing.message), missing?.message);
check('the sheet aids are empty rather than a refusal',
  JSON.stringify(await sheetAids()) === JSON.stringify({ rules: [], template: null }));

const listed = await ask('GET', 'prompts');
check('the desk lists every prompt, all empty',
  listed.status === 200 && listed.out.prompts.length > 5 && listed.out.prompts.every((p) => p.text === ''),
  listed.out);

const saved = await ask('POST', 'prompt', { name: 'gaps', text: 'Find {gaps} things. Keep {other}.\r\n' });
check('a prompt saves', saved.status === 200, saved.out);
check('placeholders are filled and unknown ones left',
  (await prompt('gaps', { gaps: 4 })) === 'Find 4 things. Keep {other}.');

const [row] = await tagged`select value from settings where name = 'prompt:gaps'`;
check('it is stored sealed', row && !/Find/.test(row.value));

check('an unknown name is refused', (await ask('POST', 'prompt', { name: 'nope', text: 'x' })).status === 400);
check('an empty prompt is refused', (await ask('POST', 'prompt', { name: 'gaps', text: '  ' })).status === 400);

await ask('POST', 'prompt', { name: 'rules', text: 'One rule.\n\nTwo rule.' });
await ask('POST', 'prompt', { name: 'shared', text: 'Shared bit.' });
await ask('POST', 'prompt', { name: 'sheet', text: 'Sheet.\n{rules}\n{shared}' });
check('the sheet prompt carries the rules and the shared part',
  (await sheetPrompt()) === 'Sheet.\n- One rule.\n- Two rule.\nShared bit.', await sheetPrompt());
check('the desk gets the rules as a list',
  JSON.stringify((await sheetAids()).rules) === JSON.stringify(['One rule.', 'Two rule.']));

await ask('POST', 'prompt', { name: 'roadmap', text: 'Roadmap {changes}.\n{rules}\n{shared}' });
check('any prompt can carry the rules and the shared part',
  (await prompt('roadmap', { changes: 3 })) === 'Roadmap 3.\n- One rule.\n- Two rule.\nShared bit.', await prompt('roadmap', { changes: 3 }));
check('a prompt without them does not need them', (await prompt('gaps', { gaps: 2 })) === 'Find 2 things. Keep {other}.');

const after = await ask('GET', 'prompts');
check('a saved prompt reads back', after.out.prompts.find((p) => p.name === 'rules')?.text === 'One rule.\n\nTwo rule.');

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
