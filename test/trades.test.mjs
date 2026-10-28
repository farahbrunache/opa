import { Readable } from 'node:stream';
import { check, db, failureCount, tagged } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.SWEEP_SECRET = 'invented-sweep-secret';
const { signSession } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const sweep = (await import('../api/sweep.js')).default;
await db.ensureSchema();

const cookie = `op_session=${signSession('admin-1')}`;
function res() {
  return { statusCode: 200, writableEnded: false, body: null, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
}
async function call(handler, method, url, payload, headers = {}) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = res();
  try {
    await handler({ method, url, headers: { cookie, 'content-type': 'application/json', ...headers },
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
    return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

const skillsOf = {
  't-plumb': ['Pipe fitting', 'Leak repair', 'Estimating'],
  't-elec': ['Wiring', 'Estimating'],
  't-carp': ['Framing', 'Estimating'],
};
let sent = null;
let titles = [['t-plumb', 'Plumber'], ['t-elec', 'Electrician'], ['t-carp', 'Carpenter']];
globalThis.fetch = async (url, options) => {
  sent = { url, authorization: options.headers.authorization };
  return new Response(JSON.stringify({ items: [{ id: 's-build', name: 'Construction', displayOrder: 1,
    isActive: true, jobTitles: titles.map(([id, name], i) => ({ id, name, displayOrder: i, isActive: true,
      skills: (skillsOf[id] || []).map((skill, j) => ({ id: `${id}-${j}`, name: skill, displayOrder: j, isActive: true })) })) }] }));
};

console.log('the nightly script copy');
delete process.env.RETELL_SECRET_KEY;
const script = await call(sweep, 'POST', '/api/sweep?action=script', {}, { authorization: 'Bearer invented-sweep-secret' });
check('without the voice key it names the setting', script.status === 503
  && /RETELL_SECRET_KEY/.test(script.out?.error || script.message), script);

console.log('copying the list');
const off = await call(sweep, 'POST', '/api/sweep?action=trades', {}, { authorization: 'Bearer invented-sweep-secret' });
check('without its token it says so', off.status === 503 && /TAXONOMY_TOKEN/.test(off.out?.error || off.message), off);
process.env.TAXONOMY_TOKEN = 'onepercent.invented';
const copied = await call(sweep, 'POST', '/api/sweep?action=trades', {}, { authorization: 'Bearer invented-sweep-secret' });
check('the daily job copies it', copied.status === 200 && copied.out.titles === 3, copied);
check('from the hierarchy route, with the name.secret credential',
  sent.url === 'https://app.lagatos.com/api/skills-taxonomy/hierarchy' && sent.authorization === 'Bearer onepercent.invented', sent);
titles = titles.slice(0, 2);
const again = await call(desk, 'POST', '/api/desk?action=trades-copy', {});
check('copying by hand works too, and a title gone from their list is retired', again.out.retired === 1, again);
const [carp] = await tagged`select active from trades where id = 't-carp'`;
check('retired, not deleted', carp && carp.active === false, carp);

async function order(n, decision) {
  const [row] = await tagged`
    insert into orders (claim_token_hash, card_code_hash, card_amount_cents, payment_method,
                        reference_code, status, decision)
    values (${'tr-h-' + n}, ${'tr-c-' + n}, 700, 'wise', ${'TRADE' + n}, 'confirmed', ${decision})
    returning id`;
  return Number(row.id);
}
const a = await order('A', 'go');
const b = await order('B', 'go');
const c = await order('C', 'go');
const d = await order('D', 'no-go');

console.log('setting trades and suggesting');
check('a trade off the list is refused', (await call(desk, 'POST', '/api/desk?action=trade', { id: a, trade: 'nope' })).status === 404);
await call(desk, 'POST', '/api/desk?action=trade', { id: a, trade: 't-plumb' });
await call(desk, 'POST', '/api/desk?action=trade', { id: b, trade: 't-plumb' });
await call(desk, 'POST', '/api/desk?action=trade', { id: c, trade: 't-elec' });
await call(desk, 'POST', '/api/desk?action=trade', { id: d, trade: 't-elec' });
const person = (await call(desk, 'GET', `/api/desk?action=person&id=${a}`)).out;
check('their trade comes back with the list to pick from', person.trade?.title === 'Plumber' && person.trades.length === 2, person.trade);
check('the same trade is suggested', person.couldWorkWith.sameTrade.map((p) => p.id).join() === String(b), person.couldWorkWith);
check('and the same sector in another trade, only among people told yes',
  person.couldWorkWith.sameSector.map((p) => p.id).join() === String(c), person.couldWorkWith);

console.log('pairs across everybody');
let pairs = (await call(desk, 'GET', '/api/desk?action=pairs')).out.pairs;
check('three people told yes in one sector make three pairs', pairs.length === 3, pairs);
await call(desk, 'POST', '/api/desk?action=introduce', { id: a, reference: 'TRADEB', reason: 'Both plumbers.' });
pairs = (await call(desk, 'GET', '/api/desk?action=pairs')).out.pairs;
check('an introduction takes that pair off the list', pairs.length === 2
  && !pairs.some((p) => [p.a.id, p.b.id].sort().join() === [a, b].sort().join()), pairs);
const after = (await call(desk, 'GET', `/api/desk?action=person&id=${a}`)).out;
check('and off their suggestions', after.couldWorkWith.sameTrade.length === 0, after.couldWorkWith);

console.log('introducing somebody by a profile link');
const link = 'https://example.com/profile/invented-electrician';
check('a link that is not a web address is refused',
  (await call(desk, 'POST', '/api/desk?action=introduce', { id: c, link: 'the electrician' })).status === 400);
check('a reference and a link at once is refused',
  (await call(desk, 'POST', '/api/desk?action=introduce', { id: c, reference: 'TRADEA', link })).status === 400);
check('a profile link is accepted',
  (await call(desk, 'POST', '/api/desk?action=introduce', { id: c, link, reason: 'Sends out jobs.' })).status === 201);
check('the same link twice is refused',
  (await call(desk, 'POST', '/api/desk?action=introduce', { id: c, link })).status === 409);
let withLink = (await call(desk, 'GET', `/api/desk?action=person&id=${c}`)).out;
const intro = withLink.introductions.find((i) => i.link === link);
check('it shows on the record with the link and no client on the other side',
  Boolean(intro) && intro.them === null && intro.outcome === 'waiting', withLink.introductions);
check('and on the trail', withLink.events.some((e) => e.kind === 'introduction.made' && e.detail.includes(link)),
  withLink.events.map((e) => [e.kind, e.detail]));

const funnelBefore = (await call(desk, 'GET', '/api/desk?action=funnel')).out.stages;
const doneBefore = funnelBefore.find((s) => s.key === 'done').count;
check('recording the outcome works for a link introduction',
  (await call(desk, 'POST', '/api/desk?action=introduction-record',
    { id: c, introductionId: intro.id, outcome: 'worked', note: 'Two jobs.' })).status === 200);
withLink = (await call(desk, 'GET', `/api/desk?action=person&id=${c}`)).out;
check('and reads back', withLink.introductions.find((i) => i.id === intro.id).outcome === 'worked');
const funnelAfter = (await call(desk, 'GET', '/api/desk?action=funnel')).out.stages;
check('an introduction that worked is the last row of the funnel',
  funnelAfter.find((s) => s.key === 'done').count === doneBefore + 1,
  funnelAfter.map((s) => [s.key, s.count]));

console.log('skills first, job title second');
const e = await order('E', 'go');
const list = (await call(desk, 'GET', '/api/desk?action=skills-list')).out.skills;
check('the skills came with the list, and a retired title takes its skills with it',
  list.length === 5 && !list.some((k) => k.tradeId === 't-carp'), list);
const picked = await call(desk, 'POST', '/api/desk?action=skills',
  { id: e, skills: ['t-plumb-0', 't-plumb-1', 't-elec-1'] });
check('picking skills sets the job title most of them sit under',
  picked.status === 200 && picked.out.trade?.id === 't-plumb' && picked.out.skills.length === 3, picked);
const withSkills = (await call(desk, 'GET', `/api/desk?action=person&id=${e}`)).out;
check('the record carries the skills and every job title they sit under, most matches first',
  withSkills.trade?.title === 'Plumber' && withSkills.roles.map((r) => r.id).join() === 't-plumb,t-elec', withSkills.roles);
check('and the change is on the trail', withSkills.events.some((ev) => ev.kind === 'skills'
  && ev.detail.includes('Job title: Plumber')), withSkills.events);
const tooMany = Array.from({ length: 11 }, (_, i) => `x-${i}`);
check('ten skills at most', (await call(desk, 'POST', '/api/desk?action=skills', { id: e, skills: tooMany })).status === 400);
check('a skill off the list is refused',
  (await call(desk, 'POST', '/api/desk?action=skills', { id: e, skills: ['nope'] })).status === 404);
const unchanged = (await call(desk, 'GET', `/api/desk?action=person&id=${e}`)).out;
check('and a refusal leaves what was picked alone', unchanged.skills.length === 3, unchanged.skills);
const moved = await call(desk, 'POST', '/api/desk?action=skills', { id: e, skills: ['t-elec-0', 't-elec-1'] });
check('changing them works the job title out again', moved.out.trade?.id === 't-elec', moved.out);
const cleared = await call(desk, 'POST', '/api/desk?action=skills', { id: e, skills: [] });
check('clearing them clears the job title', cleared.out.trade === null && cleared.out.skills.length === 0, cleared.out);

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
