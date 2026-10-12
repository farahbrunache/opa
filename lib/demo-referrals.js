import crypto from 'node:crypto';
import { sql } from './db.js';
import { encrypt } from './crypto.js';
import { REFERENCE_ALPHABET } from './orders.js';

function code() {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += REFERENCE_ALPHABET[crypto.randomInt(0, REFERENCE_ALPHABET.length)];
  return out;
}

async function caseOf(account) {
  const [row] = await sql()`select id from cases where account_id = ${account}`;
  return row ? Number(row.id) : null;
}

async function giveCode(caseId) {
  const [row] = await sql()`update cases set referral_code = ${code()} where id = ${caseId} returning referral_code`;
  return row.referral_code;
}

export async function seedReferrals(stamp) {
  const marisol = await caseOf(`demo-acct-working-${stamp}`);
  const kade = await caseOf(`demo-acct-quiet-${stamp}`);
  if (!marisol || !kade) return [];
  const hers = await giveCode(marisol);
  const his = await giveCode(kade);

  for (const account of [`demo-acct-returning-${stamp}`, `demo-acct-closed-${stamp}`]) {
    await sql()`
      update orders set from_code = ${hers}
       where id = (select min(o.id) from orders o join cases k on k.id = o.case_id
                    where k.account_id = ${account})
    `;
  }
  await sql()`
    update orders set from_code = ${his}
     where reference_code = 'DEMO2-CCCCC' and is_demo
  `;
  await sql()`
    update orders set flagged_at = now() - interval '20 hours',
                      flag_why_encrypted = ${encrypt('Sample flag reason.')}
     where id = (select max(id) from orders where case_id = ${kade} and status = 'confirmed')
  `;
  await sql()`
    update orders set brought_by = 'unknown'
     where id = (select min(o.id) from orders o join cases k on k.id = o.case_id
                  where k.account_id = ${`demo-acct-again-${stamp}`})
  `;
  return [{ reference: 'DEMO who brought whom', is: 'two brought through a link, one flagged with somebody under the flag, one not known' }];
}
