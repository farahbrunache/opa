import { refreshTrades } from '../lib/trades.js';
import Retell from 'retell-sdk';

import { ensureSchema, sql } from '../lib/db.js';
import { keepRecord } from '../lib/calls.js';
import { encrypt } from '../lib/crypto.js';
import { HttpError, handle, send } from '../lib/http.js';
import { agentScriptExport } from '../lib/voice.js';

const PER_RUN = 25;

function requireSweeper(req) {
  const secret = process.env.SWEEP_SECRET;
  if (!secret) {
    throw new HttpError(503, 'SWEEP_SECRET is not set, so a scheduled job cannot prove itself.');
  }
  const sent = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (sent.length !== secret.length || sent !== secret) {
    throw new HttpError(401, 'That is not the scheduled job.');
  }
}

async function records(res, retell) {
  const waiting = await sql()`
    select call_id from calls
      where record_encrypted is null
        and call_id is not null
        and started_at > now() - interval '7 days'
      order by started_at asc
      limit ${PER_RUN}
  `;

  const kept = [];
  const missed = [];
  for (const row of waiting) {
    try {
      const record = await retell.call.retrieve(row.call_id);
      await keepRecord(row.call_id, encrypt(JSON.stringify(record)));
      kept.push(row.call_id);
    } catch (error) {
      missed.push({ call: row.call_id, said: error.message });
    }
  }

  send(res, 200, { looked: waiting.length, kept: kept.length, missed });
}

export default handle('POST', async (req, res) => {
  requireSweeper(req);

  if (new URL(req.url, 'https://placeholder.invalid').searchParams.get('action') === 'trades') {
    return send(res, 200, await refreshTrades());
  }

  const apiKey = process.env.RETELL_SECRET_KEY;
  if (!apiKey) throw new HttpError(503, 'RETELL_SECRET_KEY is not set, so nothing can be asked.');

  const action = new URL(req.url, 'https://placeholder.invalid').searchParams.get('action');
  const retell = new Retell({ apiKey });

  if (action === 'records') {
    await ensureSchema();
    return records(res, retell);
  }

  if (action === 'script') {
    const agentId = process.env.RETELL_AGENT_ID;
    if (!agentId) throw new HttpError(503, 'RETELL_AGENT_ID is not set.');
    return send(res, 200, await agentScriptExport(retell, agentId));
  }

  throw new HttpError(400, 'The jobs here are: records, script, trades.');
});
