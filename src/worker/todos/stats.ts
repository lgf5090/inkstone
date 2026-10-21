/**
 * The statistics the to-do app reports, and the reads that feed them.
 *
 * The day columns (`completed_on` / `created_on`) are stored as the account's calendar day precisely so
 * this module never derives a day from a UTC offset: a fixed offset drifts across DST and files work
 * under the wrong date, which would corrupt every trend and streak. A range is therefore a pair of
 * `YYYY-MM-DD` strings compared lexically, half-open at the end (`to`'s next day), and the only timezone
 * work left is turning `completed_at` into a weekday and an hour for the heatmaps.
 *
 * The SQL lives here rather than in `routes/todos.ts` because `tests/worker-layering.test.ts` counts
 * every `.prepare(` under the route directory. Five statements feed one answer — finished rows, created
 * rows grouped by day, open rows, list names, and tag counts — so the count is a constant whatever the
 * range holds; everything else is a pure function over those rows.
 */
import { getZonedParts, isValidCalendarDate } from '@shared/assistant-schedule'
import { TASK_LIVE_PREDICATE, taskLive } from '../assistant/store'
import type {
  TaskPriority,
  TaskStatsBacklog,
  TaskStatsBucket,
  TaskStatsDistributions,
  TaskStatsLeadTime,
  TaskStatsPoint,
  TaskStatsSummary,
  TodoStats,
} from '@shared/todos/model'

const DAY_MS = 86_400_000
const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The order priorities are listed in: the same low-to-urgent ladder the task form shows. */
const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent']

/** A row the finished-task read returns. */
export interface StatsCompletedRow {
  id: string
  listId: string | null
  priority: string
  dueAt: number | null
  createdAt: number
  completedAt: number
  completedOn: string
}

/** One day's creation count, already grouped by SQL. */
export interface StatsCreatedRow {
  day: string
  count: number
}

export interface StatsOpenRow {
  dueAt: number | null
  createdAt: number
}

export interface StatsListRow {
  id: string
  name: string
}

export interface StatsTagRow {
  id: string
  name: string
  count: number
}

/** Everything `computeTodoStats` needs, so the arithmetic can be tested without a database. */
export interface StatsInput {
  completed: StatsCompletedRow[]
  created: StatsCreatedRow[]
  open: StatsOpenRow[]
  lists: StatsListRow[]
  tags: StatsTagRow[]
  from: string
  to: string
  bucket: TaskStatsBucket
  timezone: string
  now: number
}

export interface TodoStatsQuery {
  from: string
  to: string
  bucket: TaskStatsBucket
  timezone: string
  now: number
}

/** Whether a value is a real calendar date in the `YYYY-MM-DD` shape the day columns store. */
export function isStatsDay(value: string): boolean {
  const match = LOCAL_DAY.exec(value)
  if (!match) return false
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** A `YYYY-MM-DD` day plus a whole number of days, in the calendar and not in a zone. */
export function addDays(day: string, days: number): string {
  return utcToDay(dayToUtc(day) + days * DAY_MS)
}

function dayToUtc(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year!, month! - 1, date!)
}

function utcToDay(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10)
}

/** The first day of the bucket a day belongs to: itself, its Monday, or the first of its month. */
function bucketStart(day: string, bucket: TaskStatsBucket): string {
  if (bucket === 'day') return day
  if (bucket === 'month') return `${day.slice(0, 7)}-01`
  const utc = dayToUtc(day)
  const weekday = new Date(utc).getUTCDay()
  return utcToDay(utc - ((weekday + 6) % 7) * DAY_MS)
}

/** Every bucket start the range touches, in order. The first and last may be partial buckets. */
function bucketStarts(from: string, to: string, bucket: TaskStatsBucket): string[] {
  const starts: string[] = []
  const end = dayToUtc(to)
  let cursor = dayToUtc(bucketStart(from, bucket))
  if (bucket === 'month') {
    while (cursor <= end) {
      starts.push(utcToDay(cursor))
      const date = new Date(cursor)
      cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
    }
    return starts
  }
  const step = bucket === 'week' ? 7 * DAY_MS : DAY_MS
  while (cursor <= end) {
    starts.push(utcToDay(cursor))
    cursor += step
  }
  return starts
}

/**
 * A percentile with linear interpolation: P50 of an even count is the average of the two middle
 * values, and P90 sits between the two values it falls between rather than snapping to one of them.
 */
function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 1) return sorted[0]!
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower))
}

