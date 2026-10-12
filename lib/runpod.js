import { HttpError } from './http.js';
import { runpodKey } from './draft.js';

const REST = 'https://rest.runpod.io/v1';
const IMAGE = 'ghcr.io/farahbrunache/one-percent-runpod';
const REGISTRY = 'https://ghcr.io';
const REPOSITORY = 'farahbrunache/one-percent-runpod';

export const GPU_CHOICES = {
  '16': { label: '16 GB', ids: ['NVIDIA RTX A4000', 'NVIDIA RTX 4000 Ada Generation', 'NVIDIA RTX A4500'], disk: 40 },
  '24': { label: '24 GB', ids: ['NVIDIA RTX A5000', 'NVIDIA L4', 'NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090'], disk: 60 },
  '48': { label: '48 GB', ids: ['NVIDIA RTX A6000', 'NVIDIA A40', 'NVIDIA L40S', 'NVIDIA L40'], disk: 100 },
  '80': { label: '80 GB', ids: ['NVIDIA A100 80GB PCIe', 'NVIDIA A100-SXM4-80GB', 'NVIDIA H100 PCIe'], disk: 140 },
};

export function isModelName(value) {
  return /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(String(value || ''));
}

export function tagFor(model) {
  return String(model).replace(/[^a-zA-Z0-9._-]/g, '-');
}

export function imageFor(model) {
  return `${IMAGE}:${tagFor(model)}`;
}

function needKey() {
  const key = runpodKey();
  if (!key) throw new HttpError(503, 'RUNPOD_API_KEY is not set, so RunPod cannot be reached.');
  return key;
}

async function rest(path, init = {}) {
  const response = await fetch(`${REST}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${needKey()}`, 'content-type': 'application/json', accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(502, `RunPod answered ${response.status} to ${init.method || 'GET'} ${path}: ${text.slice(0, 300) || 'no reason given'}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `RunPod answered ${path} with something that is not JSON.`);
  }
}

export async function listEndpoints() {
  const rows = await rest('/endpoints?includeTemplate=true');
  if (!Array.isArray(rows)) throw new HttpError(502, 'RunPod listed endpoints as something other than a list.');
  return rows.map((e) => {
    const image = e.template?.imageName || '';
    return {
      id: e.id,
      name: e.name || e.id,
      image,
      model: image.startsWith(`${IMAGE}:`) ? image.slice(IMAGE.length + 1) : null,
      gpus: e.gpuTypeIds || [],
      workersMax: e.workersMax ?? null,
    };
  });
}

export async function imageState(model) {
  const tag = tagFor(model);
  try {
    const grant = await fetch(`${REGISTRY}/token?scope=repository:${REPOSITORY}:pull`, { signal: AbortSignal.timeout(15_000) });
    if (!grant.ok) return 'private';
    const { token } = await grant.json();
    const head = await fetch(`${REGISTRY}/v2/${REPOSITORY}/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, '
          + 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (head.ok) return 'ready';
    if (head.status === 404) return 'missing';
    return 'private';
  } catch {
    return 'unknown';
  }
}

export async function createEndpoint({ slot, model, gpu }) {
  const choice = GPU_CHOICES[gpu];
  const stamp = Date.now().toString(36);
  const template = await rest('/templates', {
    method: 'POST',
    body: JSON.stringify({
      name: `one-percent-${tagFor(model)}-${stamp}`,
      imageName: imageFor(model),
      isServerless: true,
      containerDiskInGb: choice.disk,
      env: {},
    }),
  });
  if (!template?.id) throw new HttpError(502, 'RunPod made the template and named no id for it.');
  const endpoint = await rest('/endpoints', {
    method: 'POST',
    body: JSON.stringify({
      name: `one-percent-${slot}-${tagFor(model)}-${stamp}`,
      templateId: template.id,
      gpuTypeIds: choice.ids,
      gpuCount: 1,
      workersMin: 0,
      workersMax: 1,
      idleTimeout: 5,
      flashboot: true,
      executionTimeoutMs: 600_000,
    }),
  });
  if (!endpoint?.id) throw new HttpError(502, 'RunPod made the endpoint and named no id for it.');
  return endpoint.id;
}
