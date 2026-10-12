import { sql } from './db.js';

export const MAX_SKILLS = 10;

const ROLES_SHOWN = 8;

export async function skillList() {
  const rows = await sql()`
    select s.id, s.name, s.trade_id, t.sector, s.is_demo
      from trade_skills s
      join trades t on t.id = s.trade_id
     where s.active and t.active
     order by t.sector_order, t.sector, t.title_order, t.title, s.skill_order, s.name
  `;
  return rows.map((r) => ({
    id: r.id, name: r.name, tradeId: r.trade_id, sector: r.sector, isDemo: Boolean(r.is_demo),
  }));
}

export async function skillsOf(orderId) {
  const rows = await sql()`
    select s.id, s.name, s.is_demo
      from order_skills o join trade_skills s on s.id = o.skill_id
     where o.order_id = ${orderId}
     order by o.added_at, s.name
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, isDemo: Boolean(r.is_demo) }));
}

export async function rolesFor(skillIds) {
  if (!skillIds.length) return [];
  const rows = await sql()`
    select t.id, t.title, t.sector, count(distinct lower(s.name))::int as matched
      from trade_skills s
      join trades t on t.id = s.trade_id
     where s.active and t.active
       and lower(s.name) in (select lower(name) from trade_skills where id = any(${skillIds}))
     group by t.id, t.title, t.sector, t.sector_order, t.title_order
     order by matched desc, t.sector_order, t.title_order, t.title
     limit ${ROLES_SHOWN}
  `;
  return rows.map((r) => ({ id: r.id, title: r.title, sector: r.sector, matched: r.matched }));
}
