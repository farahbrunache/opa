import { HttpError } from './http.js';
import { readChoice } from './settings.js';

export const SLOTS = ['A', 'B', 'C'];

export const SLOT_TIERS = { A: 'Small', B: 'Mid-size', C: 'Large' };

const FALL_BACK = { A: ['A', 'B', 'C'], B: ['B', 'C', 'A'], C: ['C', 'B', 'A'] };

export const FOLLOW_BUDGET_MS = 10 * 60_000;
export const POLL_EVERY_MS = 1_500;

export const DRAFTS_PER_ORDER = 10;
export const DRAFT_WINDOW_SECONDS = 24 * 60 * 60;

export function runpodKey() {
  return String(process.env.RUNPOD_API_KEY || '').trim();
}

export function endpointUrl(endpointId) {
  return `https://api.runpod.ai/v2/${endpointId}`;
}

export async function settingsFor(slot) {
  const endpointId = (await readChoice(`slot:endpoint:${slot}`)) || '';
  const model = (await readChoice(`slot:model:${slot}`)) || '';
  return {
    slot,
    endpointId,
    name: model || `Slot ${slot}`,
    url: endpointId ? endpointUrl(endpointId) : '',
    key: runpodKey(),
  };
}

export async function configuredSlots() {
  const out = [];
  for (const slot of SLOTS) {
    const model = await settingsFor(slot);
    if (model.url && model.key) out.push(slot);
  }
  return out;
}

export async function models() {
  const out = [];
  for (const slot of await configuredSlots()) {
    const model = await settingsFor(slot);
    out.push({ slot, name: model.name });
  }
  return out;
}

export async function resolve(chosen) {
  const available = await configuredSlots();
  if (!available.length) {
    throw new HttpError(
      503,
      runpodKey()
        ? 'No drafting model is set up. Pick a RunPod endpoint for a slot on the AI check page.'
        : 'RUNPOD_API_KEY is not set, so no drafting model can be reached.',
    );
  }
  const slot = (FALL_BACK[chosen] || SLOTS).find((s) => available.includes(s));
  return { ...(await settingsFor(slot)), fellBack: slot !== chosen && Boolean(chosen) };
}

async function ask(model, path, init) {
  const response = await fetch(`${model.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${model.key}`, 'content-type': 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      502,
      `${model.name} answered ${response.status} at ${model.url}${path}. If that is a refusal ` +
        `rather than an outage, RUNPOD_API_KEY may not cover endpoint ${model.endpointId}. ` +
        `It said: ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(502, `${model.name} answered something that is not JSON: ${error.message}`);
  }
}

export async function draft(messages, chosen) {
  const model = await resolve(chosen);
  const submitted = await ask(model, '/run', {
    method: 'POST',
    body: JSON.stringify({ input: { messages, options: { temperature: 0.4 } } }),
  });
  if (!submitted.id) {
    throw new HttpError(502, `${model.name} accepted the job but named no job to watch.`);
  }
  return { job: submitted.id, model };
}

export async function jobState(slot, job) {
  const model = await settingsFor(slot);
  if (!model.url || !model.key) {
    throw new HttpError(503, `Slot ${slot} has no endpoint or RUNPOD_API_KEY is not set, so job ${job} `
      + 'can\'t be checked.');
  }
  const state = await ask(model, `/status/${job}`, { method: 'GET' });
  const status = String(state.status || '').toUpperCase();

  if (status === 'COMPLETED') {
    const out = state.output || {};
    if (out.error) return { status, failure: `${model.name} refused job ${job}: ${out.error}` };
    const content = String(out.content || '').trim();
    if (!content) return { status, failure: `${model.name} finished job ${job} with nothing in it.` };
    return {
      status,
      answer: {
        content,
        model: out.model || model.name,
        slot,
        job,
        promptTokens: Number(out.prompt_tokens) || null,
        completionTokens: Number(out.completion_tokens) || null,
      },
    };
  }

  if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
    const why = state.error || state.output?.error;
    return {
      status,
      failure: `${model.name} ended job ${job} as ${status.toLowerCase()}`
        + `${why ? `. RunPod said: ${String(typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 400)}` : ', with no reason given'}`
        + '. Press again to start a new job.',
    };
  }

  return { status };
}
