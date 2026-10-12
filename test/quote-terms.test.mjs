import { check, db, failureCount, tagged } from './harness.mjs';

await db.ensureSchema();

const { signSession, encrypt } = await import('../lib/crypto.js');
const { Readable } = await import('node:stream');
const clientEndpoint = (await import('../api/client.js')).default;
const { agreedWording } = await import('../lib/quote-terms.js');

function fakeRes() {
  return {
    statusCode: 200, writableEnded: false, body: null,
    setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; },
  };
}

async function answer(account, payload) {
  const stream = Readable.from([JSON.stringify(payload)]);
  const req = {
    method: 'POST',
    url: '/api/client?action=quote-answer',
    headers: {
      cookie: `op_session=${encodeURIComponent(signSession(account))}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.9.9.9',
    },
  };
  Object.assign(req, { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) });
  const res = fakeRes();
  try {
    await clientEndpoint(req, res);
    return { status: res.statusCode, out: res.body ? JSON.parse(res.body) : null };
  } catch (error) {
    return { status: error.status || 500, message: error.message };
  }
}

async function quoteFor(account) {
  const rows = await tagged`
    insert into quotes (account_id, amount_cents, scope_encrypted, status)
    values (${account}, 25000, ${encrypt('Invented scope for a test.')}, 'offered')
    returning id`;
  return Number(rows[0].id);
}

console.log('');
console.log('agreeing to a quote');

const account = 'client-terms-1';
const id = await quoteFor(account);

{
  const unticked = await answer(account, { id, answer: 'agreed' });
  check('an agree without the box ticked is refused', unticked.status === 400, unticked);
  const rows = await tagged`select status, agreed_terms from quotes where id = ${id}`;
  check('and the quote is still open', rows[0].status === 'offered' && rows[0].agreed_terms === null, rows);
}

{
  const ticked = await answer(account, { id, answer: 'agreed', accepted: true, terms: 'Invented other words.' });
  check('ticked, it is agreed', ticked.status === 200, ticked);
  const rows = await tagged`select status, agreed_terms from quotes where id = ${id}`;
  check('the words kept are the app\'s own, not the request\'s',
    rows[0].status === 'agreed' && rows[0].agreed_terms === agreedWording(), rows);
  const shown = ticked.out.quotes.find((q) => Number(q.id) === id);
  check('and the client screen gets them back', shown && shown.agreedTerms === agreedWording(), shown);
}

{
  const other = await quoteFor(account);
  const declined = await answer(account, { id: other, answer: 'declined', reason: 'Invented reason.' });
  check('a no needs no box', declined.status === 200, declined);
  const rows = await tagged`select agreed_terms from quotes where id = ${other}`;
  check('and keeps no agreed words', rows[0].agreed_terms === null, rows);
}

{
  const theirs = await quoteFor('client-terms-2');
  const notMine = await answer(account, { id: theirs, answer: 'agreed', accepted: true });
  check('somebody else\'s quote cannot be agreed to', notMine.status === 409, notMine);
}

const failures = failureCount();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
