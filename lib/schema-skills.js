export async function skillTables(q) {
  await q`
    create table if not exists trade_skills (
      id           text        primary key,
      trade_id     text        not null references trades (id) on delete cascade,
      name         text        not null,
      skill_order  integer     not null default 0,
      active       boolean     not null default true,
      is_demo      boolean     not null default false,
      refreshed_at timestamptz not null default now()
    )
  `;
  await q`create index if not exists trade_skills_trade_idx on trade_skills (trade_id)`;
  await q`create index if not exists trade_skills_name_idx on trade_skills (lower(name))`;

  await q`
    create table if not exists order_skills (
      order_id bigint      not null references orders (id) on delete cascade,
      skill_id text        not null references trade_skills (id) on delete cascade,
      added_at timestamptz not null default now(),
      primary key (order_id, skill_id)
    )
  `;
}
