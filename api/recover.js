import { ensureSchema, sql } from '../lib/db.js';
import { underLimit } from '../lib/settings.js';
import { callerKey, claimToken, keyedHash, normalizeCardCode } from '../lib/crypto.js';
import { looksLikeReference, normalizeReference } from '../lib/orders.js';
import { HttpError, handle, readJson, send } from '../lib/http.js';

export default handle('POST', async (req, res) => {
  const body = await readJson(req);
  const raw = String(body.code || '').trim();
  const reference = normalizeReference(raw);
  const cardCode = normalizeCardCode(raw);

  const asReference = looksLikeReference(reference);
  if (!asReference && cardCode.length < 8) {
    throw new HttpError(400, 'Enter your reference, or the gift card code you sent.');
  }

  await ensureSchema();

  if (!(await underLimit('recover', callerKey(req), 8, 3600))) {
    throw new HttpError(429, 'Too many recovery attempts from here in the last hour. Try later.');
  }

  const rows = await sql()`
    select id from orders
     where reference_code = ${asReference ? reference : null}
        or card_code_hash = ${cardCode.length >= 8 ? keyedHash(cardCode) : null}
     limit 1
  `;
  if (!rows.length) {
    throw new HttpError(
      404,
      'Nothing here matches that. Check your reference or gift card code, or start an order if ' +
        'you have not yet.',
    );
  }

  const token = claimToken();
  await sql()`
    update orders set claim_token_hash = ${keyedHash(token)} where id = ${rows[0].id}
  `;

  send(res, 200, { claim: `/claim?t=${token}` });
});
