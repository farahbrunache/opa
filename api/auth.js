import {
  NAME_COOKIE,
  SESSION_COOKIE,
  endpoints,
  exchangeCode,
  redirectUri,
  signInUrl,
  whoSignedIn,
} from '../lib/auth.js';
import { callerKey, encrypt, randomToken, sha256Base64Url, signSession } from '../lib/crypto.js';
import { ensureSchema, sql } from '../lib/db.js';
import { underLimit } from '../lib/settings.js';
import { HttpError, handle, readCookie, redirect, requestRef, send, setCookie } from '../lib/http.js';

const HANDSHAKE_COOKIE = 'op_signin';
const HANDSHAKE_MINUTES = 10;

const ACROSS_THE_RETURN = 'Lax';

const A_PATH_HERE = /^\/[A-Za-z0-9/_\-.]*(\?[A-Za-z0-9/_\-.=&%]*)?$/;

function landing(req) {
  const asked = new URL(req.url, 'https://placeholder.invalid').searchParams.get('to') || '/';
  return asked.startsWith('//') || !A_PATH_HERE.test(asked) ? '/' : asked;
}

function signInFailed(req, res, message) {
  redirect(res, `/?problem=${encodeURIComponent(message)}&ref=${requestRef(req)}`);
}

async function start(req, res) {
  const discovery = await endpoints();
  const state = randomToken(16);
  const verifier = randomToken(32);
  setCookie(
    res,
    HANDSHAKE_COOKIE,
    `${state}.${verifier}.${Buffer.from(landing(req), 'utf8').toString('base64url')}`,
    HANDSHAKE_MINUTES * 60,
    ACROSS_THE_RETURN,
  );
  redirect(
    res,
    signInUrl(
      { state, codeChallenge: sha256Base64Url(verifier), returnTo: redirectUri(req) },
      discovery,
    ),
  );
}

async function callback(req, res) {
  const query = new URL(req.url, 'https://placeholder.invalid').searchParams;
  const handshake = String(readCookie(req, HANDSHAKE_COOKIE) || '').split('.');
  setCookie(res, HANDSHAKE_COOKIE, '', 0, ACROSS_THE_RETURN);

  const failed = (message) => signInFailed(req, res, message);

  if (query.get('error')) {
    return failed(
      `Skills Economy did not sign you in: ${query.get('error_description') || query.get('error')}.`,
    );
  }
  if (handshake.length !== 3) {
    return failed('That sign-in took too long, or started somewhere else. Try again.');
  }
  const [state, verifier, encodedLanding] = handshake;
  if (!state || query.get('state') !== state) {
    return failed('That sign-in did not match the one this browser started. Try again.');
  }
  const code = query.get('code');
  if (!code) return failed('Skills Economy sent no sign-in code back.');

  try {
    const discovery = await endpoints();
    const token = await exchangeCode({ code, verifier, returnTo: redirectUri(req) }, discovery);
    const { id, name } = await whoSignedIn(token, discovery);
    setCookie(res, SESSION_COOKIE, signSession(id), 12 * 3600, ACROSS_THE_RETURN);
    setCookie(res, NAME_COOKIE, name ? encrypt(name) : '', name ? 12 * 3600 : 0, ACROSS_THE_RETURN);
    if (name) {
      try {
        await ensureSchema();
        await sql()`update cases set name_encrypted = ${encrypt(name)} where account_id = ${id}`;
      } catch (error) {
        console.error('[one-percent] the name from that sign-in was not saved:', error.message);
      }
    }
  } catch (error) {
    return failed(error.message);
  }
  redirect(res, Buffer.from(encodedLanding, 'base64url').toString('utf8') || '/');
}

export default handle(['GET', 'POST'], async (req, res) => {
  const action = new URL(req.url, 'https://placeholder.invalid').searchParams.get('action');

  if (req.method === 'GET' && action === 'start') {
    try {
      await ensureSchema();
      if (!(await underLimit('signin', callerKey(req), 20, 900))) {
        return signInFailed(req, res, 'Too many sign-in attempts from this connection. Wait fifteen minutes, then try again.');
      }
      return await start(req, res);
    } catch (error) {
      console.error(`[one-percent] ref=${requestRef(req)} sign-in didn't start`, error);
      return signInFailed(req, res, `Sign-in couldn't start: ${error.message}`);
    }
  }
  if (req.method === 'GET' && action === 'callback') return callback(req, res);
  if (req.method === 'POST' && action === 'signout') {
    setCookie(res, SESSION_COOKIE, '', 0, ACROSS_THE_RETURN);
    setCookie(res, NAME_COOKIE, '', 0, ACROSS_THE_RETURN);
    return send(res, 200, { ok: true });
  }

  throw new HttpError(400, 'Use action=start, action=callback or action=signout.');
});
