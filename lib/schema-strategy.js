export async function strategyTables(q) {
  await q`
    create table if not exists strategies (
      id                  bigserial   primary key,
      order_id            bigint      not null references orders (id) on delete cascade,
      case_id             bigint      references cases (id) on delete cascade,
      version             integer     not null,
      body_encrypted      text        not null,
      takeaways_encrypted text        not null,
      changed_encrypted   text,
      created_at          timestamptz not null default now()
    )
  `;
  await q`create index if not exists strategies_case_idx on strategies (case_id, version desc)`;
  await q`create index if not exists strategies_order_idx on strategies (order_id, version desc)`;
  await q`
    update strategies s set case_id = o.case_id from orders o
     where s.order_id = o.id and s.case_id is null and o.case_id is not null
  `;

  await q`drop table if exists recaps`;
  await q`alter table if exists calls drop column if exists fields_encrypted`;
  await q`alter table if exists chapters drop column if exists fields_encrypted`;
  await q`
    delete from settings
     where name in ('prompt:recap', 'prompt:fields', 'slot:recap', 'slot:fields')
  `;
}
