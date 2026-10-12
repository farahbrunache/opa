import { chapterTables } from './schema-chapters.js';
import { referralTables } from './schema-referrals.js';

export async function clientTables(q) {
  await q`alter table if exists messages add column if not exists from_template boolean not null default false`;
  await q`alter table if exists messages add column if not exists order_id bigint`;
  await q`alter table if exists messages alter column account_id drop not null`;
  await q`create index if not exists messages_order_idx on messages (order_id, created_at) where account_id is null`;

  await q`alter table if exists orders add column if not exists steps_posted_hash text`;

  await chapterTables(q);
  await referralTables(q);
}
