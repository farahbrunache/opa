import { sql } from './db.js';
import { encrypt, keyedHash } from './crypto.js';

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const CLAIM_DEMOS = [
  { reference: 'DEMOW-WWWWW', is: 'claim page: waiting on a Wise transfer', method: 'wise', status: 'pending' },
  { reference: 'DEMOG-GGGGG', is: 'claim page: waiting on a gift card check', method: 'amazon', status: 'pending',
    paidMinutesAgo: 14 * 60, code: 'DEMO-GIFTCD-0000' },
  { reference: 'DEMOR-RRRRR', is: 'claim page: rejected, nothing arrived', method: 'wise', status: 'rejected', reason: 'not_received' },
  { reference: 'DEMOD-DDDDD', is: 'claim page: a call that dropped at 11:42, 2 starts and 23 minutes left', method: 'wise', status: 'confirmed', dropped: 702 },
];

export async function seedClaimStates() {
  const made = [];
  for (const demo of CLAIM_DEMOS) {
    const [order] = await sql()`
      insert into orders (claim_token_hash, card_code_hash, card_code_encrypted, card_amount_cents,
                          payment_method, reference_code, status, reject_reason, decided_at,
                          is_demo, created_at)
      values (${keyedHash(`demo-claim-${demo.reference}-${Date.now()}`)},
              ${keyedHash(`demo-card-${demo.reference}-${Date.now()}`)},
              ${demo.code ? encrypt(demo.code) : null},
              700, ${demo.method}, ${demo.reference}, ${demo.status}, ${demo.reason || null},
              ${demo.status === 'pending' ? null : minutesAgo(90)}, true,
              ${minutesAgo(demo.paidMinutesAgo || 120)})
      returning id
    `;
    if (demo.dropped) {
      await sql()`
        insert into calls (order_id, call_id, kind, seconds, started_at, ended_at)
        values (${order.id}, ${`demo-call-dropped-${order.id}`}, 'intake', ${demo.dropped},
                ${minutesAgo(20)}, ${minutesAgo(8)})
      `;
      await sql()`update orders set session_starts = 1, first_started_at = ${minutesAgo(20)}
                   where id = ${order.id}`;
    }
    made.push({ reference: demo.reference, is: demo.is });
  }
  return made;
}