function average(values: readonly number[]): number | null {
  if (!values.length) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function priorityOf(value: string): TaskPriority {
  return value === 'low' || value === 'high' || value === 'urgent' ? value : 'medium'
}

/**
 * Current and longest runs of consecutive completion days.
 *
 * Only days that hold a completion exist in the set, so an empty day inside the range is a gap and
 * ends a run. The current run is anchored at the range's last day; when that day is still empty (the
 * common case for "today") the day before it is used instead, because a day that has not finished yet
 * has not broken the streak either.
 */
function streaks(days: Set<string>, to: string): { current: number; longest: number } {
  let longest = 0
  let run = 0
  let previous: string | null = null
  for (const day of [...days].sort()) {
    run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = day
  }
  let cursor: string | null = days.has(to) ? to : days.has(addDays(to, -1)) ? addDays(to, -1) : null
  let current = 0
  while (cursor !== null && days.has(cursor)) {
    current += 1
    cursor = addDays(cursor, -1)
  }
  return { current, longest }
}

/** The whole answer, from rows that were read in the range and the account's zone. */
export function computeTodoStats(input: StatsInput): TodoStats {
  const completed = input.completed.filter((row) => row.completedOn >= input.from && row.completedOn <= input.to)
  const created = input.created.filter((row) => row.day >= input.from && row.day <= input.to)
  const createdTotal = created.reduce((sum, row) => sum + row.count, 0)
  const completedTotal = completed.length
  const openTotal = input.open.length

  const withDue = completed.filter((row) => row.dueAt !== null)
  const onTime = withDue.filter((row) => row.completedAt <= row.dueAt!).length
  const durations = completed.map((row) => row.completedAt - row.createdAt)
  const completionDays = new Set(completed.map((row) => row.completedOn))
  const streak = streaks(completionDays, input.to)

  const summary: TaskStatsSummary = {
    completed: completedTotal,
    created: createdTotal,
    net: completedTotal - createdTotal,
    open: openTotal,
    completionRate: completedTotal + openTotal === 0 ? 0 : completedTotal / (completedTotal + openTotal),
    onTime,
    onTimeDue: withDue.length,
    onTimeRate: withDue.length === 0 ? 0 : onTime / withDue.length,
    medianLeadTimeMs: percentile(durations, 0.5),
    currentStreak: streak.current,
    longestStreak: streak.longest,
    overdue: input.open.filter((row) => row.dueAt !== null && row.dueAt < input.now).length,
  }

  const buckets = bucketStarts(input.from, input.to, input.bucket)
  const completedByBucket = new Map(buckets.map((day) => [day, 0]))
  const createdByBucket = new Map(buckets.map((day) => [day, 0]))
  for (const row of completed) {
    const key = bucketStart(row.completedOn, input.bucket)
    completedByBucket.set(key, (completedByBucket.get(key) ?? 0) + 1)
  }
  for (const row of created) {
    const key = bucketStart(row.day, input.bucket)
    createdByBucket.set(key, (createdByBucket.get(key) ?? 0) + 1)
  }
  const series: TaskStatsPoint[] = buckets.map((day) => ({
    day,
    completed: completedByBucket.get(day) ?? 0,
    created: createdByBucket.get(day) ?? 0,
  }))

  const byPriority = PRIORITIES.map((priority) => {
    const count = completed.filter((row) => priorityOf(row.priority) === priority).length
    return {
      priority,
      completed: count,
      share: completedTotal === 0 ? 0 : count / completedTotal,
    }
  })

  const listNames = new Map(input.lists.map((list) => [list.id, list.name]))
  const listCounts = new Map<string | null, number>()
  for (const row of completed) listCounts.set(row.listId, (listCounts.get(row.listId) ?? 0) + 1)
  const byList = [...listCounts]
    .map(([id, count]) => ({
      id,
      // The inbox has no row to name it, and the server does not invent a translated one.
      name: id === null ? null : listNames.get(id) ?? null,
      completed: count,
      share: completedTotal === 0 ? 0 : count / completedTotal,
    }))
    .sort((left, right) => right.completed - left.completed
      || (left.name ?? '').localeCompare(right.name ?? '')
      || String(left.id).localeCompare(String(right.id)))

  const byTag = input.tags
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      completed: tag.count,
      share: completedTotal === 0 ? 0 : tag.count / completedTotal,
    }))
    .sort((left, right) => right.completed - left.completed || left.name.localeCompare(right.name))

  const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({ weekday, completed: 0 }))
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, completed: 0 }))
  for (const row of completed) {
    // The weekday and hour are the one place a zone still matters: the stored day cannot tell 09:00
    // from 21:00, and the heatmap is about the clock the reader actually finished at.
    const parts = getZonedParts(new Date(row.completedAt), input.timezone)
    byWeekday[parts.weekday]!.completed += 1
    byHour[parts.hour]!.completed += 1
  }

  const distributions: TaskStatsDistributions = { byList, byTag, byPriority, byWeekday, byHour }

  const leadTime: TaskStatsLeadTime = {
    p50: percentile(durations, 0.5),
    p90: percentile(durations, 0.9),
    byPriority: PRIORITIES.map((priority) => {
      const values = completed
        .filter((row) => priorityOf(row.priority) === priority)
        .map((row) => row.completedAt - row.createdAt)
      return { priority, count: values.length, averageMs: average(values) }
    }),
  }

  const backlog: TaskStatsBacklog = { under7: 0, days7to30: 0, over30: 0, none: 0 }
  for (const row of input.open) {
    const anchor = row.dueAt ?? (row.createdAt > 0 ? row.createdAt : null)
    if (anchor === null) {
      backlog.none += 1
      continue
    }
    const age = input.now - anchor
    if (age < 7 * DAY_MS) backlog.under7 += 1
    else if (age <= 30 * DAY_MS) backlog.days7to30 += 1
    else backlog.over30 += 1
  }

  return {
    range: { from: input.from, to: input.to, bucket: input.bucket, timezone: input.timezone },
    summary,
    series,
    distributions,
    leadTime,
    backlog,
  }
}

