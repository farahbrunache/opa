import { HttpError } from './http.js';

const SLOT_SETTINGS = {
  A: { name: 'DRAFT_MODEL_A_NAME', url: 'DRAFT_MODEL_A_URL', key: 'DRAFT_MODEL_A_KEY' },
  B: { name: 'DRAFT_MODEL_B_NAME', url: 'DRAFT_MODEL_B_URL', key: 'DRAFT_MODEL_B_KEY' },
  C: { name: 'DRAFT_MODEL_C_NAME', url: 'DRAFT_MODEL_C_URL', key: 'DRAFT_MODEL_C_KEY' },
};

export const SLOTS = Object.keys(SLOT_SETTINGS);

const PRICE_SETTINGS = {
  A: ['DRAFT_MODEL_A_IN_PER_MILLION', 'DRAFT_MODEL_A_OUT_PER_MILLION'],
  B: ['DRAFT_MODEL_B_IN_PER_MILLION', 'DRAFT_MODEL_B_OUT_PER_MILLION'],
  C: ['DRAFT_MODEL_C_IN_PER_MILLION', 'DRAFT_MODEL_C_OUT_PER_MILLION'],
};

function perMillion(name) {
  const raw = String(process.env[name] || '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : null;
}

export function tokenPrices(slot) {
  const names = PRICE_SETTINGS[slot];
  if (!names) return null;
  const inPerMillion = perMillion(names[0]);
  const outPerMillion = perMillion(names[1]);
  if (inPerMillion === null || outPerMillion === null) return null;
  return { inPerMillion, outPerMillion };
}

export function tokenCost(slot, promptTokens, completionTokens) {
  const prices = tokenPrices(slot);
  if (!prices) return null;
  const inTokens = Number(promptTokens);
  const outTokens = Number(completionTokens);
  if (promptTokens === null || promptTokens === undefined || completionTokens === null
    || completionTokens === undefined || !Number.isFinite(inTokens) || !Number.isFinite(outTokens)) return null;
  return (inTokens * prices.inPerMillion + outTokens * prices.outPerMillion) / 1_000_000;
}

export const FOLLOW_BUDGET_MS = 10 * 60_000;
export const POLL_EVERY_MS = 1_500;

export const DRAFTS_PER_ORDER = 10;
export const DRAFT_WINDOW_SECONDS = 24 * 60 * 60;

export function settingsFor(slot) {
  const names = SLOT_SETTINGS[slot];
  return {
    slot,
    name: process.env[names.name] || `Model ${slot}`,
    url: (process.env[names.url] || '').replace(/\/+$/, ''),
    key: process.env[names.key] || '',
  };
}

function describe(slot) {
  return { slot, name: settingsFor(slot).name };
}

export function configuredSlots() {
  return SLOTS.filter((slot) => {
    const model = settingsFor(slot);
    return model.url.length > 0 && model.key.length > 0;
  });
}

export function models() {
  return configuredSlots().map(describe);
}

export function resolve(chosen) {
  const available = configuredSlots();
  if (!available.length) {
    throw new HttpError(
      503,
      'No drafting model is configured. A slot needs its address and its key set in the ' +
        'secrets store. The slots are: ' + SLOTS.join(', ') + '.',
    );
  }
  const slot = available.includes(chosen) ? chosen : available[0];
  return { ...settingsFor(slot), fellBack: slot !== chosen && Boolean(chosen) };
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
        `rather than an outage, the key for slot ${model.slot} may not cover that endpoint. ` +
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
  const model = resolve(chosen);
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
  const model = settingsFor(slot);
  if (!model.url || !model.key) {
    throw new HttpError(503, `Slot ${slot} has no address or no key set any more, so job ${job} `
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
