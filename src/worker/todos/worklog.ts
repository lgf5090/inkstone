/**
 * The worklog: the hours the ledger holds, read over a range and grouped three ways.
 *
 * It is a separate module from `todos/stats.ts` on purpose. The statistics answer "how did the plate
 * move" — counts of rows, derived from the task table and its event history — while this answers "where
 * did the time go", which is a sum over `todos_time_entries`. The two already disagree about their
 * windows in a way that has to stay visible: an account can hold forty hours of tracked work in a week
 * whose tasks were mostly created earlier and finished later, and folding that into the flow replay
 * would make one number answer two questions. The screen shows both, the reads stay separate.
 *
 * Nothing here is stored. The plan's D3 rule says the worklog is derived, because a second table of
 * hours is a second ledger that has to be kept in step with the first — and the day a span belongs to
 * is already on the row (`todos_time_entries.day`), written by the same statement that closed it.
 */

import { eachDay, isStatsDay } from './stats'
import { SQL_TASK_DONE } from '@shared/todos/status'
import { WORKLOG_DIMENSIONS, type Worklog, type WorklogDimension } from '@shared/todos/model'

interface TrackedRow {
  n: number
  ms: number | null
}

interface GroupRow {
  key: string
  label: string
  n: number
}

interface EstimateRow {
  id: string
  time_estimate_ms: number | null
  tracked: number | null
}

/**
 * One closed span, as the alias the statement reads its entries from.
 *
 * Qualified because both tables in the join carry a `start_at` — the task's is the lead time before a
 * due date, the entry's is the moment the timer began — and an unqualified one is an error SQLite
 * refuses to guess about. An open timer is not yet hours anybody spent, so every read also insists the
 * span is closed.
 */
function tracked(alias: string): string {
  return `${alias}.end_at - ${alias}.start_at`
}
const LIVE_TASK = 'deleted_at IS NULL'

/**
 * The SQL for one grouping.
 *
 * Three joins, three answers: a task's list, its tags (many rows per task, which is why the tag case
 * groups on the tag's id rather than the task's), and the task itself. Each keeps the other two out, so
 * a row counted under one tag is not also counted under another in the same reading.
 */
function groupQuery(dimension: WorklogDimension): { sql: string } {
  const window = `e.day >= ?2 AND e.day <= ?3 AND e.end_at IS NOT NULL AND t.user_id = ?1 AND t.${LIVE_TASK}`
  if (dimension === 'list')
    return {
      sql: `SELECT COALESCE(l.id, '') AS key, COALESCE(l.name, '') AS label, SUM(${tracked('e')}) AS n
              FROM todos_time_entries e
              JOIN todos_tasks t ON t.user_id = e.user_id AND t.id = e.task_id
              LEFT JOIN todos_lists l ON l.user_id = t.user_id AND l.id = t.list_id
             WHERE ${window}
             GROUP BY key, label
             ORDER BY n DESC`,
    }
  if (dimension === 'task')
    return {
      sql: `SELECT t.id AS key, t.title AS label, SUM(${tracked('e')}) AS n
              FROM todos_time_entries e
              JOIN todos_tasks t ON t.user_id = e.user_id AND t.id = e.task_id
             WHERE ${window}
             GROUP BY key, label
             ORDER BY n DESC`,
    }
  return {
    sql: `SELECT g.id AS key, g.name AS label, SUM(${tracked('e')}) AS n
            FROM todos_time_entries e
            JOIN todos_tasks t ON t.user_id = e.user_id AND t.id = e.task_id
            JOIN todos_tag_links k ON k.user_id = e.user_id AND k.task_id = e.task_id
            JOIN todos_tags g ON g.user_id = k.user_id AND g.id = k.tag_id
           WHERE ${window}
           GROUP BY key, label
           ORDER BY n DESC`,
  }
}

/**
 * The hours the ledger holds for one window, and how many closed spans they came from.
 *
 * Exported because two screens ask for exactly this number and must not be able to disagree about it:
 * the statistics' worklog section, and the end-of-day pass, which reads it against the length the
 * account planned for a day. `loadWorklog` takes its own totals from here, so there is one statement
 * for "what time was spent" rather than one per caller.
 *
 * The two rules that make the number mean anything live in this one statement: only closed spans count
 * (a timer nobody has stopped is not yet a fact), and a row the trash took away is out.
 */
