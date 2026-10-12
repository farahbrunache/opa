export async function questionTables(q) {
  await q`
    create table if not exists questions (
      id             bigserial   primary key,
      stage          text        not null,
      body_encrypted text        not null,
      is_demo        boolean     not null default false,
      created_at     timestamptz not null default now()
    )
  `;
  await q`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'questions' and column_name = 'retired_at'
      ) then
        delete from questions where retired_at is not null;
      end if;
    end $$;
  `;
  await q`alter table if exists questions drop column if exists retired_at`;
  await q`alter table if exists questions add column if not exists topic_encrypted text`;
  await q`alter table if exists questions add column if not exists sector_id text`;
  await q`alter table if exists questions add column if not exists trade_id text`;
  await q`
    update questions set stage = case stage when 'reading' then 'start' when 'path' then 'first' else 'any' end
     where stage in ('reading', 'path', 'quote')
  `;
  await q`create index if not exists questions_scope_idx on questions (sector_id, trade_id)`;

  await q`
    create table if not exists question_asks (
      id          bigserial   primary key,
      case_id     bigint      not null references cases (id) on delete cascade,
      question_id bigint      not null references questions (id) on delete cascade,
      asked_at    timestamptz not null default now(),
      is_demo     boolean     not null default false
    )
  `;
  await q`
    do $$
    begin
      if not exists (
        select 1 from information_schema.columns
        where table_name = 'question_asks' and column_name = 'id'
      ) then
        alter table question_asks drop constraint if exists question_asks_pkey;
        alter table question_asks add column id bigserial primary key;
      end if;
    end $$;
  `;
  await q`create index if not exists question_asks_case_idx
            on question_asks (case_id, question_id, asked_at desc)`;

  await q`
    create table if not exists call_gaps (
      id                bigserial   primary key,
      draft_id          bigint      not null references drafts (id) on delete cascade,
      order_id          bigint      not null references orders (id) on delete cascade,
      call_id           bigint      not null references calls (id) on delete cascade,
      content_encrypted text        not null,
      created_at        timestamptz not null default now()
    )
  `;
  await q`create index if not exists call_gaps_order_idx on call_gaps (order_id, created_at desc)`;
}
