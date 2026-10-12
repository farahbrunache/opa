import Retell, { verify } from 'retell-sdk';

import { ensureSchema, sql } from '../lib/db.js';
import { keepRecord } from '../lib/calls.js';
import { encrypt } from '../lib/crypto.js';
import { HttpError, handle, readRaw, send } from '../lib/http.js';

async function checkSignature(req, body) {
  const apiKey = process.env.RETELL_SECRET_KEY;
  if (!apiKey) {
    throw new HttpError(
      503,
      'RETELL_SECRET_KEY is not set, so a delivery cannot be checked against anything. It is ' +
        'the same API key the site starts calls with, and in Retell it is the one carrying the ' +
        'webhook badge — another key will not verify a signature.',
    );
  }

  const signature = req.headers['x-retell-signature'];
  if (!signature) throw new HttpError(401, 'That delivery carries no signature.');

  let ok = false;
  try {
    ok = await verify(body, apiKey, String(signature));
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'That signature does not check out.');
}

async function keepEverything(callId) {
  const apiKey = process.env.RETELL_SECRET_KEY;
  if (!apiKey || !callId) return;
  try {
    const record = await new Retell({ apiKey }).call.retrieve(callId);
    await keepRecord(callId, encrypt(JSON.stringify(record)));
  } catch (error) {
    console.error(`[one-percent] could not keep the record for ${callId}:`, error.message);
  }
}

function readCall(payload) {
  const call = payload.call || payload.data || payload;
  const analysis = call.call_analysis || call.analysis || null;

  const startMs = Number(call.start_timestamp) || 0;
  const endMs = Number(call.end_timestamp) || 0;
  const seconds =
    Number(call.duration_ms) > 0
      ? Math.round(Number(call.duration_ms) / 1000)
      : endMs > startMs
        ? Math.round((endMs - startMs) / 1000)
        : null;

  return {
    id: call.call_id || call.id || null,
    transcript: typeof call.transcript === 'string' ? call.transcript : null,
    analysis,
    endedAt: endMs ? new Date(endMs).toISOString() : null,
    seconds,
  };
}

export default handle('POST', async (req, res) => {
  const raw = await readRaw(req);
  await checkSignature(req, raw);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, `That delivery was not readable as JSON: ${error.message}`);
  }

  const call = readCall(payload);
  if (!call.id) throw new HttpError(400, 'That delivery names no call.');
  await ensureSchema();

  const transcript = call.transcript ? encrypt(call.transcript) : null;
  const summary = call.analysis ? encrypt(JSON.stringify(call.analysis)) : null;

  await keepEverything(call.id);

  const rows = await sql()`
    update calls set
      transcript_encrypted = coalesce(${transcript}, transcript_encrypted),
      summary_encrypted = coalesce(${summary}, summary_encrypted),
      ended_at = coalesce(${call.endedAt}, ended_at),
      seconds = coalesce(${call.seconds}, seconds)
    where call_id = ${call.id}
    returning id
  `;
  if (!rows.length) {
    throw new HttpError(
      404,
      `No session here is expecting call ${call.id}. Either it was never started from this ` +
        'site, or it was started against an order that no longer exists.',
    );
  }

  send(res, 200, { ok: true });
});
