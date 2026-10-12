import { ensureSchema, sql } from './db.js';
import { decrypt } from './crypto.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId } from './desk-events.js';
import { readFields, CALL_FIELDS } from './desk-callfields.js';
import { askAndRecord, MODEL_CHOICE } from './desk-drafts.js';
import { readChoice } from './settings.js';
import { resolve } from './draft.js';
import { directoryReadConfigured, listProfiles, readProfile } from './desk-directory.js';
import { profileSide, skippedOf } from './desk-skips.js';
import { scopeOf } from './chapter-scope.js';
import { prompt } from './prompts.js';

export const MATCHES_TO_SUGGEST = 5;
const CLIENTS_READ = 40;
const LINKED_PROFILES_READ = 15;
const PROFILES_IN_PROMPT = 120;
const cut = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

export const SOURCES = {
  'job title': 'job title',
  'call line': 'call line',
  skills: 'skills',
  'next steps': 'next steps',
  note: 'note',
  approach: 'people to approach',
  profile: 'Directory profile',
};

const firstName = (name, reference) => (name ? String(name).trim().split(/\s+/)[0] : reference || 'This person');

function chip(side, key, who) {
  if (key === 'profile') return side === 'them' && who.kind === 'directory' ? SOURCES.profile : null;
  if (side === 'them' && who.kind === 'directory') return null;
  const name = side === 'this' ? who.self : who.other;
  return key === 'note' ? `Your note on ${name}` : `${name}'s ${SOURCES[key]}`;
}

export function readSources(text, who) {
  const out = [];
  for (const part of String(text || '').replace(/^\s*sources?\s*:/i, '').split(',')) {
    const m = part.trim().toLowerCase().match(/^(this|them)\s+(.+?)\.?$/);
    if (!m || !Object.prototype.hasOwnProperty.call(SOURCES, m[2])) continue;
    const label = chip(m[1], m[2], who);
    if (label && !out.includes(label)) out.push(label);
  }
  return out.slice(0, 4);
}

async function ownerLines(orderRow) {
  const id = Number(orderRow.id);
  const scope = await scopeOf(id);
  const [call] = (await sql()`
    select fields_encrypted, chapter_id from calls
     where order_id = ${id} and fields_encrypted is not null
     order by started_at desc
  `).filter((c) => scope.holds(c.chapter_id));
  const fields = call ? readFields(call.fields_encrypted) : scope.fields;
  const skills = await sql()`
    select s.name from order_skills o join trade_skills s on s.id = o.skill_id where o.order_id = ${id}
  `;
  const notes = (await sql()`
    select detail_encrypted, chapter_id from case_events
     where kind = 'note' and detail_encrypted is not null
       and (order_id = ${id} or (${orderRow.case_id}::bigint is not null and case_id = ${orderRow.case_id}))
     order by created_at desc limit 20
  `).filter((n) => scope.holds(n.chapter_id)).slice(0, 3);
  const whys = orderRow.case_id ? (await sql()`
    select why_encrypted, chapter_id from contacts where case_id = ${orderRow.case_id} and why_encrypted is not null
     order by created_at desc limit 20
  `).filter((w) => scope.holds(w.chapter_id)).slice(0, 3) : [];
  return [
    orderRow.trade_title ? `Job title: ${orderRow.trade_title}` : null,
    ...(fields ? CALL_FIELDS.map(([key, label]) => (fields[key] ? `${label}: ${cut(fields[key], 200)}` : null)) : []),
    skills.length ? `Skills: ${skills.map((s) => s.name).join(', ')}` : null,
    orderRow.recommendations_encrypted && scope.since(orderRow.recommendations_written_at)
      ? `Next steps written for them: ${cut(decrypt(orderRow.recommendations_encrypted), 600)}` : null,
    ...notes.map((n) => `Note: ${cut(decrypt(n.detail_encrypted), 200)}`),
    ...whys.map((w) => `Someone they're approaching, and why: ${cut(decrypt(w.why_encrypted), 160)}`),
  ].filter(Boolean);
}

