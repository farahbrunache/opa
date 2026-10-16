export async function chapterTables(q) {
  await q`
    create table if not exists chapters (
      id                     bigserial   primary key,
      case_id                bigint      not null references cases (id) on delete cascade,
      number                 integer     not null,
      name_encrypted         text,
      started_at             timestamptz not null default now(),
      ended_at               timestamptz,
      brief_encrypted        text,
      changed_encrypted      text,
      started_by             text,
      from_message_id        bigint,
      from_call_id           bigint,
      summary_encrypted      text,
      decision               text,
      decision_at            timestamptz,
      closed_with_encrypted  text,
      created_at             timestamptz not null default now(),
      unique (case_id, number)
    )
  `;
  await q`alter table if exists chapters add column if not exists from_call_id bigint`;

  await q`alter table if exists chapters add column if not exists steps_encrypted text`;
  await q`alter table if exists chapters add column if not exists steps_written_at timestamptz`;
  await q`alter table if exists chapters add column if not exists steps_posted_hash text`;
  await q`drop table if exists chapter_proposals`;

  await q`
    create or replace function chapter_now(person bigint) returns bigint
    language sql stable as $$
      select id from chapters where case_id = person and ended_at is null
       order by number desc limit 1
    $$
  `;

  await q`
    create or replace function chapters_first() returns trigger
    language plpgsql as $$
    begin
      insert into chapters (case_id, number, started_at)
      values (new.id, 1, new.created_at)
      on conflict (case_id, number) do nothing;
      return new;
    end $$
  `;
  await q`create or replace trigger cases_chapter_one after insert on cases
            for each row execute function chapters_first()`;
  await q`
    insert into chapters (case_id, number, started_at)
    select k.id, 1, least(k.created_at, coalesce(
             (select min(o.created_at) from orders o where o.case_id = k.id), k.created_at))
      from cases k
     where not exists (select 1 from chapters c where c.case_id = k.id)
  `;

  await q`alter table if exists contacts
            add column if not exists chapter_id bigint references chapters (id) on delete set null`;
  await q`create index if not exists contacts_chapter_idx on contacts (chapter_id)`;
  await q`alter table if exists work
            add column if not exists chapter_id bigint references chapters (id) on delete set null`;
  await q`create index if not exists work_chapter_idx on work (chapter_id)`;
  await q`alter table if exists question_asks
            add column if not exists chapter_id bigint references chapters (id) on delete set null`;
  await q`create index if not exists question_asks_chapter_idx on question_asks (chapter_id)`;
  await q`alter table if exists calls
            add column if not exists chapter_id bigint references chapters (id) on delete set null`;
  await q`create index if not exists calls_chapter_idx on calls (chapter_id)`;
  await q`alter table if exists call_gaps
            add column if not exists chapter_id bigint references chapters (id) on delete set null`;
  await q`create index if not exists call_gaps_chapter_idx on call_gaps (chapter_id)`;
  await q`alter table if exists plans
            add column if not exists chapter_id bigint references chapters (id) on delete set null`;
  await q`create index if not exists plans_chapter_idx on plans (chapter_id)`;
  await q`alter table if exists case_events
            add column if not exists chapter_id bigint references chapters (id) on delete set null`;
  await q`create index if not exists case_events_chapter_idx on case_events (chapter_id)`;
  await q`alter table if exists introductions
            add column if not exists a_chapter_id bigint references chapters (id) on delete set null`;
  await q`alter table if exists introductions
            add column if not exists b_chapter_id bigint references chapters (id) on delete set null`;
  await q`
    create or replace function chapter_stamp_by_case() returns trigger
    language plpgsql as $$
    begin
      if new.chapter_id is null then
        new.chapter_id := chapter_now(new.case_id);
      end if;
      return new;
    end $$
  `;
  await q`create or replace trigger contacts_chapter before insert on contacts
            for each row execute function chapter_stamp_by_case()`;
  await q`drop trigger if exists projects_chapter on work`;
  await q`create or replace trigger work_chapter before insert on work
            for each row execute function chapter_stamp_by_case()`;
  await q`create or replace trigger question_asks_chapter before insert on question_asks
            for each row execute function chapter_stamp_by_case()`;
  await q`
    create or replace function chapter_stamp_by_order() returns trigger
    language plpgsql as $$
    begin
      if new.chapter_id is null then
        new.chapter_id := (select chapter_now(o.case_id) from orders o where o.id = new.order_id);
      end if;
      return new;
    end $$
  `;
  await q`create or replace trigger calls_chapter before insert on calls
            for each row execute function chapter_stamp_by_order()`;
  await q`create or replace trigger call_gaps_chapter before insert on call_gaps
            for each row execute function chapter_stamp_by_order()`;
  await q`
    create or replace function chapter_stamp_by_case_or_order() returns trigger
    language plpgsql as $$
    begin
      if new.chapter_id is null then
        new.chapter_id := coalesce(chapter_now(new.case_id),
                                 (select chapter_now(o.case_id) from orders o where o.id = new.order_id));
      end if;
      return new;
    end $$
  `;
  await q`create or replace trigger plans_chapter before insert on plans
            for each row execute function chapter_stamp_by_case_or_order()`;
  await q`create or replace trigger case_events_chapter before insert on case_events
            for each row execute function chapter_stamp_by_case_or_order()`;
  await q`
    create or replace function chapter_stamp_introductions() returns trigger
    language plpgsql as $$
    begin
      if new.a_chapter_id is null then new.a_chapter_id := chapter_now(new.a_case_id); end if;
      if new.b_chapter_id is null then new.b_chapter_id := chapter_now(new.b_case_id); end if;
      return new;
    end $$
  `;
  await q`create or replace trigger introductions_chapter before insert on introductions
            for each row execute function chapter_stamp_introductions()`;
}
