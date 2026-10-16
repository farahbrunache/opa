import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();
process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
const { signSession } = await import('../lib/crypto.js');
const deskEndpoint = (await import('../api/desk.js')).default;
const { seedDemo, clearDemo } = await import('../lib/demo.js');

async function ask(url) {
  let payload = null;
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; payload = JSON.parse(text); },
  };
  await deskEndpoint({ method: 'GET', url, headers: { cookie: `op_session=${signSession('admin-1')}` } }, res);
  return payload;
}

const tab = (state) => ask(`/api/desk?action=queue&state=${state}`);
const named = (page, name) => page.people.find((p) => p.name === name);

await seedDemo();

console.log('');
console.log('new calls');
const waiting = await tab('waiting');
const unread = waiting.people.filter((p) => !p.name && !p.hasStrategy);
const read = waiting.people.filter((p) => !p.name && p.hasStrategy);
check('a call with no strategy says write the strategy', unread.length >= 1, waiting.people);
check('a call with a strategy says decide', read.length >= 1, waiting.people);
check('and neither has an account linked', [...unread, ...read].every((p) => p.linked === false));
check('a session decided again under a linked person carries the name',
  Boolean(named(waiting, 'Odile Marchbanks')));
check('a follow-up after a go is not a new call', !named(waiting, 'Teodor Braskwell'));

console.log('wrote to you');
const replies = await tab('replies');
check('somebody who wrote carries when', Boolean(named(replies, 'Ines Halvorgaard')?.wroteAt),
  named(replies, 'Ines Halvorgaard'));

console.log('working');
const active = await tab('active');
const marisol = named(active, 'Marisol Ketterby');
check('late work has its date', Boolean(marisol?.workDueAt), marisol);
check('activities are counted with the ones done', marisol?.activities === 4 && marisol?.activitiesDone === 2, marisol);
check('and the sessions left on the card', marisol?.sessionsLeft === 3, marisol);
check('a no-go is not in working', !named(active, 'Dev Oyelaranmi'));
const ines = named(active, 'Ines Halvorgaard');
check('a reminder coming up carries its date', ines?.reminderAt && new Date(ines.reminderAt) > new Date(), ines);
const teodor = active.people.find((p) => p.name === 'Teodor Braskwell' && p.decision === 'go');
check('an introduction still waiting names the other side', teodor?.introWaiting === true
  && teodor?.introWith === 'Marisol Ketterby', teodor);
const kade = named(active, 'Kade Ferrow');
check('the quiet one has nothing pressing', kade && !kade.workDueAt && !kade.reminderAt && !kade.introWaiting, kade);
check('and says when you last spoke', Boolean(kade?.lastContactAt), kade);
check('with one of two activities done', kade?.activities === 2 && kade?.activitiesDone === 1, kade);

console.log('closed');
const closed = await tab('closed');
const wren = named(closed, 'Wren Abernathe');
check('a closed case says when it was closed', Boolean(wren?.closedAt), wren);
check('and that the next steps went out', Boolean(wren?.recommendedAt), wren);

console.log('a search crosses the tabs');
const found = await ask('/api/desk?action=queue&q=kade');
check('each row says which tab it would be in', found.people[0]?.group === 'active', found.people);

console.log('under the title');
check('how many people paid, once each', active.paid >= 8, active.paid);
check('the approached total includes the demo taps', active.approached === 7, active.approached);
const today = await ask('/api/desk?action=today');
check('five of the seven demo taps are this week', today.approached?.week === 5, today.approached);

await clearDemo();
const after = await ask('/api/desk?action=today');
check('deleting demo data takes the taps with it', after.approached.total === null && after.approached.week === 0,
  after.approached);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