function profileLine(profile) {
  const place = [profile.city, profile.state, profile.country].filter(Boolean).join(', ');
  return [
    profile.jobTitle ? `Job title: ${cut(profile.jobTitle, 80)}` : null,
    profile.headline ? `About: ${cut(profile.headline, 160)}` : null,
    profile.sector ? `Sector: ${cut(profile.sector, 60)}` : null,
    Array.isArray(profile.skills) && profile.skills.length
      ? `Skills: ${profile.skills.slice(0, 8).map((s) => cut(s, 40)).join(', ')}` : null,
    place ? `Place: ${cut(place, 80)}` : null,
  ].filter(Boolean).join('; ');
}

const nameOf = (profile) => [profile.firstName, profile.lastName].filter(Boolean).join(' ');

export async function matchPrompt(id) {
  const [me] = await sql()`
    select o.id, o.case_id, o.is_demo, o.recommendations_encrypted, o.recommendations_written_at, t.title as trade_title,
           o.reference_code, k.name_encrypted,
           k.directory_profile_encrypted as own_profile
      from orders o left join trades t on t.id = o.trade_id left join cases k on k.id = o.case_id
     where o.id = ${id}
  `;
  if (!me) throw new HttpError(404, 'No order with that number.');
  const mine = await ownerLines(me);

  const others = await sql()`
    select distinct on (coalesce(o.case_id, -o.id))
           o.id, o.case_id, o.reference_code, o.is_demo, o.recommendations_encrypted, o.recommendations_written_at,
           t.title as trade_title, k.name_encrypted, k.directory_profile_encrypted as own_profile
      from orders o
      left join trades t on t.id = o.trade_id
      left join cases k on k.id = o.case_id
     where o.id <> ${id} and o.status = 'confirmed' and not o.is_mine
       and (not o.is_demo or ${Boolean(me.is_demo)})
       and (${me.case_id}::bigint is null or o.case_id is null or o.case_id <> ${me.case_id})
       and exists (select 1 from calls c where c.order_id = o.id and c.transcript_encrypted is not null)
       and not exists (
         select 1 from introductions i
          where (i.a_order_id = ${id} and i.b_order_id = o.id) or (i.b_order_id = ${id} and i.a_order_id = o.id)
             or (${me.case_id}::bigint is not null and o.case_id is not null and (
                  (i.a_case_id = ${me.case_id} and i.b_case_id = o.case_id)
               or (i.b_case_id = ${me.case_id} and i.a_case_id = o.case_id))))
     order by coalesce(o.case_id, -o.id), o.id desc
  `;
  const keys = others.map((o) => `o:${Math.min(id, Number(o.id))}|o:${Math.max(id, Number(o.id))}`);
  const skipped = await skippedOf(keys);
  const clients = [];
  for (const [i, other] of others.entries()) {
    if (skipped.has(keys[i])) continue;
    const lines = await ownerLines(other);
    if (lines.length) clients.push({ row: other, lines });
  }
  clients.sort((a, b) => Number(b.row.id) - Number(a.row.id));
  clients.splice(CLIENTS_READ);

  const profiles = new Map();
  let said = null;
  const exclude = new Set();
  if (me.own_profile) exclude.add(decrypt(me.own_profile));
  if (directoryReadConfigured()) {
    const theirs = me.case_id ? await sql()`
      select directory_profile_encrypted from contacts
       where case_id = ${me.case_id} and directory_profile_encrypted is not null
    ` : [];
    for (const r of theirs) exclude.add(decrypt(r.directory_profile_encrypted));
    for (const c of others) if (c.own_profile) exclude.add(decrypt(c.own_profile));
    const linked = await sql()`
      select distinct directory_profile_encrypted as p from contacts
       where directory_profile_encrypted is not null
    `;
    const linkedIds = [...new Set(linked.map((r) => decrypt(r.p)))]
      .filter((p) => !exclude.has(p)).slice(0, LINKED_PROFILES_READ);
    const read = await Promise.allSettled(linkedIds.map((p) => readProfile(p)));
    read.forEach((r, i) => {
      if (r.status === 'fulfilled') profiles.set(linkedIds[i], { ...r.value, id: linkedIds[i] });
    });
    const listed = await listProfiles();
    said = listed.said;
    for (const p of listed.profiles) if (!exclude.has(p.id) && !profiles.has(p.id)) profiles.set(p.id, p);
  } else {
    said = 'Directory not connected';
  }
  const profileKeys = [...profiles.keys()].map((p) => `o:${id}|${profileSide(p)}`);
  const skippedProfiles = await skippedOf(profileKeys);
  const directory = [...profiles.values()]
    .filter((p, i) => !skippedProfiles.has(profileKeys[i]) && profileLine(p))
    .slice(0, PROFILES_IN_PROMPT);

  const index = new Map();
  const lines = [];
  clients.forEach((c, i) => {
    index.set(`C${i + 1}`, { kind: 'client', row: c.row });
    lines.push(`C${i + 1}: ${c.lines.join('; ')}`);
  });
  directory.forEach((p, i) => {
    index.set(`D${i + 1}`, { kind: 'directory', profile: p });
    lines.push(`D${i + 1}: ${profileLine(p)}`);
  });

  const messages = [
    { role: 'system', content: await prompt('matches', { matches: MATCHES_TO_SUGGEST, sources: Object.keys(SOURCES).join(', ') }) },
    { role: 'user', content: [
      'This person:', ...(mine.length ? mine : ['nothing written yet']),
      '', 'People:', ...(lines.length ? lines : ['nobody']),
    ].join('\n') },
  ];
  const self = firstName(me.name_encrypted ? decrypt(me.name_encrypted) : null, me.reference_code);
  return { messages, index, said, self, empty: !lines.length };
}

