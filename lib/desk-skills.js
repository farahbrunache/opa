import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { orderId, record } from './desk-events.js';
import { MAX_SKILLS, rolesFor, skillList, skillsOf } from './skills.js';

export async function listSkills(req, res) {
  requireAdmin(req);
  await ensureSchema();
  send(res, 200, { skills: await skillList() });
}

export async function setSkills(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);
  const id = orderId(body.id);
  const wanted = [...new Set((Array.isArray(body.skills) ? body.skills : []).map(String))];
  if (wanted.length > MAX_SKILLS) {
    throw new HttpError(400, `${MAX_SKILLS} skills at most. Remove one before adding another.`);
  }
  const exists = await sql()`select 1 from orders where id = ${id}`;
  if (!exists.length) throw new HttpError(404, 'No order with that number.');
  const found = wanted.length
    ? await sql()`select id from trade_skills where id = any(${wanted}) and active`
    : [];
  if (found.length !== wanted.length) {
    throw new HttpError(404, "A skill isn't in the copied Skills Taxonomy any more. Copy it again and pick from there.");
  }

  await sql()`delete from order_skills where order_id = ${id} and not (skill_id = any(${wanted}))`;
  if (wanted.length) {
    await sql()`
      insert into order_skills (order_id, skill_id)
      select ${id}, unnest(${wanted}::text[])
      on conflict do nothing
    `;
  }
  const roles = await rolesFor(wanted);
  const trade = roles[0] || null;
  await sql()`update orders set trade_id = ${trade ? trade.id : null} where id = ${id}`;
  const skills = await skillsOf(id);
  await record(id, 'skills', skills.length
    ? `Skills: ${skills.map((s) => s.name).join(', ')}. Job title: ${trade ? trade.title : 'none'}.`
    : 'Skills cleared.');
  send(res, 200, { skills, trade });
}
