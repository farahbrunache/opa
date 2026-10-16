import { neon } from '@neondatabase/serverless';
import { clientTables } from './schema-client.js';
import { questionTables } from './schema-questions.js';
import { roadmapTables } from './schema-roadmap.js';
import { workTables } from './schema-work.js';
import { skillTables } from './schema-skills.js';
import { activityTables } from './schema-activities.js';
import { strategyTables } from './schema-strategy.js';

let cachedSql = null;

export function sql() {
  if (!cachedSql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set.');
    }
    cachedSql = neon(url);
  }
  return cachedSql;
}

export function useDatabase(tagged) {
  cachedSql = tagged;
  ready = false;
}

let ready = false;
export async function ensureSchema() {
  if (ready) return;
  const q = sql();
  await q`
    create table if not exists orders (
      id                    bigserial primary key,
      claim_token_hash      text        not null unique,
      card_code_hash        text        not null,
      card_amount_cents     integer     not null,
      card_code_encrypted   text,
      status                text        not null default 'pending',
      reject_reason         text,
      created_at            timestamptz not null default now(),
      decided_at            timestamptz
    )
  `;
  await q`alter table if exists orders add column if not exists payment_method text`;
  await q`alter table if exists orders add column if not exists reference_code text`;
  await q`alter table if exists orders alter column card_code_hash drop not null`;
  await q`create unique index if not exists orders_reference_code_idx on orders (reference_code)`;

  await q`alter table if exists orders add column if not exists session_starts integer not null default 0`;
  await q`alter table if exists orders add column if not exists first_started_at timestamptz`;

  await q`alter table if exists orders add column if not exists client_account_id text`;
  await q`alter table if exists orders add column if not exists approved_as_client_at timestamptz`;

  await q`alter table if exists orders add column if not exists recommendations_encrypted text`;
  await q`alter table if exists orders add column if not exists recommendations_written_at timestamptz`;
  await q`create index if not exists orders_client_account_idx on orders (client_account_id)`;

  await q`update orders set payment_method = 'amazon' where payment_method is null and card_code_hash is not null`;

  await q`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'orders' and column_name = 'access_code_uses'
      ) then
        update orders set session_starts = access_code_uses where session_starts = 0;
        update orders set first_started_at = access_code_first_used_at where first_started_at is null;
      end if;
    end $$;
  `;
  await q`alter table if exists orders drop column if exists access_code_uses`;
  await q`alter table if exists orders drop column if exists access_code_first_used_at`;
  await q`alter table if exists orders drop column if exists access_code_used_at`;
  await q`alter table if exists orders drop column if exists card_brand`;
  await q`create index if not exists orders_status_idx on orders (status, created_at desc)`;
  await q`create unique index if not exists orders_card_code_hash_idx on orders (card_code_hash)`;
  await q`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'orders' and column_name = 'assessment'
      ) and not exists (
        select 1 from information_schema.columns
        where table_name = 'orders' and column_name = 'decision'
      ) then
        alter table orders rename column assessment to decision;
      end if;
    end $$;
  `;
  await q`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'orders' and column_name = 'assessed_at'
      ) and not exists (
        select 1 from information_schema.columns
        where table_name = 'orders' and column_name = 'decision_at'
      ) then
        alter table orders rename column assessed_at to decision_at;
      end if;
    end $$;
  `;
  await q`alter table if exists orders add column if not exists decision text`;
  await q`alter table if exists orders add column if not exists decision_at timestamptz`;
  await q`alter table if exists orders add column if not exists kind text not null default 'call'`;
  await q`alter table if exists orders add column if not exists rate text`;
  await q`create index if not exists orders_kind_idx on orders (kind, status, decided_at)`;

  await q`
    create table if not exists cases (
      id                bigserial   primary key,
      account_id        text        not null unique,
      first_customer_at timestamptz,
      created_at        timestamptz not null default now()
    )
  `;
  await q`alter table if exists cases add column if not exists first_customer_at timestamptz`;
  await q`alter table if exists cases add column if not exists name_encrypted text`;

  await q`alter table if exists cases add column if not exists is_demo boolean not null default false`;
  await q`alter table if exists orders add column if not exists is_demo boolean not null default false`;
  await q`alter table if exists orders add column if not exists is_mine boolean not null default false`;
  await q`update orders set is_mine = true, is_demo = false
           where is_demo and reference_code not like 'DEMO%'`;

  await q`alter table if exists cases add column if not exists messages_read_at timestamptz`;
  await q`alter table if exists cases add column if not exists blocked_at timestamptz`;
  await q`alter table if exists cases add column if not exists blocked_until timestamptz`;
  await q`alter table if exists cases add column if not exists blocker_encrypted text`;

  await q`alter table if exists cases add column if not exists closed_at timestamptz`;

  await q`alter table if exists orders add column if not exists case_id bigint references cases (id)`;
  await q`create index if not exists orders_case_idx on orders (case_id)`;

  await q`
    create table if not exists case_events (
      id               bigserial   primary key,
      order_id         bigint      not null references orders (id) on delete cascade,
      kind             text        not null,
      detail_encrypted text,
      created_at       timestamptz not null default now()
    )
  `;
  await q`create index if not exists case_events_order_idx on case_events (order_id, created_at desc)`;
  await q`alter table if exists case_events add column if not exists case_id bigint references cases (id)`;
  await q`create index if not exists case_events_case_idx on case_events (case_id, created_at desc)`;

  await q`alter table if exists orders add column if not exists first_customer_at timestamptz`;

  await workTables(q);

  await q`
    create table if not exists calls (
      id                   bigserial   primary key,
      order_id             bigint      not null references orders (id) on delete cascade,
      kind                 text        not null default 'intake',
      call_id              text        unique,
      transcript_encrypted text,
      summary_encrypted    text,
      started_at           timestamptz not null default now(),
      ended_at             timestamptz,
      seconds              integer
    )
  `;
  await q`create index if not exists calls_order_idx on calls (order_id, started_at desc)`;
  await q`create index if not exists calls_transcript_idx on calls (order_id) where transcript_encrypted is not null`;

  await q`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'orders' and column_name = 'transcript_encrypted'
      ) then
        insert into calls (order_id, kind, call_id, transcript_encrypted, summary_encrypted,
                           started_at, ended_at, seconds)
        select o.id, 'intake', o.call_id, o.transcript_encrypted, o.call_summary_encrypted,
               coalesce(o.first_started_at, o.created_at), o.call_ended_at, o.call_seconds
          from orders o
         where o.call_id is not null
           and not exists (select 1 from calls c where c.call_id = o.call_id);
      end if;
    end $$;
  `;
  await q`alter table if exists orders drop column if exists call_id`;
  await q`alter table if exists orders drop column if exists transcript_encrypted`;
  await q`alter table if exists orders drop column if exists call_summary_encrypted`;
  await q`alter table if exists orders drop column if exists call_ended_at`;
  await q`alter table if exists orders drop column if exists call_seconds`;

  await q`
    create table if not exists messages (
      id             bigserial   primary key,
      account_id     text        not null,
      author         text        not null,
      body_encrypted text        not null,
      created_at     timestamptz not null default now()
    )
  `;
  await q`create index if not exists messages_account_idx on messages (account_id, created_at)`;

  await q`
    create table if not exists rate_limits (
      bucket       text        primary key,
      hits         integer     not null default 0,
      window_start timestamptz not null default now()
    )
  `;

  await q`
    create table if not exists settings (
      name       text        primary key,
      value      text        not null,
      changed_at timestamptz not null default now()
    )
  `;

  await q`
    create table if not exists drafts (
      id                bigserial   primary key,
      order_id          bigint      not null references orders (id) on delete cascade,
      slot              text        not null,
      model             text        not null,
      prompt_tokens     integer,
      completion_tokens integer,
      seconds           integer,
      created_at        timestamptz not null default now()
    )
  `;
  await q`create index if not exists drafts_order_idx on drafts (order_id, created_at)`;

  await q`
    create table if not exists spend (
      id           bigserial   primary key,
      at           timestamptz not null default now(),
      kind         text        not null,
      amount_cents bigint,
      seconds      integer,
      was_demo     boolean     not null default false,
      order_id     bigint      references orders (id) on delete set null,
      source       text,
      created_at   timestamptz not null default now()
    )
  `;
  await q`create index if not exists spend_at_idx on spend (at)`;
  await q`create unique index if not exists spend_source_idx on spend (source)`;
  await q`update spend set amount_cents = round(amount_cents / 100.0),
                           source = 'voice:' || substr(source, 6)
           where kind = 'call' and source like 'call:%'`;

  await q`
    create table if not exists cost_lines (
      id             bigserial   primary key,
      name           text        not null,
      amount_cents   bigint      not null,
      share_percent  integer     not null default 100,
      every          text        not null default 'month',
      note           text,
      created_at     timestamptz not null default now()
    )
  `;
  await q`alter table if exists cost_lines drop column if exists is_demo`;
  await q`alter table if exists cost_lines add column if not exists order_id bigint
          references orders (id) on delete cascade`;
  await q`create index if not exists cost_lines_every_idx on cost_lines (every)`;
  await q`create index if not exists cost_lines_order_idx on cost_lines (order_id)`;

  await q`alter table if exists drafts add column if not exists job_id text`;
  await q`alter table if exists drafts add column if not exists finished_at timestamptz`;
  await q`alter table if exists drafts add column if not exists gave_up_at timestamptz`;
  await q`update drafts set finished_at = created_at where finished_at is null and job_id is null`;
  await q`create index if not exists drafts_unfinished_idx on drafts (order_id, created_at)
          where finished_at is null and gave_up_at is null`;
  await q`alter table if exists drafts add column if not exists kind text`;
  await q`alter table if exists drafts add column if not exists failure text`;
  await q`
    create table if not exists ai_checks (
      id bigserial primary key,
      run_at timestamptz not null,
      button text not null,
      order_id bigint references orders (id) on delete cascade,
      ok boolean not null,
      seconds integer,
      said_encrypted text,
      created_at timestamptz not null default now()
    )
  `;
  await q`create index if not exists ai_checks_run_idx on ai_checks (run_at)`;
  await q`
    create table if not exists draft_jobs (
      draft_id          bigint      primary key references drafts (id) on delete cascade,
      context_encrypted text,
      result_encrypted  text,
      ready_at          timestamptz,
      used_at           timestamptz,
      created_at        timestamptz not null default now()
    )
  `;

  await q`alter table if exists calls add column if not exists record_encrypted text`;
  await q`alter table if exists calls add column if not exists record_taken_at timestamptz`;

  await q`
    create table if not exists desk_clock (
      order_id bigint      primary key references orders (id) on delete cascade,
      at       timestamptz not null
    )
  `;
  await q`
    create table if not exists step_times (
      id       bigserial   primary key,
      order_id bigint      not null references orders (id) on delete cascade,
      step     text        not null,
      seconds  integer     not null,
      at       timestamptz not null default now()
    )
  `;
  await q`create index if not exists step_times_at_idx on step_times (at)`;

  await q`
    create table if not exists trades (
      id           text        primary key,
      title        text        not null,
      sector_id    text        not null,
      sector       text        not null,
      sector_order integer     not null default 0,
      title_order  integer     not null default 0,
      active       boolean     not null default true,
      is_demo      boolean     not null default false,
      refreshed_at timestamptz not null default now()
    )
  `;
  await q`alter table if exists orders add column if not exists trade_id text`;
  await q`alter table if exists cases add column if not exists directory_profile_encrypted text`;
  await q`create index if not exists orders_trade_idx on orders (trade_id) where trade_id is not null`;
  await skillTables(q);

  await q`
    insert into cases (account_id)
    select distinct client_account_id from orders where client_account_id is not null
    on conflict (account_id) do nothing
  `;
  await q`
    update orders o set case_id = c.id from cases c
     where o.client_account_id = c.account_id and o.case_id is null
  `;
  await q`
    update case_events e set case_id = o.case_id from orders o
     where e.order_id = o.id and e.case_id is null and o.case_id is not null
  `;
  await q`
    update plans p set case_id = o.case_id from orders o
     where p.order_id = o.id and p.case_id is null and o.case_id is not null
  `;
  await q`
    update introductions i set a_case_id = o.case_id from orders o
     where i.a_order_id = o.id and i.a_case_id is null and o.case_id is not null
  `;
  await q`
    update introductions i set b_case_id = o.case_id from orders o
     where i.b_order_id = o.id and i.b_case_id is null and o.case_id is not null
  `;
  await q`
    update cases c set first_customer_at = x.at
      from (select case_id, max(first_customer_at) as at from orders
             where case_id is not null and first_customer_at is not null
             group by case_id) x
     where c.id = x.case_id and c.first_customer_at is null
  `;

  await q`
    update plans set in_force = false
     where in_force and case_id is not null
       and id <> (select p2.id from plans p2
                   where p2.case_id = plans.case_id and p2.in_force
                   order by p2.created_at desc, p2.id desc limit 1)
  `;
  await q`
    create unique index if not exists plans_in_force_case_idx
      on plans (case_id) where in_force and case_id is not null
  `;

  await q`alter table if exists orders drop column if exists first_customer_at`;

  const { backfillSpend } = await import('./spend.js');
  await backfillSpend();
  await questionTables(q);
  await roadmapTables(q);
  await clientTables(q);
  await activityTables(q);
  await strategyTables(q);

  ready = true;
}

export async function caseForAccount(accountId) {
  const rows = await sql()`
    insert into cases (account_id) values (${accountId})
    on conflict (account_id) do update set account_id = excluded.account_id
    returning id
  `;
  return Number(rows[0].id);
}

export async function findByClaimTokenHash(hash) {
  const rows = await sql()`
    select id, card_amount_cents, payment_method, reference_code, status, reject_reason,
           session_starts, first_started_at, created_at, decided_at, client_account_id,
           recommendations_written_at
      from orders
     where claim_token_hash = ${hash}
     limit 1
  `;
  return rows[0] || null;
}