export async function loadTrackedTotals(
  db: D1Database,
  userId: string,
  range: { from: string, to: string },
): Promise<{ entryCount: number, totalMs: number }> {
  if (!isStatsDay(range.from) || !isStatsDay(range.to))
    throw new Error('A tracked total window is a pair of YYYY-MM-DD days')
  const row = await db.prepare(
    `SELECT COUNT(*) AS n, SUM(${tracked('e')}) AS ms
       FROM todos_time_entries e
       JOIN todos_tasks t ON t.user_id = e.user_id AND t.id = e.task_id
      WHERE e.user_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.end_at IS NOT NULL AND t.${LIVE_TASK}`,
  ).bind(userId, range.from, range.to).first<TrackedRow>()
  return { entryCount: Number(row?.n ?? 0), totalMs: Number(row?.ms ?? 0) }
}

/**
 * The worklog for one range, read from the ledger the account already holds.
 *
 * `from` and `to` are account-zone days the caller validated; `limit` caps how many groups come back,
 * because an account with three hundred tags has a breakdown nobody reads on one screen and the rest is
 * named in the answer rather than dropped silently.
 */
export async function loadWorklog(
  db: D1Database,
  userId: string,
  query: { from: string, to: string, dimension: WorklogDimension, limit: number },
): Promise<Worklog> {
  const { from, to, dimension, limit } = query
  if (!isStatsDay(from) || !isStatsDay(to) || !WORKLOG_DIMENSIONS.includes(dimension))
    throw new Error('A worklog window is a pair of YYYY-MM-DD days and a known dimension')

  const window = [userId, from, to]
  const perDay = await db.prepare(
    `SELECT e.day AS d, SUM(${tracked('e')}) AS ms
       FROM todos_time_entries e
      WHERE e.user_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.end_at IS NOT NULL
      GROUP BY e.day`,
  ).bind(...window).all<{ d: string; ms: number | null }>()

  const totals = await loadTrackedTotals(db, userId, { from, to })

  const grouped = await db.prepare(groupQuery(dimension).sql)
    .bind(...window).all<GroupRow>()

  // Estimated work that finished in the window, compared against the plan the reader made for it.
  // Both sides are read over the same window: the hours a task spent *here*, not its lifetime total, so
  // a task planned at one hour and worked on across four months is not called over budget in the month
  // it happened to be closed in.
  const estimated = await db.prepare(
    `SELECT t.id, t.time_estimate_ms,
            (SELECT SUM(${tracked('s')}) FROM todos_time_entries s
              WHERE s.user_id = t.user_id AND s.task_id = t.id AND s.end_at IS NOT NULL
                AND s.day >= ?2 AND s.day <= ?3) AS tracked
       FROM todos_tasks t
      WHERE t.user_id = ?1 AND t.${LIVE_TASK} AND ${SQL_TASK_DONE} AND t.completed_on >= ?2 AND t.completed_on <= ?3
        AND t.time_estimate_ms IS NOT NULL`,
  ).bind(...window).all<EstimateRow>()

  const byDay = new Map((perDay.results ?? []).map((row) => [row.d, Number(row.ms ?? 0)]))
  const over = (estimated.results ?? []).filter((row) => Number(row.tracked ?? 0) > Number(row.time_estimate_ms))
  const planned = (estimated.results ?? []).length
  const groups = (grouped.results ?? [])
    .filter((row) => row.label !== '')
    .map((row) => ({ key: row.key, label: row.label, trackedMs: Number(row.n ?? 0) }))

  return {
    range: { from, to, dimension },
    totalMs: totals.totalMs,
    entryCount: totals.entryCount,
    byDay: eachDay(from, to).map((day) => ({ day, trackedMs: byDay.get(day) ?? 0 })),
    byGroup: groups.slice(0, limit),
    truncatedGroups: Math.max(0, groups.length - limit),
    estimatedCount: planned,
    overEstimateCount: over.length,
    // A rate with nothing to divide by is `null`, not 0: an account that estimates nothing would
    // otherwise be told its over-run rate is a perfect zero, which is the opposite of an answer.
    overEstimateRate: planned === 0 ? null : over.length / planned,
  }
}
