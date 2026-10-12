import { ensureSchema, sql } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, query, readJson, send } from './http.js';
import { caseOf, orderId, record } from './desk-events.js';
import { profileIdFrom, readProfile, readProfileByAccount } from './desk-directory.js';

export async function linkOwnProfile(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const caseId = await caseOf(id);
  if (caseId === null) {
    throw new HttpError(409, "Nobody has signed in on this order yet, so there's no person to link a profile to.");
  }
  const profileId = profileIdFrom(body.link);
  await sql()`update cases set directory_profile_encrypted = ${profileId ? encrypt(profileId) : null}
               where id = ${caseId}`;
  await record(id, 'own-profile', profileId ? 'Linked their Directory profile.' : 'Unlinked their Directory profile.');
  send(res, 200, { linked: Boolean(profileId) });
}

export async function readOwnProfile(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const id = orderId(query(req).get('id'));
  const caseId = await caseOf(id);
  const rows = caseId === null ? [] : await sql()`
    select account_id, directory_profile_encrypted from cases where id = ${caseId}
  `;
  if (!rows.length) throw new HttpError(404, "Nobody has signed in on this order yet.");

  let profile;
  if (rows[0].directory_profile_encrypted) {
    profile = await readProfile(decrypt(rows[0].directory_profile_encrypted));
  } else {
    if (String(rows[0].account_id).startsWith('demo-')) {
      throw new HttpError(404, "A demo record's account isn't a Skills Economy account, so there's no profile to find.");
    }
    profile = await readProfileByAccount(rows[0].account_id);
    await sql()`update cases set directory_profile_encrypted = ${encrypt(String(profile.id))}
                 where id = ${caseId} and directory_profile_encrypted is null`;
  }
  const match = profile.jobTitle ? await sql()`
    select id from trades
     where active and lower(title) = lower(${profile.jobTitle})
       and (${profile.sector}::text is null or lower(sector) = lower(${profile.sector}))
     limit 1
  ` : [];
  send(res, 200, {
    jobTitle: profile.jobTitle || null,
    sector: profile.sector || null,
    profileUrl: profile.profileUrl || null,
    tradeId: match.length ? match[0].id : null,
  });
}
