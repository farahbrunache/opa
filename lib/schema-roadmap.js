export async function roadmapTables(q) {
  await q`
    do $$
    begin
      if not exists (
        select 1 from information_schema.columns
        where table_name = 'milestones' and column_name = 'shown_at'
      ) then
        alter table milestones add column shown_at timestamptz;
        update milestones set shown_at = created_at;
      end if;
      if not exists (
        select 1 from information_schema.columns
        where table_name = 'action_items' and column_name = 'shown_at'
      ) then
        alter table action_items add column shown_at timestamptz;
        update action_items set shown_at = created_at;
      end if;
    end $$;
  `;

  await q`
    create table if not exists roadmap_drafts (
      id                bigserial   primary key,
      draft_id          bigint      not null references drafts (id) on delete cascade,
      order_id          bigint      not null references orders (id) on delete cascade,
      content_encrypted text        not null,
      created_at        timestamptz not null default now()
    )
  `;
  await q`create index if not exists roadmap_drafts_order_idx on roadmap_drafts (order_id, created_at desc)`;
}
