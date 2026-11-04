/**
 * Per-day activity counts, aggregated by D1 rather than in the browser.
 *
 * The alternative — sending every row of a year — would move thousands of records and megabytes of
 * JSON so a client could count them, and it would grow with the account. Each kind is one grouped
 * query instead, run as one batch, so a year costs eight statements and not eight round trips.
 *
 * The day a row belongs to is the account's own calendar day, the same day the to-do app files its
 * `created_on` / `completed_on` strings with. Rows that already store that string are grouped on it;
 * rows that store epoch milliseconds are grouped after shifting by the account's UTC offset. The
 * offset is taken at the middle of the requested window, so a zone with daylight saving is off by an
 * hour at the two ends of a transition weekend — a documented approximation, and the reason a
 * 366-day window is the ceiling.
 */

import type { ActivityKind, HeatmapDay } from '@shared/activity/heatmap'
import { timeZoneOffsetMs } from '@shared/assistant-schedule'

const DAY_MS = 86_400_000

interface KindQuery {
  kind: ActivityKind
  /** The statement, with `?1` the account, `?2`/`?3` the bounds and `?4` the offset modifier. */
  sql: string
  /** `day` column: an epoch column to shift, or a stored `YYYY-MM-DD` string to compare. */
  mode: 'epoch' | 'storedDay'
  /** The epoch unit this table writes. Most columns are milliseconds; memos wrote seconds. */
  unit: 'ms' | 's'
  table: string
  column: string
}

/**
 * The kinds and the column each one counts.
 *
 * Email is deliberately absent: its messages live in a per-mailbox Durable Object's own SQLite, not
 * in the account database this query runs against, so counting them here would need a second
 * round trip per mailbox account and a fan-out this endpoint does not do. A kind without a table is
 * not offered at all rather than shown as an always-empty row.
 */
export const KIND_QUERIES: readonly KindQuery[] = [
  // NOTE: the index is `idx_notes_user_updated`, which is ordered by updated_at; created_at has no
  // index of its own, so this scan is bounded by the year window rather than the whole table.
  { kind: 'notes', table: 'notes', column: 'created_at', mode: 'epoch', unit: 'ms', sql: 'SELECT date(created_at / 1000, \'unixepoch\', ?4) AS day, COUNT(*) AS total FROM notes WHERE user_id = ?1 AND deleted_at IS NULL AND created_at >= ?2 AND created_at < ?3 GROUP BY day' },
  { kind: 'todos', table: 'todos_tasks', column: 'created_on', mode: 'storedDay', unit: 'ms', sql: 'SELECT created_on AS day, COUNT(*) AS total FROM todos_tasks WHERE user_id = ?1 AND created_on BETWEEN ?2 AND ?3 GROUP BY day' },
  { kind: 'todos_completed', table: 'todos_tasks', column: 'completed_on', mode: 'storedDay', unit: 'ms', sql: 'SELECT completed_on AS day, COUNT(*) AS total FROM todos_tasks WHERE user_id = ?1 AND completed_on BETWEEN ?2 AND ?3 GROUP BY day' },
  { kind: 'memos', table: 'memos_items', column: 'created_at', mode: 'epoch', unit: 's', sql: 'SELECT date(created_at, \'unixepoch\', ?4) AS day, COUNT(*) AS total FROM memos_items WHERE user_id = ?1 AND created_at >= ?2 AND created_at < ?3 GROUP BY day' },
  { kind: 'events', table: 'calendar_events', column: 'created_at', mode: 'epoch', unit: 'ms', sql: 'SELECT date(created_at / 1000, \'unixepoch\', ?4) AS day, COUNT(*) AS total FROM calendar_events WHERE user_id = ?1 AND created_at >= ?2 AND created_at < ?3 GROUP BY day' },
  { kind: 'uploads', table: 'CloudDrive_files', column: 'uploaded_at', mode: 'epoch', unit: 'ms', sql: 'SELECT date(uploaded_at / 1000, \'unixepoch\', ?4) AS day, COUNT(*) AS total FROM CloudDrive_files WHERE user_id = ?1 AND uploaded_at >= ?2 AND uploaded_at < ?3 GROUP BY day' },
  { kind: 'music', table: 'music_history', column: 'played_at', mode: 'epoch', unit: 'ms', sql: 'SELECT date(played_at / 1000, \'unixepoch\', ?4) AS day, COUNT(*) AS total FROM music_history WHERE user_id = ?1 AND played_at >= ?2 AND played_at < ?3 GROUP BY day' },
  // A conversation is counted once per thing the reader said, not once per answer as well.
  { kind: 'chat', table: 'chat_messages', column: 'created_at', mode: 'epoch', unit: 'ms', sql: "SELECT date(created_at / 1000, 'unixepoch', ?4) AS day, COUNT(*) AS total FROM chat_messages WHERE user_id = ?1 AND role = 'user' AND created_at >= ?2 AND created_at < ?3 GROUP BY day" },
]