type CompletedDbRow = {
  id: string
  list_id: string | null
  priority: string
  due_at: number | null
  created_at: number
  completed_at: number
  completed_on: string
}

type CreatedDbRow = { day: string; n: number }
type OpenDbRow = { due_at: number | null; created_at: number }
type ListDbRow = { id: string; name: string }
type TagDbRow = { id: string; name: string; n: number }

/**
 * Reads one range and answers the whole statistics object.
 *
 * Five statements, none of which depends on how many rows the range holds. The finished rows are read
 * as rows rather than pre-aggregated because a median, a weekday/hour heatmap and an on-time comparison
 * all need each completion's own timestamps; grouping those in SQL would still need the raw rows for
 * the rest, and running both would be a sixth statement for no gain.
 */
export async function loadTodoStats(db: D1Database, userId: string, query: TodoStatsQuery): Promise<TodoStats> {
  const end = addDays(query.to, 1)
  const [completed, created, open, lists, tags] = await Promise.all([
    db.prepare(
      `SELECT id, list_id, priority, due_at, created_at, completed_at, completed_on
         FROM todos_tasks
        WHERE user_id = ?1 AND status = 'done' AND ${TASK_LIVE_PREDICATE}
          AND completed_on IS NOT NULL AND completed_on >= ?2 AND completed_on < ?3`,
    ).bind(userId, query.from, end).all<CompletedDbRow>(),
    db.prepare(
      `SELECT created_on AS day, COUNT(*) AS n
         FROM todos_tasks
        WHERE user_id = ?1 AND ${TASK_LIVE_PREDICATE}
          AND created_on IS NOT NULL AND created_on >= ?2 AND created_on < ?3
        GROUP BY created_on`,
    ).bind(userId, query.from, end).all<CreatedDbRow>(),
    db.prepare(
      `SELECT due_at, created_at FROM todos_tasks
        WHERE user_id = ?1 AND status != 'done' AND ${TASK_LIVE_PREDICATE}`,
    ).bind(userId).all<OpenDbRow>(),
    db.prepare(
      `SELECT id, name FROM todos_lists WHERE user_id = ?1 ORDER BY position ASC, name COLLATE NOCASE ASC`,
    ).bind(userId).all<ListDbRow>(),
    db.prepare(
      `SELECT t.id AS id, t.name AS name, COUNT(*) AS n
         FROM todos_tag_links l
         JOIN todos_tags t ON t.user_id = l.user_id AND t.id = l.tag_id
         JOIN todos_tasks k ON k.user_id = l.user_id AND k.id = l.task_id
        WHERE l.user_id = ?1 AND k.status = 'done' AND ${taskLive('k')}
          AND k.completed_on IS NOT NULL AND k.completed_on >= ?2 AND k.completed_on < ?3
        GROUP BY t.id, t.name`,
    ).bind(userId, query.from, end).all<TagDbRow>(),
  ])

  return computeTodoStats({
    completed: (completed.results ?? []).map((row) => ({
      id: row.id,
      listId: row.list_id,
      priority: row.priority,
      dueAt: row.due_at === null ? null : Number(row.due_at),
      createdAt: Number(row.created_at),
      completedAt: Number(row.completed_at),
      completedOn: row.completed_on,
    })),
    created: (created.results ?? []).map((row) => ({ day: row.day, count: Number(row.n) })),
    open: (open.results ?? []).map((row) => ({
      dueAt: row.due_at === null ? null : Number(row.due_at),
      createdAt: Number(row.created_at),
    })),
    lists: (lists.results ?? []).map((row) => ({ id: row.id, name: row.name })),
    tags: (tags.results ?? []).map((row) => ({ id: row.id, name: row.name, count: Number(row.n) })),
    from: query.from,
    to: query.to,
    bucket: query.bucket,
    timezone: query.timezone,
    now: query.now,
  })
}
