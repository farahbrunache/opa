import { sql } from './db.js';
import { keyedHash } from './crypto.js';

export async function readChoice(name) {
  const rows = await sql()`select value from settings where name = ${name}`;
  return rows.length ? rows[0].value : null;
}

export async function writeChoice(name, value) {
  await sql()`
    insert into settings (name, value, changed_at) values (${name}, ${value}, now())
    on conflict (name) do update set value = excluded.value, changed_at = now()
  `;
}

export async function underLimit(name, callerHash, max, windowSeconds) {
  const q = sql();
  const bucket = keyedHash(`${name}:${callerHash}`);
  const rows = await q`
    insert into rate_limits (bucket, hits, window_start)
    values (${bucket}, 1, now())
    on conflict (bucket) do update set
      hits = case
        when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
        then 1
        else rate_limits.hits + 1
      end,
      window_start = case
        when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
        then now()
        else rate_limits.window_start
      end
    returning hits
  `;
  return Number(rows[0]?.hits ?? 0) <= max;
}

