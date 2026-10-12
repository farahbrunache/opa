import { readSession } from './crypto.js';
import { HttpError, readCookie } from './http.js';

export const SESSION_COOKIE = 'op_session';

export const NAME_COOKIE = 'op_name';

const DISCOVERY_TTL_MS = 60 * 60_000;

let cached = { issuer: null, at: 0, doc: null };

function required(name, what) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. ${what}`);
  return value;
}

export function publishableKey() {
  return required(
    'AUTH_PUBLISHABLE_KEY',
    'It is the Skills Economy publishable key, the one starting pk_live_, and it is public.',
  );
}

export function issuer(key = publishableKey()) {
  const value = String(key);
  if (!value.startsWith('pk_live_') && !value.startsWith('pk_test_')) {
    throw new Error(
      'AUTH_PUBLISHABLE_KEY does not look like a publishable key. It has to start pk_live_ ' +
        'or pk_test_.',
    );
  }
  const host = Buffer.from(value.slice(8), 'base64').toString('utf8').replace(/\$+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
    throw new Error(
      `AUTH_PUBLISHABLE_KEY decodes to "${host}", which is not a host name. The key is ` +
        'probably cut short, or it is from a different service.',
    );
  }
  return `https://${host}`;
}

export async function endpoints() {
  const from = issuer();
  if (cached.issuer === from && cached.doc && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.doc;
  }
  const url = `${from}/.well-known/openid-configuration`;
  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new Error(`Could not reach ${url} to find the sign-in addresses: ${cause.message}`);
  }
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}. The sign-in addresses are unknown.`);
  }
  const body = await response.json();
  for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) {
    if (!body[field]) throw new Error(`${url} did not say where ${field} is.`);
  }
  cached = { issuer: from, at: Date.now(), doc: body };
  return body;
}

export function clientId() {
  return required(
    'AUTH_CLIENT_ID',
    'It is the client id of the One Percent application registered in the Skills Economy ' +
      'Clerk dashboard.',
  );
}

export function redirectUri(req) {
  const host = req.headers.host;
  if (!host) throw new Error('The request carries no host, so the return address is unknown.');
  return `https://${host}/auth/callback`;
}

export function clientSecret() {
  return process.env.AUTH_CLIENT_SECRET || '';
}

export function signInUrl({ state, codeChallenge, returnTo }, discovery) {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', returnTo);
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', state);
  if (!clientSecret()) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

export async function exchangeCode({ code, verifier, returnTo }, discovery) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: returnTo,
    client_id: clientId(),
  });
  const secret = clientSecret();
  if (secret) form.set('client_secret', secret);
  else form.set('code_verifier', verifier);

  async function post(useBasic) {
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const sent = new URLSearchParams(form);
    if (useBasic) {
      sent.delete('client_secret');
      headers.authorization =
        'Basic ' + Buffer.from(`${clientId()}:${secret}`).toString('base64');
    }
    const answer = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body: sent.toString(),
    });
    return { answer, payload: await answer.json().catch(() => ({})) };
  }

  let { answer: response, payload: body } = await post(false);

  if (!response.ok && secret && body.error === 'invalid_client') {
    ({ answer: response, payload: body } = await post(true));
  }

  if (!response.ok) {
    const asked = secret
      ? 'It asked as a confidential client, because AUTH_CLIENT_SECRET is set, and tried ' +
        'the secret both in the body and in the Authorization header. If the application ' +
        'is marked Public, clear that setting: a public client proves itself with PKCE and ' +
        'is refused for sending a secret at all. If it is not Public, then AUTH_CLIENT_ID ' +
        'or AUTH_CLIENT_SECRET does not match what the application holds.'
      : 'It asked as a public client with PKCE, because AUTH_CLIENT_SECRET is not set. If ' +
        'the application is not marked Public, that setting is what is missing.';
    throw new Error(
      `Skills Economy refused the sign-in: ${body.error_description || body.error || response.status}. ${asked}`,
    );
  }
  if (!body.access_token) throw new Error('Skills Economy returned no token for that sign-in.');
  return body.access_token;
}

export async function whoSignedIn(accessToken, discovery) {
  const response = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Skills Economy answered ${response.status} when asked who signed in.`);
  }
  const body = await response.json();
  const id = body.sub || body.user_id;
  if (!id) throw new Error('Skills Economy did not say which account signed in.');
  return { id: String(id), name: nameFrom(body) };
}

export function nameFrom(body) {
  const joined = [body.given_name, body.family_name].filter(Boolean).join(' ');
  const name = String(body.name || joined || body.preferred_username || '').trim();
  return name ? name.slice(0, 120) : null;
}

export function isAdmin(id) {
  const allowed = String(process.env.ADMIN_ACCOUNT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(String(id));
}

export function accountOrNull(req) {
  return readSession(readCookie(req, SESSION_COOKIE));
}

export function requireAccount(req) {
  const id = accountOrNull(req);
  if (!id) throw new HttpError(401, 'Sign in with Skills Economy first.');
  return id;
}

export function requireAdmin(req) {
  const id = readSession(readCookie(req, SESSION_COOKIE));
  if (!id) throw new HttpError(401, 'Sign in with Skills Economy first.');
  if (!isAdmin(id)) {
    throw new HttpError(
      403,
      `Signed in as ${id}, which is not an admin here. Put that id in the ` +
        'ADMIN_ACCOUNT_IDS setting and deploy again — a changed setting does not reach ' +
        'the running code until there is a new deployment.',
    );
  }
  return id;
}
