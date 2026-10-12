import { ensureSchema } from './db.js';
import { requireAdmin } from './auth.js';
import { HttpError, send } from './http.js';
import { draftingByDay } from './runpod-billing.js';
import { recordMeteredSpend } from './spend.js';

const WAS_DEMO = true;

export async function pullDraftingBill() {
  await ensureSchema();
  const bill = await draftingByDay();

  let written = 0;
  let total = 0;
  for (const day of bill.days) {
    await recordMeteredSpend({
      kind: 'drafting',
      source: `drafting:${day.at.slice(0, 10)}`,
      amountCents: Math.round(day.amount * 100),
      wasDemo: WAS_DEMO,
      at: day.at,
    });
    written += 1;
    total += day.amount;
  }

  return { endpoints: bill.endpoints.length, days: written, total };
}

export async function draftingBillSweep(req, res) {
  const expected = (process.env.SWEEP_SECRET || '').trim();
  if (!expected) {
    throw new HttpError(
      503,
      'SWEEP_SECRET is not set, so a scheduled caller cannot prove itself and this refuses '
        + 'rather than running for anybody who asks.',
    );
  }
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (given !== expected) throw new HttpError(401, 'That is not the sweep secret.');

  send(res, 200, await pullDraftingBill());
}

export async function pullBillNow(req, res) {
  requireAdmin(req);
  send(res, 200, await pullDraftingBill());
}