export interface CountResultRow {
  day: string | null
  total: number
}

/**
 * Fold the per-kind grouped rows into one entry per day.
 *
 * Pulled out of the query so a test can pin the two rules that matter without a database: a day with
 * a count of zero is dropped rather than emitted, and a `day` that is not a real `YYYY-MM-DD` (a
 * NULL, or a stored `0000-00-00`) is dropped rather than painted at an invented cell.
 */
export function mergeCountRows(
  kinds: ActivityKind[],
  results: ReadonlyArray<ReadonlyArray<CountResultRow>>,
): HeatmapDay[] {
  const byDay = new Map<string, Partial<Record<ActivityKind, number>>>()
  kinds.forEach((kind, index) => {
    for (const row of results[index] ?? []) {
      if (!row.day || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) continue
      if (!Number.isFinite(row.total) || row.total <= 0) continue
      const counts = byDay.get(row.day) ?? {}
      counts[kind] = row.total
      byDay.set(row.day, counts)
    }
  })
  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, counts]) => ({ date, counts }))
}

/** The modifier D1 applies to an epoch before grouping it into a local day. */
function offsetModifier(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  return `${sign}${Math.abs(minutes)} minutes`
}

/** Local midnight of `day`, as an instant, using an offset that is assumed constant across the window. */
function localMidnight(day: string, offsetMs: number): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetMs
}

export interface HeatmapCountsOptions {
  userId: string
  kinds: ActivityKind[]
  from: string
  to: string
  timeZone: string
}

/**
 * The counts, one entry per day per kind that has rows.
 *
 * Days with nothing are omitted: an empty year answers with `[]`, and the client draws the zeroes
 * itself, which is also what keeps the payload at a few kilobytes for a busy account.
 */
export async function heatmapCounts(db: D1Database, options: HeatmapCountsOptions): Promise<HeatmapDay[]> {
  const fromMs = Date.parse(`${options.from}T00:00:00Z`)
  const toMs = Date.parse(`${options.to}T00:00:00Z`)
  const midpoint = fromMs + Math.round((toMs - fromMs) / 2)
  const offsetMs = timeZoneOffsetMs(midpoint, options.timeZone)
  const modifier = offsetModifier(Math.round(offsetMs / 60_000))
  const fromInstant = localMidnight(options.from, offsetMs)
  const toInstant = localMidnight(options.to, offsetMs) + DAY_MS

  const selected = KIND_QUERIES.filter(query => options.kinds.includes(query.kind))
  if (selected.length === 0) return []

  const statements = selected.map((query) => {
    if (query.mode === 'storedDay') {
      return db.prepare(query.sql).bind(options.userId, options.from, options.to)
    }
    // A table that writes seconds is bound in seconds: mixing the two would shift every row by three
    // orders of magnitude and count nothing at all.
    const from = query.unit === 's' ? Math.floor(fromInstant / 1000) : fromInstant
    const to = query.unit === 's' ? Math.floor(toInstant / 1000) : toInstant
    return db.prepare(query.sql).bind(options.userId, from, to, modifier)
  })
  const results = await db.batch<CountResultRow>(statements)

  return mergeCountRows(selected.map(query => query.kind), results.map(result => result.results ?? []))
}

/**
 * A short-lived cache of the last few answers.
 *
 * The grid asks again on every filter change and on every tab focus, and the underlying rows change
 * at human speed; a minute of reuse removes the repeat without ever serving a day-old answer. The key
 * carries the account, the window and the kinds, so two readers or two filters cannot collide.
 */
const CACHE_LIMIT = 40
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; days: HeatmapDay[] }>()

export async function heatmapCountsCached(db: D1Database, options: HeatmapCountsOptions, now = Date.now()): Promise<HeatmapDay[]> {
  const key = [options.userId, options.from, options.to, [...options.kinds].sort().join(',')].join('|')
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.days
  const days = await heatmapCounts(db, options)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, { at: now, days })
  return days
}
