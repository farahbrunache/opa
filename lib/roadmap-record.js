import { sql } from './db.js';
import { decrypt } from './crypto.js';

const on = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
const STOP = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'on', 'in', 'for', 'at', 'with', 'your', 'you', 'their', 'by', 'from', 'or', 'it', 'is', 'be']);

export function words(text) {
  return new Set(String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, '')));
}

export function sameThing(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both) >= 0.6;
}

export async function proposedBefore(caseId) {
  const drafts = await sql()`
    select r.content_encrypted from roadmap_drafts r join orders o on o.id = r.order_id
     where o.case_id = ${caseId} order by r.created_at desc limit 50
  `;
  const out = [];
  for (const row of drafts) {
    for (const change of JSON.parse(decrypt(row.content_encrypted)).changes || []) {
      if (change.op === 'add') out.push({ title: change.title, state: change.state });
    }
  }
  return out;
}

export async function chapterRecord(caseId, scope) {
  const lines = [];
  const contacts = (await sql()`
    select id, name_encrypted, where_encrypted, status, chapter_id from contacts
     where case_id = ${caseId} order by created_at asc
  `).filter((c) => scope.holds(c.chapter_id));
  const reaches = contacts.length ? await sql()`
    select o.contact_id, o.at, o.said_encrypted, o.back_encrypted from outreach o
      join contacts c on c.id = o.contact_id where c.case_id = ${caseId} order by o.at asc
  ` : [];
  for (const c of contacts) {
    lines.push(`Contact: ${decrypt(c.name_encrypted)} at ${decrypt(c.where_encrypted)} · ${c.status}`);
    for (const r of reaches.filter((x) => Number(x.contact_id) === Number(c.id))) {
      lines.push(`  ${on(r.at)}: said ${decrypt(r.said_encrypted)}${r.back_encrypted ? ` · back: ${decrypt(r.back_encrypted)}` : ' · nothing back'}`);
    }
  }
  const work = (await sql()`
    select title_encrypted, state, done_at, note_encrypted, chapter_id from work
     where case_id = ${caseId} order by created_at asc
  `).filter((w) => scope.holds(w.chapter_id));
  for (const w of work) {
    lines.push(`Work, ${w.state}: ${decrypt(w.title_encrypted)}${w.done_at ? ` · done ${on(w.done_at)}` : ''}`
      + `${w.note_encrypted ? ` · ${decrypt(w.note_encrypted)}` : ''}`);
  }
  const held = await sql()`
    select h.used_at, a.title_encrypted from held_sessions h
      left join activities a on a.id = h.activity_id where h.case_id = ${caseId}
  `;
  for (const h of held) {
    lines.push(`Session on their card: ${h.used_at ? `used ${on(h.used_at)}` : 'unused'}`
      + `${h.title_encrypted ? ` · for ${decrypt(h.title_encrypted)}` : ''}`);
  }
  const notes = (await sql()`
    select detail_encrypted, created_at, chapter_id from case_events
     where kind = 'note' and detail_encrypted is not null and case_id = ${caseId}
     order by created_at asc limit 60
  `).filter((n) => scope.holds(n.chapter_id));
  for (const n of notes) lines.push(`Your note ${on(n.created_at)}: ${decrypt(n.detail_encrypted)}`);
  return lines;
}
