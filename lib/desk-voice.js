import { ensureSchema, sql } from './db.js';
import { keepRecord } from './calls.js';
import { encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, send } from './http.js';
import { agentScriptExport } from './voice.js';
import Retell from 'retell-sdk';

function query(req) {
  return new URL(req.url, 'https://placeholder.invalid').searchParams;
}

export async function callRecord(req, res) {
  requireAdmin(req);
  const callId = String(query(req).get('call') || '').trim();
  if (!callId) throw new HttpError(400, 'Which call? Pass the id the voice service gave it.');

  const apiKey = process.env.RETELL_SECRET_KEY;
  if (!apiKey) throw new HttpError(503, 'RETELL_SECRET_KEY is not set, so nothing can be asked.');

  await ensureSchema();

  const ours = await sql()`select 1 from calls where call_id = ${callId} limit 1`;
  if (!ours.length) {
    throw new HttpError(404, `No call here was started with the id ${callId}.`);
  }

  try {
    const record = await new Retell({ apiKey }).call.retrieve(callId);

    await keepRecord(callId, encrypt(JSON.stringify(record)));

    send(res, 200, record);
  } catch (error) {
    if (error instanceof Retell.APIError) {
      throw new HttpError(
        502,
        `The voice service would not hand over call ${callId} (${error.status}): ` +
          JSON.stringify(error.error ?? error.message).slice(0, 400),
      );
    }
    throw new HttpError(502, `Could not reach the voice service: ${error.message}`);
  }
}

export async function agentScript(req, res) {
  requireAdmin(req);

  const apiKey = process.env.RETELL_SECRET_KEY;
  const agentId = process.env.RETELL_AGENT_ID;
  if (!apiKey || !agentId) {
    throw new HttpError(503, 'RETELL_SECRET_KEY or RETELL_AGENT_ID is not set, so nothing can be asked.');
  }

  try {
    send(res, 200, await agentScriptExport(new Retell({ apiKey }), agentId));
  } catch (error) {
    if (error instanceof Retell.APIError) {
      throw new HttpError(
        502,
        `The voice service would not hand over the agent (${error.status}): ` +
          JSON.stringify(error.error ?? error.message).slice(0, 400),
      );
    }
    throw new HttpError(502, `Could not reach the voice service: ${error.message}`);
  }
}