export function readMatches(content, index, self = 'This person') {
  const out = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(?:[-*]\s*)?\[?([CD]\d+)\]?\s*[:.)—-]\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const hit = index.get(key);
    if (!hit || out.some((o) => o.key === key)) continue;
    const [said, sources] = m[2].split('|');
    out.push({ key, hit, reason: cut(said, 300), sources });
    if (out.length === MATCHES_TO_SUGGEST) break;
  }
  return out.map(({ hit, reason, sources }) => {
    if (hit.kind === 'client') {
      const r = hit.row;
      const name = r.name_encrypted ? decrypt(r.name_encrypted) : null;
      return {
        kind: 'client', orderId: Number(r.id), reference: r.reference_code,
        name, title: r.trade_title || null, isDemo: Boolean(r.is_demo), reason,
        sources: readSources(sources, { kind: 'client', self, other: firstName(name, r.reference_code) }),
      };
    }
    const p = hit.profile;
    const base = (process.env.DIRECTORY_SERVICE_URL || '').replace(/\/+$/, '');
    const link = /^https?:\/\//i.test(p.profileUrl || '') ? p.profileUrl
      : base ? `${base}/apps/directory/profile/${encodeURIComponent(p.id)}` : null;
    return {
      kind: 'directory', profileId: p.id, name: nameOf(p) || null,
      title: p.jobTitle || p.headline || null, claimed: p.claimed !== false, link, reason,
      sources: readSources(sources, { kind: 'directory', self }),
    };
  });
}

export async function findMatches(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const id = orderId((await readJson(req)).id);
  const slot = await readChoice(MODEL_CHOICE);
  resolve(slot);
  const { messages, index, said, self, empty } = await matchPrompt(id);
  if (empty) {
    throw new HttpError(409, 'There is nobody to match against yet: no other case on the desk has '
      + 'anything typed on it, and no Directory profile could be read.');
  }
  send(res, 202, await askAndRecord(id, messages, slot, 'matches', { index: [...index], said, self }));
}

export function finishMatches(answer, context) {
  return {
    model: answer.model,
    seconds: answer.seconds,
    said: context.said,
    suggestions: readMatches(answer.content, new Map(context.index || []), context.self),
  };
}
