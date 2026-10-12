export async function workTables(q) {
  await q`
    do $$
    begin
      if exists (select 1 from information_schema.columns where table_name = 'plans' and column_name = 'path') then
        alter table plans rename column path to goal;
      end if;
    end $$
  `;
  await q`
    create table if not exists plans (
      id         bigserial   primary key,
      order_id   bigint      not null references orders (id) on delete cascade,
      goal       text        not null,
      in_force   boolean     not null default true,
      created_at timestamptz not null default now()
    )
  `;
  await q`create index if not exists plans_order_idx on plans (order_id, created_at desc)`;
  await q`alter table if exists plans add column if not exists case_id bigint references cases (id)`;
  await q`create index if not exists plans_case_idx on plans (case_id, created_at desc)`;
  await q`create unique index if not exists plans_in_force_idx on plans (order_id) where in_force`;

  await q`
    create table if not exists contacts (
      id             bigserial   primary key,
      case_id        bigint      not null references cases (id) on delete cascade,
      name_encrypted text        not null,
      where_encrypted text,
      why_encrypted  text,
      status         text        not null default 'to approach',
      created_at     timestamptz not null default now(),
      updated_at     timestamptz not null default now()
    )
  `;
  await q`create index if not exists contacts_case_idx on contacts (case_id, created_at)`;
  await q`alter table if exists contacts add column if not exists directory_profile_encrypted text`;

  await q`
    create table if not exists outreach (
      id           bigserial   primary key,
      contact_id   bigint      not null references contacts (id) on delete cascade,
      at           timestamptz not null default now(),
      said_encrypted text,
      back_encrypted text,
      created_at   timestamptz not null default now()
    )
  `;
  await q`create index if not exists outreach_contact_idx on outreach (contact_id, at desc)`;
  await q`alter table if exists outreach add column if not exists channel_encrypted text`;

  await q`
    do $$
    begin
      if exists (select 1 from information_schema.tables where table_name = 'projects')
         and not exists (select 1 from information_schema.tables where table_name = 'work') then
        alter table projects rename to work;
      end if;
      if exists (select 1 from information_schema.columns where table_name = 'work' and column_name = 'delivered_at') then
        alter table work rename column delivered_at to done_at;
      end if;
    end $$
  `;
  await q`alter index if exists projects_case_idx rename to work_case_idx`;
  await q`alter index if exists projects_due_idx rename to work_due_idx`;
  await q`alter index if exists projects_chapter_idx rename to work_chapter_idx`;
  await q`alter index if exists projects_activity_idx rename to work_activity_idx`;
  await q`
    create table if not exists work (
      id              bigserial   primary key,
      case_id         bigint      not null references cases (id) on delete cascade,
      title_encrypted text        not null,
      state           text        not null default 'to do',
      due_at          timestamptz,
      done_at         timestamptz,
      note_encrypted  text,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )
  `;
  await q`create index if not exists work_case_idx on work (case_id, created_at)`;
  await q`create index if not exists work_due_idx
            on work (due_at) where done_at is null and due_at is not null`;

  await q`alter table if exists orders add column if not exists recommendation_done_at timestamptz`;

  await q`
    create table if not exists introductions (
      id                bigserial   primary key,
      a_order_id        bigint      not null references orders (id) on delete cascade,
      b_order_id        bigint      not null references orders (id) on delete cascade,
      reason_encrypted  text,
      outcome           text        not null default 'waiting',
      outcome_encrypted text,
      made_at           timestamptz not null default now(),
      updated_at        timestamptz not null default now(),
      check (a_order_id <> b_order_id)
    )
  `;
  await q`create index if not exists introductions_a_idx on introductions (a_order_id, made_at desc)`;
  await q`create index if not exists introductions_b_idx on introductions (b_order_id, made_at desc)`;
  await q`alter table if exists introductions add column if not exists a_case_id bigint references cases (id)`;
  await q`alter table if exists introductions add column if not exists b_case_id bigint references cases (id)`;
  await q`create index if not exists introductions_a_case_idx on introductions (a_case_id, made_at desc)`;
  await q`create index if not exists introductions_b_case_idx on introductions (b_case_id, made_at desc)`;
  await q`alter table if exists introductions alter column b_order_id drop not null`;
  await q`alter table if exists introductions add column if not exists to_link_encrypted text`;
  await q`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'introductions_other_side') then
        alter table introductions add constraint introductions_other_side
          check (b_order_id is not null or to_link_encrypted is not null);
      end if;
    end $$;
  `;

  await q`
    create table if not exists approach_taps (
      id      bigserial   primary key,
      at      timestamptz not null default now(),
      is_demo boolean     not null default false
    )
  `;
  await q`create index if not exists approach_taps_at_idx on approach_taps (at)`;

  await q`
    create table if not exists approach_fixes (
      id    bigserial   primary key,
      at    timestamptz not null default now(),
      delta integer     not null
    )
  `;
  await q`create index if not exists approach_fixes_at_idx on approach_fixes (at)`;

  await q`
    create table if not exists pair_skips (
      pair_key   text        primary key,
      order_id   bigint      not null references orders (id) on delete cascade,
      is_demo    boolean     not null default false,
      created_at timestamptz not null default now()
    )
  `;
}
