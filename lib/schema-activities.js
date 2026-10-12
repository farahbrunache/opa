export async function activityTables(q) {
  await q`
    create table if not exists activities (
      id                bigserial   primary key,
      case_id           bigint      not null references cases (id) on delete cascade,
      plan_id           bigint      references plans (id) on delete set null,
      position          integer     not null default 0,
      title_encrypted   text        not null,
      state             text        not null default 'drafted',
      source            text        not null default 'you',
      step_order_id     bigint      references orders (id) on delete cascade,
      step_chapter_id   bigint      references chapters (id) on delete cascade,
      step_number       integer,
      shown_at          timestamptz,
      cadence           text        not null default 'none',
      next_at           timestamptz,
      asked_at          timestamptz,
      outcome_encrypted text,
      drop_reason       text,
      closed_at         timestamptz,
      chapter_id        bigint      references chapters (id) on delete set null,
      created_at        timestamptz not null default now(),
      updated_at        timestamptz not null default now()
    )
  `;
  await q`create index if not exists activities_case_idx on activities (case_id, position, id)`;
  await q`create index if not exists activities_due_idx
            on activities (next_at) where state = 'todo' and next_at is not null`;
  await q`create unique index if not exists activities_step_order_idx
            on activities (step_order_id, step_number) where step_order_id is not null`;
  await q`create unique index if not exists activities_step_chapter_idx
            on activities (step_chapter_id, step_number) where step_chapter_id is not null`;
  await q`create or replace trigger activities_chapter before insert on activities
            for each row execute function chapter_stamp_by_case()`;

  await q`alter table if exists projects
            add column if not exists activity_id bigint references activities (id) on delete set null`;
  await q`create index if not exists projects_activity_idx on projects (activity_id)`;
  await q`update projects set state = 'done' where state = 'delivered'`;

  await q`alter table if exists orders add column if not exists steps_synced_at timestamptz`;
  await q`alter table if exists chapters add column if not exists steps_synced_at timestamptz`;

  await q`
    do $$
    begin
      if exists (select 1 from information_schema.tables where table_name = 'milestones') then
        insert into activities (case_id, plan_id, position, title_encrypted, state, source, shown_at,
                                outcome_encrypted, drop_reason, closed_at, chapter_id, created_at, updated_at)
        select p.case_id, p.id, m.position * 100, m.title_encrypted,
               case when m.status = 'worked' then 'done'
                    when m.status = 'changed direction' then 'dropped'
                    when m.shown_at is null then 'drafted'
                    else 'todo' end,
               'you', m.shown_at, m.outcome_encrypted,
               case when m.status = 'changed direction' then 'changed-direction' end,
               case when m.status in ('worked', 'changed direction') then m.updated_at end,
               m.chapter_id, m.created_at, m.updated_at
          from milestones m join plans p on p.id = m.plan_id
         where p.case_id is not null;
        insert into case_events (order_id, case_id, kind, detail_encrypted, created_at)
        select p.order_id, p.case_id, 'activity.migrated', m.title_encrypted, now()
          from milestones m join plans p on p.id = m.plan_id
         where p.case_id is not null and m.status in ('stalled', 'ghosted');
        insert into activities (case_id, plan_id, position, title_encrypted, state, source, shown_at,
                                cadence, next_at, asked_at, outcome_encrypted, drop_reason, closed_at,
                                chapter_id, created_at, updated_at)
        select p.case_id, p.id, m.position * 100 + a.position, a.title_encrypted,
               case when a.status = 'done' then 'done'
                    when a.status = 'dropped' then 'dropped'
                    when a.shown_at is null then 'drafted'
                    else 'todo' end,
               'you', a.shown_at, a.cadence, case when a.status = 'open' then a.next_at end, a.asked_at,
               a.outcome_encrypted,
               case when a.status = 'dropped' then 'before-reasons' end,
               a.closed_at, m.chapter_id, a.created_at, a.updated_at
          from action_items a join milestones m on m.id = a.milestone_id join plans p on p.id = m.plan_id
         where p.case_id is not null;
      end if;
    end $$;
  `;
  await q`drop table if exists action_items`;
  await q`drop table if exists milestones`;
  await q`drop function if exists chapter_stamp_by_plan()`;

  await q`
    create table if not exists held_sessions (
      id          bigserial   primary key,
      case_id     bigint      not null references cases (id) on delete cascade,
      order_id    bigint      references orders (id) on delete set null,
      rate        text        not null,
      bought_at   timestamptz not null default now(),
      used_at     timestamptz,
      activity_id bigint      references activities (id) on delete set null,
      is_demo     boolean     not null default false
    )
  `;
  await q`create index if not exists held_sessions_case_idx on held_sessions (case_id, bought_at)`;
  await q`create unique index if not exists held_sessions_order_idx
            on held_sessions (order_id) where order_id is not null`;

  await q`
    create table if not exists access_requests (
      id           bigserial   primary key,
      case_id      bigint      not null references cases (id) on delete cascade,
      month        text        not null,
      requested_at timestamptz not null default now(),
      granted_at   timestamptz,
      order_id     bigint      references orders (id) on delete set null,
      is_demo      boolean     not null default false
    )
  `;
  await q`create index if not exists access_requests_month_idx on access_requests (month, requested_at)`;
  await q`create index if not exists access_requests_case_idx on access_requests (case_id, requested_at desc)`;

  await q`
    create table if not exists question_passes (
      id          bigserial   primary key,
      case_id     bigint      not null references cases (id) on delete cascade,
      question_id bigint      not null references questions (id) on delete cascade,
      reason      text,
      passed_at   timestamptz not null default now(),
      is_demo     boolean     not null default false
    )
  `;
  await q`create index if not exists question_passes_case_idx on question_passes (case_id, question_id)`;
}

export async function dropQuotes(q) {
  await q`alter table if exists projects drop column if exists quote_id`;
  await q`drop table if exists quotes`;
  await q`drop function if exists chapter_stamp_by_account()`;
}
