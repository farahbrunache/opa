import { ensureSchema, sql } from './db.js';
import { requireAdmin } from './auth.js';
import { HttpError, readJson, send } from './http.js';
import { POOL_SETTING } from './desk.js';
import { writeChoice } from './settings.js';

export const WEEK_DAYS = 7;

export const UNDO_HOURS = 24;

export async function approachedNow() {
  const [row] = await sql()`
    with base as (
      select nullif(value, '') as typed, changed_at from settings where name = ${POOL_SETTING}
    )
    select (select typed from base) as typed,
           (select count(*)::int from approach_taps t
             where t.at > coalesce((select changed_at from base), '-infinity'::timestamptz)) as since,
           (select count(*)::int from approach_taps t
             where t.at > now() - make_interval(days => ${WEEK_DAYS})) as week,
           (select max(at) from approach_taps) as last_at
  `;
  const typed = row.typed === null || row.typed === undefined ? null : Number(row.typed);
  const since = Number(row.since || 0);
  return {
    total: typed === null && since === 0 ? null : (typed || 0) + since,
    week: Number(row.week || 0),
    lastAt: row.last_at || null,
  };
}

export async function setPool(req, res) {
  requireAdmin(req);
  await ensureSchema();
  const body = await readJson(req);

  if (body.add !== undefined) {
    if (body.add !== 1) throw new HttpError(400, 'Adding to the approached count goes up by one at a time.');
    const before = await approachedNow();
    if ((before.total || 0) >= 9_999_999) {
      throw new HttpError(400, 'The approached count is at its largest, seven digits.');
    }
    const [tap] = await sql()`insert into approach_taps default values returning id, at`;
    return send(res, 200, { ...(await approachedNow()), tap: { id: Number(tap.id), at: tap.at } });
  }

  if (body.undo !== undefined) {
    const id = Number(body.undo);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Undo needs the number of the tap to take back.');
    const gone = await sql()`
      delete from approach_taps
       where id = ${id} and at > now() - make_interval(hours => ${UNDO_HOURS})
      returning id
    `;
    if (!gone.length) {
      throw new HttpError(404, `No tap to take back. A tap can be undone for ${UNDO_HOURS} hours, `
        + 'and this one is older or already gone. Use Fix count to set the total.');
    }
    return send(res, 200, await approachedNow());
  }

  const given = String(body.pool ?? '').trim();
  if (given !== '' && !/^\d{1,7}$/.test(given)) {
    throw new HttpError(400, 'The number approached has to be a plain count, digits '
      + 'only, up to seven of them. Leave it empty to take the figure off the screen.');
  }
  await writeChoice(POOL_SETTING, given);
  send(res, 200, await approachedNow());
}
