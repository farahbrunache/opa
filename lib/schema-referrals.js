export async function referralTables(q) {
  await q`alter table if exists cases add column if not exists referral_code text`;
  await q`create unique index if not exists cases_referral_code_idx on cases (referral_code)
            where referral_code is not null`;

  await q`alter table if exists orders add column if not exists from_code text`;
  await q`create index if not exists orders_from_code_idx on orders (from_code) where from_code is not null`;

  await q`alter table if exists orders add column if not exists brought_by text`;
  await q`alter table if exists orders
            add column if not exists brought_by_order_id bigint references orders (id) on delete set null`;

  await q`alter table if exists orders add column if not exists flagged_at timestamptz`;
  await q`alter table if exists orders add column if not exists flag_why_encrypted text`;
}
