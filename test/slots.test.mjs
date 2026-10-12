import { Readable } from 'node:stream';
import { check, db, failureCount, useSlot } from './harness.mjs';

process.env.ADMIN_ACCOUNT_IDS = 'admin-1';
process.env.RUNPOD_API_KEY = 'a-test-key';
const { signSession } = await import('../lib/crypto.js');
const desk = (await import('../api/desk.js')).default;
const drafts = await import('../lib/desk-drafts.js');
const runpod = await import('../lib/runpod.js');

await db.ensureSchema();

const cookie = `op_session=${signSession('admin-1')}`;
async function ask(method, action, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  const out = { statusCode: 200, body: null, writableEnded: false, setHeader() {}, getHeader() {},
    end(text) { this.writableEnded = true; this.body = text; } };
  try {
    await desk({ method, url: `/api/desk?action=${action}`, headers: { cookie, 'content-type': 'application/json' },
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) }, out);
  } catch (error) {
    return { status: error.status || 500, out: { error: error.message } };
  }
  return { status: out.statusCode, out: out.body ? JSON.parse(out.body) : null };
}

const sent = [];
const registry = { 'llama3.2': 200, 'qwen2.5-14b': 200, 'qwen2.5-32b': 404 };
let registryOpen = true;
const endpoints = [
  { id: 'ep-small', name: 'one-percent-A-llama3.2', template: { imageName: 'ghcr.io/farahbrunache/one-percent-runpod:llama3.2' }, gpuTypeIds: ['NVIDIA RTX A4000'], workersMax: 1 },
  { id: 'ep-other', name: 'someone-else', template: { imageName: 'docker.io/other:latest' }, gpuTypeIds: [], workersMax: 2 },
];
globalThis.fetch = async (address, init = {}) => {
  const url = String(address);
  sent.push({ url, method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
  if (url.startsWith('https://ghcr.io/token')) return registryOpen ? reply(200, { token: 'anon' }) : reply(401, {});
  if (url.startsWith('https://ghcr.io/v2/')) return reply(registry[url.split('/manifests/')[1]] || 404, {});
  if (url === 'https://rest.runpod.io/v1/endpoints?includeTemplate=true') return reply(200, endpoints);
  if (url === 'https://rest.runpod.io/v1/templates') return reply(200, { id: 'tpl-new' });
  if (url === 'https://rest.runpod.io/v1/endpoints') {
    const made = { id: 'ep-new', name: sent.at(-1).body.name, template: { imageName: 'ghcr.io/farahbrunache/one-percent-runpod:qwen2.5-14b' } };
    endpoints.push(made);
    return reply(200, made);
  }
  if (url.endsWith('/health')) return reply(200, { workers: { ready: 0 }, jobs: {} });
  return reply(404, {});
};

console.log('');
console.log('buttons by how hard the work is');
const tiers = Object.fromEntries((await drafts.familiesNow()).map((b) => [b.family, b.chosen]));
check('the next steps and the roadmap start on the large model', tiers.sheet === 'C' && tiers.roadmap === 'C', tiers);
check('replies, gaps, questions and matches on the mid-size one',
  ['reply', 'gaps', 'questions', 'matches'].every((f) => tiers[f] === 'B'), tiers);
check('summaries, call lines and catch-ups on the small one',
  ['summary', 'fields', 'recap'].every((f) => tiers[f] === 'A'), tiers);
check('with nothing set up, nothing is in use', (await drafts.familiesNow()).every((b) => b.inUse === null));

console.log('picking an endpoint for a slot');
let page = (await ask('GET', 'ai-check')).out;
check('the page lists this account\'s RunPod endpoints', page.endpoints.list.length === 2 && page.keySet, page.endpoints);
check('naming the model from the worker image', page.endpoints.list[0].model === 'llama3.2' && page.endpoints.list[1].model === null);
check('the key goes as a bearer', sent.find((s) => s.url.includes('rest.runpod.io')).auth === 'Bearer a-test-key');
check('an endpoint that is not on the account is refused',
  (await ask('POST', 'slot-set', { slot: 'A', endpointId: 'ep-nope' })).status === 404);
check('a slot that does not exist is refused', (await ask('POST', 'slot-set', { slot: 'D', endpointId: 'ep-small' })).status === 400);
const picked = await ask('POST', 'slot-set', { slot: 'A', endpointId: 'ep-small' });
check('slot A takes the small endpoint', picked.status === 200 && picked.out.model === 'llama3.2', picked.out);
page = (await ask('GET', 'ai-check')).out;
check('and shows it, set up, with its model', page.slots[0].set && page.slots[0].name === 'llama3.2' && page.slots[0].endpointId === 'ep-small', page.slots[0]);
check('every button now runs on it, the others not being set up',
  (await drafts.familiesNow()).every((b) => b.inUse === 'A'));

console.log('adding a model');
check('a name Ollama would not take is refused', (await ask('POST', 'model-add', { slot: 'B', gpu: '24', model: 'not a model!' })).status === 400);
check('a GPU size it does not offer is refused', (await ask('POST', 'model-add', { slot: 'B', gpu: '12', model: 'qwen2.5:14b' })).status === 400);
const unbuilt = await ask('POST', 'model-add', { slot: 'C', gpu: '48', model: 'qwen2.5:32b' });
check('with no image built it says which workflow to run, and makes nothing',
  unbuilt.status === 409 && /Build the RunPod worker image/.test(unbuilt.out.error)
  && /one-percent-runpod:qwen2\.5-32b/.test(unbuilt.out.error) && !sent.some((s) => s.url.endsWith('/templates')), unbuilt.out);
registryOpen = false;
check('with the package private it says to make it public',
  /public/.test((await ask('POST', 'model-add', { slot: 'B', gpu: '24', model: 'qwen2.5:14b' })).out.error));
registryOpen = true;
const added = await ask('POST', 'model-add', { slot: 'B', gpu: '24', model: 'qwen2.5:14b' });
check('a built image becomes an endpoint on slot B', added.status === 201 && added.out.endpointId === 'ep-new' && added.out.slot === 'B', added.out);
const template = sent.find((s) => s.url.endsWith('/templates'));
check('from a serverless template on the worker image',
  template.body.imageName === 'ghcr.io/farahbrunache/one-percent-runpod:qwen2.5-14b' && template.body.isServerless === true
  && template.body.containerDiskInGb === 60, template.body);
const endpoint = sent.find((s) => s.url === 'https://rest.runpod.io/v1/endpoints' && s.method === 'POST');
check('on 24 GB cards, scaling to nothing when idle',
  endpoint.body.templateId === 'tpl-new' && endpoint.body.gpuTypeIds.includes('NVIDIA RTX A5000')
  && endpoint.body.workersMin === 0 && endpoint.body.workersMax === 1, endpoint.body);
const now = await drafts.familiesNow();
check('the mid-size buttons move onto it on their own',
  now.find((b) => b.family === 'reply').inUse === 'B' && now.find((b) => b.family === 'summary').inUse === 'A');
check('and the large ones fall to it until C is set up', now.find((b) => b.family === 'sheet').inUse === 'B');

console.log('clearing a slot');
check('an empty endpoint clears it', (await ask('POST', 'slot-set', { slot: 'B', endpointId: '' })).status === 200
  && (await drafts.familiesNow()).find((b) => b.family === 'reply').inUse === 'A');

console.log('without the key');
delete process.env.RUNPOD_API_KEY;
page = (await ask('GET', 'ai-check')).out;
check('the page says so and lists nothing', page.keySet === false && page.endpoints.list.length === 0 && !page.slots.some((s) => s.set));
check('and adding is refused', (await ask('POST', 'model-add', { slot: 'B', gpu: '24', model: 'qwen2.5:14b' })).status === 503);
await useSlot('A', '', '');

check('the image tag follows the build workflow', runpod.tagFor('qwen2.5:14b') === 'qwen2.5-14b');

const failures = failureCount();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
