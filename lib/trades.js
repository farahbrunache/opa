import { ensureSchema, sql } from './db.js';
import { HttpError } from './http.js';

const FETCH_MS = 15_000;

function where() {
  const url = String(process.env.TAXONOMY_URL || '').replace(/\/+$/, '');
  const token = String(process.env.TAXONOMY_TOKEN || '');
  if (!url || !token) {
    throw new HttpError(503, 'TAXONOMY_URL or TAXONOMY_TOKEN is not set, so the Skills Taxonomy '
      + "can't be read from Charging The Future. Every job title already copied here still works.");
  }
  return { url, token };
}

export async function refreshTrades() {
  await ensureSchema();
  const { url, token } = where();
  let response;
  try {
    response = await fetch(`${url}/api/skills-taxonomy/hierarchy`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (error) {
    throw new HttpError(502, `Charging The Future didn't answer for the Skills Taxonomy: ${error.message}. `
      + 'The copy here is unchanged.');
  }
  if (!response.ok) {
    throw new HttpError(502, `Charging The Future answered ${response.status} for the Skills Taxonomy. `
      + (response.status === 401 || response.status === 403
        ? 'TAXONOMY_TOKEN is wrong or was revoked. It is sent as name.secret. '
        : '')
      + 'The copy here is unchanged.');
  }
  const body = await response.json();
  const seen = [];
  const skills = { id: [], trade: [], name: [], order: [], active: [] };
  for (const sector of body.items || []) {
    for (const title of sector.jobTitles || []) {
      seen.push(String(title.id));
      for (const skill of title.skills || []) {
        skills.id.push(String(skill.id));
        skills.trade.push(String(title.id));
        skills.name.push(String(skill.name));
        skills.order.push(Number(skill.displayOrder) || 0);
        skills.active.push(sector.isActive !== false && title.isActive !== false && skill.isActive !== false);
      }
      await sql()`
        insert into trades (id, title, sector_id, sector, sector_order, title_order, active, refreshed_at)
        values (${String(title.id)}, ${title.name}, ${String(sector.id)}, ${sector.name},
                ${Number(sector.displayOrder) || 0}, ${Number(title.displayOrder) || 0},
                ${Boolean(sector.isActive !== false && title.isActive !== false)}, now())
        on conflict (id) do update set
          title = excluded.title, sector_id = excluded.sector_id, sector = excluded.sector,
          sector_order = excluded.sector_order, title_order = excluded.title_order,
          active = excluded.active, refreshed_at = now()
      `;
    }
  }
  if (skills.id.length) {
    await sql()`
      insert into trade_skills (id, trade_id, name, skill_order, active, refreshed_at)
      select s.id, s.trade_id, s.name, s.skill_order, s.active, now()
        from unnest(${skills.id}::text[], ${skills.trade}::text[], ${skills.name}::text[],
                    ${skills.order}::int[], ${skills.active}::boolean[])
             as s (id, trade_id, name, skill_order, active)
      on conflict (id) do update set
        trade_id = excluded.trade_id, name = excluded.name, skill_order = excluded.skill_order,
        active = excluded.active, refreshed_at = now()
    `;
  }
  const retired = seen.length
    ? await sql()`update trades set active = false
                   where not is_demo and active and not (id = any(${seen})) returning id`
    : [];
  if (skills.id.length) {
    await sql()`update trade_skills set active = false
                 where not is_demo and active and not (id = any(${skills.id}))`;
  }
  return { titles: seen.length, skills: skills.id.length, retired: retired.length };
}

export async function tradeList() {
  const rows = await sql()`
    select id, title, sector, is_demo from trades
     where active
     order by sector_order, sector, title_order, title
  `;
  return rows.map((r) => ({ id: r.id, title: r.title, sector: r.sector, isDemo: Boolean(r.is_demo) }));
}

export async function suggestFor(orderId, limit = 5) {
  const me = await sql()`
    select o.id, o.case_id, o.trade_id, t.sector_id
      from orders o left join trades t on t.id = o.trade_id
     where o.id = ${orderId}
  `;
  if (!me.length || !me[0].trade_id) return { trade: null, same: [], sector: [] };
  const { case_id: caseId, trade_id: tradeId, sector_id: sectorId } = me[0];
  const rows = await sql()`
    select o.id, o.reference_code, o.is_demo, o.trade_id, t.title, k.name_encrypted,
           o.trade_id = ${tradeId} as same_trade
      from orders o
      join trades t on t.id = o.trade_id
      left join cases k on k.id = o.case_id
     where t.sector_id = ${sectorId}
       and o.decision = 'go'
       and o.id <> ${orderId}
       and (${caseId}::bigint is null or o.case_id is null or o.case_id <> ${caseId})
       and not exists (
         select 1 from introductions i
          where (i.a_order_id = ${orderId} and i.b_order_id = o.id)
             or (i.b_order_id = ${orderId} and i.a_order_id = o.id)
             or (${caseId}::bigint is not null and o.case_id is not null and (
                  (i.a_case_id = ${caseId} and i.b_case_id = o.case_id)
               or (i.b_case_id = ${caseId} and i.a_case_id = o.case_id)))
       )
       and not exists (
         select 1 from pair_skips s
          where s.pair_key = 'o:' || least(o.id, ${orderId}::bigint) || '|o:' || greatest(o.id, ${orderId}::bigint)
       )
     order by o.id desc
     limit ${limit * 4}
  `;
  return {
    trade: tradeId,
    same: rows.filter((r) => r.same_trade).slice(0, limit),
    sector: rows.filter((r) => !r.same_trade).slice(0, limit),
  };
}

export async function pairsToIntroduce(limit = 10) {
  return sql()`
    select a.id as a_id, a.reference_code as a_ref, ka.name_encrypted as a_name, ta.title as a_title,
           b.id as b_id, b.reference_code as b_ref, kb.name_encrypted as b_name, tb.title as b_title,
           ta.sector, (a.is_demo or b.is_demo) as is_demo
      from orders a
      join trades ta on ta.id = a.trade_id
      join orders b on b.id > a.id and b.decision = 'go'
      join trades tb on tb.id = b.trade_id and tb.sector_id = ta.sector_id
      left join cases ka on ka.id = a.case_id
      left join cases kb on kb.id = b.case_id
     where a.decision = 'go'
       and (a.case_id is null or b.case_id is null or a.case_id <> b.case_id)
       and not exists (
         select 1 from introductions i
          where (i.a_order_id = a.id and i.b_order_id = b.id)
             or (i.a_order_id = b.id and i.b_order_id = a.id)
             or (a.case_id is not null and b.case_id is not null and (
                  (i.a_case_id = a.case_id and i.b_case_id = b.case_id)
               or (i.a_case_id = b.case_id and i.b_case_id = a.case_id)))
       )
       and not exists (select 1 from pair_skips s where s.pair_key = 'o:' || a.id || '|o:' || b.id)
     order by b.id desc, a.id desc
     limit ${limit}
  `;
}
