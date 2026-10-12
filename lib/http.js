import { randomBytes } from 'node:crypto';

export function query(req) {
  return new URL(req.url, 'https://placeholder.invalid').searchParams;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'The request body was not readable as JSON.');
  }
}

export async function readRaw(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function requestRef(req) {
  if (!req.ref) req.ref = randomBytes(4).toString('hex');
  return req.ref;
}

export function actionOf(req) {
  const action = query(req).get('action');
  return action && /^[a-z0-9-]{1,40}$/.test(action) ? action : null;
}

export function failure(req, status, message) {
  return {
    error: message,
    status,
    action: actionOf(req),
    ref: requestRef(req),
    at: new Date().toISOString(),
  };
}

export function handle(method, work) {
  return async function (req, res) {
    try {
      const allowed = Array.isArray(method) ? method : [method];
      if (!allowed.includes(req.method)) {
        res.setHeader('allow', allowed.join(', '));
        return send(res, 405, failure(req, 405, `This endpoint accepts ${allowed.join(' or ')}, and this was a ${req.method}.`));
      }
      await work(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : `The request could not be completed: ${error.message}`;
      if (status >= 500) console.error(`[one-percent] ref=${requestRef(req)} action=${actionOf(req) || '-'}`, error);
      if (!res.writableEnded) send(res, status, failure(req, status, message));
    }
  };
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setCookie(res, name, value, maxAgeSeconds, sameSite = 'Strict') {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  const already = res.getHeader ? res.getHeader('set-cookie') : null;
  const all = already ? (Array.isArray(already) ? [...already] : [already]) : [];
  all.push(bits.join('; '));
  res.setHeader('set-cookie', all);
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.setHeader('cache-control', 'no-store');
  res.end('');
}
