import { ensureSchema, sql } from './db.js';
import { decrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, query, send } from './http.js';
import { caseOf, orderId } from './desk-events.js';

const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function directoryReadConfigured() {
  return Boolean(process.env.DIRECTORY_SERVICE_URL && process.env.DIRECTORY_SERVICE_TOKEN);
}

export function profileIdFrom(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  let candidate = text;
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      url = null;
    }
    const match = url && url.pathname.match(/\/directory\/profiles?\/([^/]+)\/?$/);
    candidate = match ? decodeURIComponent(match[1]) : '';
  }
  if (!PROFILE_ID.test(candidate)) {
    throw new HttpError(
      400,
      'That isn\'t a Directory profile link. Open the person in the Skills Economy Directory and '
        + 'copy the address, which ends in /apps/directory/profile/ and their id.',
    );
  }
  return candidate;
}

export async function readProfile(profileId) {
  return fetchProfile(`profiles/${encodeURIComponent(profileId)}`,
    'The Directory has no profile with this id. It may have been taken down, and there are no '
      + 'details to show.');
}

export async function readProfileByAccount(accountId) {
  return fetchProfile(`accounts/${encodeURIComponent(accountId)}/profile`,
    "Their Skills Economy account doesn't have a claimed Directory profile yet.");
}

async function fetchProfile(path, notFound) {
  if (!directoryReadConfigured()) {
    throw new HttpError(
      503,
      'Reading the Directory is switched off. It needs DIRECTORY_SERVICE_URL and '
        + 'DIRECTORY_SERVICE_TOKEN set in this site\'s settings.',
    );
  }
  const base = process.env.DIRECTORY_SERVICE_URL.replace(/\/+$/, '');
  let answer;
  try {
    answer = await fetch(`${base}/api/directory/service/${path}`, {
      headers: { authorization: `Bearer ${process.env.DIRECTORY_SERVICE_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, 'Skills Economy couldn\'t be reached, or didn\'t answer within 8 seconds. The contact is saved; '
      + 'open the record again later to see their profile.');
  }
  if (answer.status === 404) {
    throw new HttpError(404, notFound);
  }
  if (answer.status === 401) {
    throw new HttpError(502, 'Skills Economy refused this site\'s credential. Check that '
      + 'DIRECTORY_SERVICE_TOKEN here matches an entry in DIRECTORY_SERVICE_TOKENS there.');
  }
  if (!answer.ok) {
    throw new HttpError(502, `Skills Economy answered ${answer.status}, so the profile couldn't be `
      + 'read. Open the record again later.');
  }
  const body = await answer.json().catch(() => null);
  if (!body || typeof body.profile !== 'object' || !body.profile) {
    throw new HttpError(502, 'Skills Economy answered with something that isn\'t a profile.');
  }
  return body.profile;
}

export async function directoryProfile(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const params = query(req);
  const id = orderId(params.get('id'));
  const caseId = await caseOf(id);
  if (caseId === null) throw new HttpError(404, 'This order has no case, so it has no contacts.');
  const contactId = orderId(params.get('contact'));

  const rows = await sql()`
    select directory_profile_encrypted from contacts where id = ${contactId} and case_id = ${caseId}
  `;
  if (!rows.length) throw new HttpError(404, 'No contact with that number for this person.');
  if (!rows[0].directory_profile_encrypted) {
    throw new HttpError(404, 'This contact isn\'t linked to a Directory profile.');
  }
  const profile = await readProfile(decrypt(rows[0].directory_profile_encrypted));
  send(res, 200, { profile });
}

export const DIRECTORY_PAGES_PER_PRESS = 3;
export const DIRECTORY_PAGE_SIZE = 100;

export async function listProfiles({ pages = DIRECTORY_PAGES_PER_PRESS, wait = 1100 } = {}) {
  if (!directoryReadConfigured()) return { profiles: [], complete: false, said: 'Directory not connected' };
  const base = process.env.DIRECTORY_SERVICE_URL.replace(/\/+$/, '');
  const profiles = [];
  let cursor = null;
  for (let page = 0; page < pages; page += 1) {
    if (page > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
    const url = `${base}/api/directory/service/profiles?limit=${DIRECTORY_PAGE_SIZE}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    let answer;
    try {
      answer = await fetch(url, {
        headers: { authorization: `Bearer ${process.env.DIRECTORY_SERVICE_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return { profiles, complete: false, said: 'Directory list not available' };
    }
    if (!answer.ok) {
      return {
        profiles,
        complete: false,
        said: answer.status === 429 ? 'Directory list limit reached, try later' : 'Directory list not available',
      };
    }
    const body = await answer.json().catch(() => null);
    if (!body || !Array.isArray(body.profiles)) {
      return { profiles, complete: false, said: 'Directory list not available' };
    }
    profiles.push(...body.profiles.filter((p) => p && PROFILE_ID.test(String(p.id || ''))));
    cursor = body.nextCursor || null;
    if (!cursor) return { profiles, complete: true, said: null };
  }
  return { profiles, complete: false, said: `First ${profiles.length} Directory profiles read` };
}
