let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label);
  else { failures += 1; console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail))); }
}

function configure(settings) {
  for (const slot of ['A', 'B', 'C']) {
    for (const part of ['NAME', 'URL', 'KEY']) delete process.env[`DRAFT_MODEL_${slot}_${part}`];
  }
  Object.assign(process.env, settings);
}

const draft = await import('../lib/draft.js');

console.log('which model is offered');

configure({});
check('nothing is offered when no slot is configured', draft.models().length === 0);

let refused = null;
try { draft.resolve(null); } catch (error) { refused = error; }
check('and asking for one says so rather than failing silently',
  refused?.status === 503 && /slots are/.test(refused.message), refused?.message);

configure({
  DRAFT_MODEL_A_NAME: 'Small', DRAFT_MODEL_A_URL: 'https://api.example/v2/aaa', DRAFT_MODEL_A_KEY: 'k1',
});
check('a slot with an address and a key is offered', draft.models().length === 1);
check('and its name is what the setting says', draft.models()[0].name === 'Small');

configure({ DRAFT_MODEL_A_URL: 'https://api.example/v2/aaa' });
check('a slot with an address but no key is not offered', draft.models().length === 0);

console.log('when the chosen one is retired');
configure({
  DRAFT_MODEL_B_NAME: 'Other', DRAFT_MODEL_B_URL: 'https://api.example/v2/bbb', DRAFT_MODEL_B_KEY: 'k2',
});
const fallback = draft.resolve('A');
check('the one still configured is used', fallback.slot === 'B', fallback.slot);
check('and the caller is told it fell back', fallback.fellBack === true);
check('a trailing slash on the address is dropped',
  draft.resolve('B').url === 'https://api.example/v2/bbb');

configure({
  DRAFT_MODEL_C_NAME: 'Large', DRAFT_MODEL_C_URL: 'https://api.example/v2/ccc', DRAFT_MODEL_C_KEY: 'k3',
});
check('a third slot is offered once set', draft.models().map((m) => m.slot).join(',') === 'C');
check('and drafts when chosen', draft.resolve('C').name === 'Large');

console.log('the exchange with the queue');

const calls = [];
function stub(handlers) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    const answer = handlers.shift();
    return {
      ok: answer.status === undefined || answer.status < 400,
      status: answer.status || 200,
      text: async () => JSON.stringify(answer.body),
    };
  };
}

configure({
  DRAFT_MODEL_A_NAME: 'Small', DRAFT_MODEL_A_URL: 'https://api.example/v2/aaa', DRAFT_MODEL_A_KEY: 'k1',
});

stub([{ body: { id: 'job-1' } }]);
const submitted = await draft.draft([{ role: 'user', content: 'hello' }], 'A');
check('a press submits the job and comes back with its id at once',
  submitted.job === 'job-1' && submitted.model.slot === 'A' && calls.length === 1, submitted);
check('the job is submitted to the run address', calls[0].url.endsWith('/run'), calls.map((c) => c.url));
check('the key is sent as a bearer', calls[0].auth === 'Bearer k1');

stub([{ body: { status: 'IN_QUEUE' } }]);
const queued = await draft.jobState('A', 'job-1');
check('a queued job is only a status', queued.status === 'IN_QUEUE' && !queued.answer && !queued.failure, queued);
check('and it is read at the status address', calls.at(-1).url.endsWith('/status/job-1'), calls.at(-1).url);

stub([{ body: { status: 'COMPLETED', output: { content: ' a drafted reply ', model: 'llama3.2', prompt_tokens: 900, completion_tokens: 120 } } }]);
const written = (await draft.jobState('A', 'job-1')).answer;
check('the reply comes back trimmed', written.content === 'a drafted reply', written.content);
check('the tokens come back with it',
  written.promptTokens === 900 && written.completionTokens === 120, written);

stub([{ body: { status: 'FAILED', error: 'worker ran out of memory' } }]);
const failed = await draft.jobState('A', 'job-2');
check('a failed job says so, with the job and what RunPod said',
  /failed/.test(failed.failure) && /job-2/.test(failed.failure) && /out of memory/.test(failed.failure),
  failed);

stub([{ body: { status: 'COMPLETED', output: { content: '   ' } } }]);
check('an empty answer is a failure', /nothing in it/.test((await draft.jobState('A', 'job-3')).failure || ''));

stub([{ status: 401, body: { error: 'unauthorized' } }]);
let denied = null;
try { await draft.draft([{ role: 'user', content: 'x' }], 'A'); } catch (error) { denied = error; }
check('a refusal names the endpoint and the slot',
  /api\.example\/v2\/aaa/.test(denied?.message || '') && /slot A/.test(denied?.message || ''),
  denied?.message);

check('the server follows a job for ten minutes', draft.FOLLOW_BUDGET_MS === 10 * 60_000);

console.log('');
console.log('the shape a sheet is written in');

const sheet = await import('../lib/sheet.js');

check('every link in the list is an address', sheet.SHEET_LINKS.every(
  ([name, href]) => name && /^https:\/\/app\.chargingthefuture\.com\/\S+$/.test(href)),
  sheet.SHEET_LINKS);

check('an untouched template is all unfilled',
  sheet.unfilledSlots('1. [One.]\n2. [Two.] [Why.]') === 3);
check('a finished sheet has none',
  sheet.unfilledSlots('Invented opening.\n\n1. Ask for a rate per job.') === 0);
check('one left behind is counted',
  sheet.unfilledSlots('1. Ask for a rate per job.\n2. [The second thing.]') === 1);
check('nothing at all counts as nothing',
  sheet.unfilledSlots(null) === 0 && sheet.unfilledSlots('') === 0);

check('an address becomes a link and keeps its words',
  JSON.stringify(sheet.linkParts('Go to https://app.chargingthefuture.com/apps/directory'))
  === JSON.stringify([
    { text: 'Go to ' },
    { text: 'https://app.chargingthefuture.com/apps/directory',
      href: 'https://app.chargingthefuture.com/apps/directory' },
  ]), sheet.linkParts('Go to https://app.chargingthefuture.com/apps/directory'));

const ended = sheet.linkParts('Post it at https://app.chargingthefuture.com/apps/skills-hunt.');
check('a sentence ending on an address keeps its period out of the link',
  ended[1].href === 'https://app.chargingthefuture.com/apps/skills-hunt' && ended[2].text === '.',
  ended);

check('two addresses in one line both come back',
  sheet.linkParts('a https://x.test/one and https://y.test/two b')
    .filter((part) => part.href).length === 2);
check('text with no address is one part',
  sheet.linkParts('nothing to tap here').length === 1);
check('nothing at all is no parts',
  sheet.linkParts('').length === 0 && sheet.linkParts(null).length === 0);

check('every chip carries a full address',
  sheet.SHEET_LINKS.every(([, href]) => sheet.linkParts(href).some((part) => part.href === href)),
  sheet.SHEET_LINKS);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
