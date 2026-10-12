export async function roadmapTables(q) {
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
