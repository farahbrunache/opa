import { decrypt, encrypt } from './crypto.js';
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

  await q`alter table if exists work
            add column if not exists activity_id bigint references activities (id) on delete set null`;
  await q`create index if not exists work_activity_idx on work (activity_id)`;
  await q`alter table if exists orders drop column if exists steps_synced_at`;
  await q`alter table if exists chapters drop column if exists steps_synced_at`;
  await q`
    update step_times set step = case step
      when 'milestone-add' then 'activity-add'
      when 'milestone-record' then 'activity-done'
      when 'action-add' then 'activity-add'
      when 'action-record' then 'activity-done'
      when 'action-push' then 'activity-push'
      when 'action-cadence' then 'activity-cadence'
      when 'quote' then 'session-use'
    end
     where step in ('milestone-add', 'milestone-record', 'action-add', 'action-record', 'action-push',
                    'action-cadence', 'quote')
  `;
  await q`
    update case_events set kind = case kind
      when 'milestone.added' then 'activity.added'
      when 'action.added' then 'activity.added'
      when 'milestone.recorded' then 'activity.outcome'
      when 'action.recorded' then 'activity.done'
      when 'action.asked' then 'activity.asked'
      when 'action.cadence' then 'activity.cadence'
      when 'action.sent' then 'activity.moved'
      when 'milestone.shown' then 'activity.moved'
      when 'milestone.hidden' then 'activity.drafted'
      when 'project.taken' then 'work.taken'
      when 'project.moved' then 'work.moved'
    end
     where kind in ('milestone.added', 'action.added', 'milestone.recorded', 'action.recorded', 'action.asked',
                    'action.cadence', 'action.sent', 'milestone.shown', 'milestone.hidden', 'project.taken',
                    'project.moved')
  `;
  const closed = await q`select id, closed_with_encrypted from chapters where closed_with_encrypted is not null`;
  for (const row of closed) {
    const was = JSON.parse(decrypt(row.closed_with_encrypted));
    if (!was.milestones) continue;
    const { milestones, ...rest } = was;
    const now = { ...rest, activities: [...(rest.activities || []), ...milestones] };
    await q`update chapters set closed_with_encrypted = ${encrypt(JSON.stringify(now))} where id = ${row.id}`;
  }

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
