import { ensureSchema, sql } from '../lib/db.js';
import { requireAdmin } from '../lib/auth.js';
import { VERDICT_DAYS, costsNow, isCostUnit } from '../lib/costs.js';
import { chargesOf } from '../lib/costs-items.js';
import { looksLikeReference, normalizeReference } from '../lib/orders.js';
import { HttpError, handle, readJson, send } from '../lib/http.js';
import { pullBillNow } from '../lib/desk-drafting-bill.js';
import { priceNow } from '../lib/pricing.js';
import { savePrices } from '../lib/sessions.js';

async function now(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const figures = await costsNow();
  const rate = figures.lines.find((l) => l.every === 'draft-second');
  const charges = await chargesOf(VERDICT_DAYS, figures.lines, rate ? rate.costs : null);
  const price = await priceNow(rate ? rate.costs : null);
  send(res, 200, { ...figures, charges, price, billReader: Boolean((process.env.RUNPOD_API_KEY || '').trim()) });
}

async function readLine(body) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'A cost line needs a name. Render, the domain, your time.');

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'What does it cost, in dollars?');
  }
  const cents = Math.round(amount * 100);

  const share = body.share === undefined || body.share === null || body.share === ''
    ? 100
    : Number(body.share);
  if (!Number.isFinite(share) || share <= 0 || share > 100) {
    throw new HttpError(400, 'The share is a number from 1 to 100. A third of a bill is 33.');
  }

  const every = String(body.every || 'month');
  if (!isCostUnit(every)) {
    throw new HttpError(400, 'A line is charged every month or per second of drafting.');
  }

  let orderId = null;
  const reference = normalizeReference(body.reference || '');
  if (reference) {
    if (!looksLikeReference(reference)) {
      throw new HttpError(
        400,
        'Whose cost is it takes the 10-character reference of one session, or nothing. For '
          + 'the product, leave it empty.',
      );
    }
    const [found] = await sql()`
      select id, is_demo, is_mine from orders where reference_code = ${reference} limit 1
    `;
    if (!found) {
      throw new HttpError(
        404,
        `No session with the reference ${reference}. For the product, leave the field empty.`,
      );
    }
    if (found.is_mine) {
      throw new HttpError(
        409,
        "That's your own test session. Leave the reference empty.",
      );
    }
    if (found.is_demo) {
      throw new HttpError(
        409,
        'That is a demo session. Leave the reference empty.',
      );
    }
    orderId = Number(found.id);
  }

  return { name, cents, share: Math.round(share), every, orderId };
}

async function oneRate(line, keep) {
  if (line.every !== 'draft-second') return;
  await sql()`delete from cost_lines where every = 'draft-second' and id <> ${keep}`;
}

async function addLine(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const line = await readLine(body);
  await oneRate(line, 0);
  await sql()`
    insert into cost_lines (name, amount_cents, share_percent, every, note, order_id)
    values (${line.name}, ${line.cents}, ${line.share}, ${line.every},
            ${String(body.note || '').trim().slice(0, 300) || null}, ${line.orderId})
  `;
  send(res, 201, { ok: true });
}

async function editLine(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which line?');
  const line = await readLine(body);
  const [found] = await sql()`select id from cost_lines where id = ${id}`;
  if (!found) throw new HttpError(404, 'No cost line with that number.');
  await oneRate(line, id);
  await sql()`
    update cost_lines
       set name = ${line.name}, amount_cents = ${line.cents}, share_percent = ${line.share},
           every = ${line.every}, order_id = ${line.orderId}
     where id = ${id}
  `;
  send(res, 200, { ok: true });
}

async function removeLine(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which line?');
  const gone = await sql()`delete from cost_lines where id = ${id} returning id`;
  if (!gone.length) throw new HttpError(404, 'No cost line with that number.');
  send(res, 200, { ok: true });
}

const PRICE_WORDS = {
  hourLow: 'Your rate an hour, low',
  hourHigh: 'Your rate an hour, high',
  standard: 'The standard session',
  access: 'The access session',
  aMonth: 'Access sessions a month',
  wise: 'The Wise handle',
  confirmHours: 'Confirm within, hours',
  cap: 'Session cap, minutes',
};

async function prices(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const wrong = await savePrices(await readJson(req));
  if (wrong) {
    const need = wrong === 'wise' ? 'one word with no spaces'
      : ['aMonth', 'cap'].includes(wrong) ? 'a whole number above zero' : 'a number above zero';
    throw new HttpError(400, `${PRICE_WORDS[wrong]}: ${need}, or empty.`);
  }
  send(res, 200, { ok: true });
}

export default handle(['GET', 'POST'], async (req, res) => {
  const action = new URL(req.url, 'https://placeholder.invalid').searchParams.get('action');
  if (req.method === 'GET' && action === 'now') return now(req, res);
  if (req.method === 'POST' && action === 'line-add') return addLine(req, res);
  if (req.method === 'POST' && action === 'line-edit') return editLine(req, res);
  if (req.method === 'POST' && action === 'line-remove') return removeLine(req, res);
  if (req.method === 'POST' && action === 'pull-bill') return pullBillNow(req, res);
  if (req.method === 'POST' && action === 'prices') return prices(req, res);
  throw new HttpError(
    400,
    'Use action=now, action=line-add, action=line-edit, action=line-remove, action=pull-bill or action=prices.',
  );
});
