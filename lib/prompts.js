import { ensureSchema } from './db.js';
import { readChoice, writeChoice } from './settings.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';

export const PROMPTS = [
  'shared', 'sheet', 'rules', 'template', 'reply', 'recap', 'summary', 'chapter',
  'fields', 'gaps', 'quote', 'roadmap', 'questions', 'matches',
];
const MAX_PROMPT = 20000;

export async function promptText(name) {
  const stored = await readChoice(`prompt:${name}`);
  return stored ? decrypt(stored) : null;
}

export async function prompt(name, vars = {}) {
  const text = await promptText(name);
  if (!text) throw new HttpError(503, `The ${name} prompt isn't set. Write it on Prompts.`);
  return text.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(vars, key) ? String(vars[key]) : all));
}

export async function sheetPrompt() {
  const rules = (await prompt('rules')).split('\n').map((l) => l.trim()).filter(Boolean);
  return prompt('sheet', { rules: rules.map((rule) => `- ${rule}`).join('\n'), shared: await prompt('shared') });
}

export async function sheetAids() {
  const rules = await promptText('rules');
  return {
    rules: rules ? rules.split('\n').map((l) => l.trim()).filter(Boolean) : [],
    template: await promptText('template'),
  };
}

export async function listPrompts(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const prompts = [];
  for (const name of PROMPTS) prompts.push({ name, text: (await promptText(name)) || '' });
  send(res, 200, { prompts });
}

export async function savePrompt(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const name = String(body.name || '');
  if (!PROMPTS.includes(name)) throw new HttpError(400, `No prompt is called "${name.slice(0, 40)}".`);
  const text = String(body.text || '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new HttpError(400, 'An empty prompt can\'t be saved.');
  if (text.length > MAX_PROMPT) throw new HttpError(400, `That's over ${MAX_PROMPT} characters.`);
  await writeChoice(`prompt:${name}`, encrypt(text));
  send(res, 200, { ok: true, name });
}
