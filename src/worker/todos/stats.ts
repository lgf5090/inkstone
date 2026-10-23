/**
 * The statistics the to-do app reports, and the reads that feed them.
 *
 * Three counting rules decide every ratio here, and they are the ones the plan records as D10. They are
 * repeated beside the numbers, on the statistics screen's own sr-only table, and here:
 *
 * 1. `completionRate` is finished over finished-plus-owed. A row the reader abandoned is in neither
 *    half — it was not finished, and it is no longer owed. This denominator is deliberately *not* the
 *    obvious "everything that ever existed", because the rate was published before `cancelled` was a
 *    status, and the week-on-week chip compares it against the previous window's own reading. Growing
 *    the denominator would have made readers who did nothing look like they had regressed.
 * 2. `abandonedRate` is that missing term on its own: abandoned over finished-plus-abandoned-plus-owed.
 *    Giving work up is a fact worth a number, and it gets one that says exactly what it counted.
 * 3. Every time series — `net`, the backlog ages, the streaks, the lead times, the heatmaps, the
 *    per-list, per-tag and per-priority splits — is finished work only. An abandonment says nothing
 *    about when the reader finished something, because they did not; the `completed_on` column an
 *    abandoned row also carries is that row's *end* moment, and reading it as a completion is the
 *    mistake this rule exists to prevent.
 *
 * The day columns (`completed_on` / `created_on`) are stored as the account's calendar day precisely so
 * this module never derives a day from a UTC offset: a fixed offset drifts across DST and files work
 * under the wrong date, which would corrupt every trend and streak. A range is therefore a pair of
 * `YYYY-MM-DD` strings compared lexically, half-open at the end (`to`'s next day), and the only timezone
 * work left is turning `completed_at` into a weekday and an hour for the heatmaps.
 *
 * The SQL lives here rather than in `routes/todos.ts` because `tests/worker-layering.test.ts` counts
 * every `.prepare(` under the route directory. Eight statements feed one answer — finished rows,
 * created rows grouped by day, open rows, the abandoned count the second rate is measured over, list
 * names, tag counts, the stock the flow replay starts from, and the events it replays — so the count is
 * a constant whatever the range holds; everything else is a pure function over those rows.
 */
import { getZonedParts, isValidCalendarDate } from '@shared/assistant-schedule'
import { SQL_TASK_DONE, SQL_TASK_OPEN, isTaskDone, sqlTaskDone } from '@shared/todos/status'
import { TASK_LIVE_PREDICATE, taskLive } from '../assistant/store'
import type {
  TaskPriority,
  TaskStatsBacklog,
  TaskStatsBucket,
  TaskStatsDistributions,
  TaskStatsFlowPoint,
  TaskStatsLeadTime,
  TaskStatsPoint,
  TaskStatsSummary,
  TaskStatus,
  TodoStats,
} from '@shared/todos/model'

const DAY_MS = 86_400_000
const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The order priorities are listed in: the same low-to-urgent ladder the task form shows. */
const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent']

/**
 * The status the second rate is measured over, spelled out because `status.ts` has no set for it.
 *
 * That module owns the two questions the rest of the app asks — still owed, or finished — and answers
 * neither with `cancelled`. Statistics is the one place that asks the third question, so the third name
 * is written here rather than smuggled into a set whose meaning would then stop matching its own two
 * predicates. Naming the status rather than writing `NOT open AND NOT done` is the same decision the
 * completed page already makes for the same reason: a stray column value must not be read as a
 * statement the reader never made.
 */
function sqlCancelled(expression: string): string {
  return `${expression} = 'cancelled'`
}

/** The rule for a statement that gives the table an alias. */
const SQL_TASK_CANCELLED = sqlCancelled('status')

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

/**
 * The account's stock on the day before the range starts, which the flow replay counts from.
 *
 * `doneBefore` is read from the completion day, so a task finished and then reopened stops counting
 * as done — the row says where it is now, and the replay takes over from there. Two corrections keep
 * the seed consistent with the events the replay is about to apply, because the current columns alone
 * would count the same task twice:
 *
 * - a task done before the range and reopened inside it has no `completed_on` any more, so the day
 *   column misses it while its reopen event subtracts a `done` the seed never held. The read adds it
 *   back when the task carries a reopen in the range with no completion ahead of that reopen;
 * - `inProgressNow` reads today's status, which already counts a task started inside the range. Its
 *   start event would then add a second `in_progress`, so the read leaves out the tasks whose start
 *   falls inside the range — they enter the band through their own event instead.
 *
 * `cancelledBefore` is the fourth shelf, and the one the day column alone cannot see: an abandoned row
 * carries a `completed_on` exactly like a finished one, so a seed that only asked "did it leave the
 * plate" would file given-up work under `done`. Subtracting it here is also what keeps the remainder —
 * the `todo` band — from inheriting it instead. Like `doneBefore` it is read from the end day, so a row
 * abandoned inside the range reaches the bands through its own event rather than through the seed.
 *
 * What remains is the honest approximation: a task started before the event table existed carries no
 * start event, so it is taken as already running. That is what `flowTrackedSince` marks — along with
 * the second way the record can be missing, `earliestEventDay` in the input below.
 */
export interface StatsFlowSeed {
  createdBefore: number
  doneBefore: number
  cancelledBefore: number
  inProgressNow: number
}

/** One row of the event table, as the flow replay reads it. */
export interface StatsFlowEvent {
  kind: 'born' | 'status'
  fromStatus: TaskStatus | null
  toStatus: TaskStatus
  at: number
  onDay: string
}

/** Everything `computeTodoStats` needs, so the arithmetic can be tested without a database. */
export interface StatsInput {
  completed: StatsCompletedRow[]
  created: StatsCreatedRow[]
  open: StatsOpenRow[]
  /**
   * Rows abandoned inside the range, as the read counts them.
   *
   * A count rather than rows, because nothing downstream sorts, buckets or ages them: the number is one
   * term of `abandonedRate` and the `abandoned` figure beside it. Rows would invite the mistake the
   * second rule above forbids — a reader who reaches for this array next to `completed` and treats an
   * abandonment as a completion.
   */
  abandonedTotal: number
  lists: StatsListRow[]
  tags: StatsTagRow[]
  flowSeed: StatsFlowSeed
  flowEvents: StatsFlowEvent[]
  /**
   * The earliest day this account's event table holds, or null while it holds nothing.
   *
   * The day the record begins, which is the other half of what `flowTrackedSince` marks: a restore
   * writes the rows and not the history they went through, so an account can hold years of tasks above
   * an event table whose first row is from today. Read once rather than derived from `flowEvents`,
   * because those are already cut to the range.
   */
  earliestEventDay: string | null
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

/**
 * The cumulative flow: the stock of each status at the end of every bucket.
 *
 * One event is one move — the status it left loses one, the status it entered gains one — and a birth
 * only ever adds, because it has no `from_status`. The counts start from the seed, the stock on the
 * day before the range, so the first point describes the range's first day.
 *
 * Events are filed under the bucket of their `on_day`, the account's calendar day recorded when the
 * event was written. The instant decides the order inside a bucket, and a birth sorts before a status
 * event at the same instant: a task logged already finished was born and completed in one breath, and
 * applying the completion first would subtract from a `todo` count that never held it. Every count is
 * clamped at zero, because the seed's `in_progress` is today's status and a replay from a number that
 * disagrees with the rest of the seed must not report negative work.
 *
 * An abandonment leaves the plate without joining any band, which is the third reading the three above
 * insist on: the status it left loses one and nothing gains one, so the chart shrinks by that task. Both
 * halves are spelled with the named predicates rather than as `else`, because with three terminal-ish
 * statuses an `else` silently files whatever it has never heard of under `done`.
 */
export function computeTodoFlow(
  seed: StatsFlowSeed,
  events: readonly StatsFlowEvent[],
  range: { from: string; to: string; bucket: TaskStatsBucket },
): TaskStatsFlowPoint[] {
  const starts = bucketStarts(range.from, range.to, range.bucket)
  const counts = {
    todo: Math.max(0, seed.createdBefore - seed.doneBefore - seed.cancelledBefore - seed.inProgressNow),
    inProgress: seed.inProgressNow,
    done: seed.doneBefore,
  }
  const rank = (event: StatsFlowEvent): number => (event.kind === 'born' ? 0 : 1)
  const ordered = [...events].sort((left, right) => left.at - right.at || rank(left) - rank(right))
  const byBucket = new Map<string, StatsFlowEvent[]>(starts.map((day) => [day, []]))
  for (const event of ordered) {
    // An event whose day falls outside the buckets was outside the range the query asked for; a
    // direct caller can still hand one over, and dropping it is the answer the boundary already gives.
    byBucket.get(bucketStart(event.onDay, range.bucket))?.push(event)
  }
  const points: TaskStatsFlowPoint[] = []
  for (const day of starts) {
    for (const event of byBucket.get(day)!) {
      if (event.fromStatus === 'todo') counts.todo = Math.max(0, counts.todo - 1)
      else if (event.fromStatus === 'in_progress') counts.inProgress = Math.max(0, counts.inProgress - 1)
      else if (isTaskDone(event.fromStatus)) counts.done = Math.max(0, counts.done - 1)
      if (event.toStatus === 'todo') counts.todo += 1
      else if (event.toStatus === 'in_progress') counts.inProgress += 1
      else if (isTaskDone(event.toStatus)) counts.done += 1
    }
    points.push({ day, todo: counts.todo, inProgress: counts.inProgress, done: counts.done })
  }
  return points
}

/** The whole answer, from rows that were read in the range and the account's zone. */
export function computeTodoStats(input: StatsInput): TodoStats {
  // Everything below measured over `completed` is finished work only (rule 3): the reads that fill this
  // array ask `status IN ('done')` and not "did the row stop being owed", so an abandoned task cannot
  // reach a streak, a lead time, a heatmap cell or a share even though it carries a `completed_on`.
  const completed = input.completed.filter((row) => row.completedOn >= input.from && row.completedOn <= input.to)
  const created = input.created.filter((row) => row.day >= input.from && row.day <= input.to)
  const createdTotal = created.reduce((sum, row) => sum + row.count, 0)
  const completedTotal = completed.length
  const openTotal = input.open.length
  const abandonedTotal = input.abandonedTotal

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
    // Rule 1: the denominator this screen published before `cancelled` existed, unchanged on purpose.
    // `openTotal` comes from `SQL_TASK_OPEN`, so an abandoned row is in neither half; the test suite
    // pins that pairing, because reading "open" as "not done" here is the one edit that would move a
    // number readers compare week to week without having done anything.
    completionRate: completedTotal + openTotal === 0 ? 0 : completedTotal / (completedTotal + openTotal),
    abandoned: abandonedTotal,
    // Rule 2: the term the rate above leaves out, on a denominator of its own.
    abandonedRate: completedTotal + abandonedTotal + openTotal === 0
      ? 0
      : abandonedTotal / (completedTotal + abandonedTotal + openTotal),
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

  const flow = computeTodoFlow(input.flowSeed, input.flowEvents, {
    from: input.from,
    to: input.to,
    bucket: input.bucket,
  })
  // Two bounds say where the chart stops being a guess, and the later one is the honest mark: the first
  // arrival into `in_progress` (the events are in `at` order from the query, but a caller need not be),
  // and the first day this account's event table holds when that day falls inside the range — a record
  // that reaches back past the range opens nothing to mark. A restore moves the second bound forward:
  // the rows come back, the history they went through does not, and without the mark the chart would
  // draw a backlog it had never replayed.
  const tracked = input.flowEvents.reduce<StatsFlowEvent | null>((first, event) => {
    if (event.toStatus !== 'in_progress') return first
    if (event.onDay < input.from || event.onDay > input.to) return first
    return first === null || event.at < first.at ? event : first
  }, null)
  const recordStart = input.earliestEventDay === null || input.earliestEventDay <= input.from
    ? null
    : input.earliestEventDay
  const bounds = [tracked?.onDay ?? null, recordStart].filter((day): day is string => day !== null)
  const trackedSince = bounds.length === 0 ? null : bounds.reduce((later, day) => (day > later ? day : later))

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
  // The cross of the two marginals, keyed by `weekday * 24 + hour` while it is being counted so the
  // grid is a Map of the cells that were actually hit rather than 168 objects walked twice.
  const weekdayHour = new Map<number, number>()
  for (const row of completed) {
    // The weekday and hour are the one place a zone still matters: the stored day cannot tell 09:00
    // from 21:00, and the heatmap is about the clock the reader actually finished at.
    const parts = getZonedParts(new Date(row.completedAt), input.timezone)
    byWeekday[parts.weekday]!.completed += 1
    byHour[parts.hour]!.completed += 1
    const cell = parts.weekday * 24 + parts.hour
    weekdayHour.set(cell, (weekdayHour.get(cell) ?? 0) + 1)
  }
  const byWeekdayHour = [...weekdayHour]
    .map(([cell, completed]) => ({
      weekday: Math.floor(cell / 24),
      hour: cell % 24,
      completed,
    }))
    .sort((left, right) => left.weekday - right.weekday || left.hour - right.hour)

  const distributions: TaskStatsDistributions = { byList, byTag, byPriority, byWeekday, byHour, byWeekdayHour }

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
    flow,
    flowTrackedSince: trackedSince !== null && trackedSince <= input.to ? trackedSince : null,
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
type CountDbRow = { n: number }
type ListDbRow = { id: string; name: string }
type TagDbRow = { id: string; name: string; n: number }
type FlowSeedDbRow = {
  created_before: number | null
  done_before: number | null
  cancelled_before: number | null
  in_progress_now: number | null
}
type FlowEventDbRow = { kind: string; from_status: string | null; to_status: string; at: number; on_day: string }
type FlowRecordDayRow = { first_day: string | null }

/**
 * Reads one range and answers the whole statistics object.
 *
 * Nine statements, none of which depends on how many rows the range holds. The finished rows are read
 * as rows rather than pre-aggregated because a median, a weekday/hour heatmap and an on-time comparison
 * all need each completion's own timestamps; grouping those in SQL would still need the raw rows for
 * the rest, and running both would be a sixth statement for no gain. The abandonments are the one count
 * rather than a set of rows for the same reason reversed: nothing but the two rates reads them, and
 * asking `status IN ('done')` here — the shape that would rhyme with the read above — is exactly how an
 * abandoned row would end up in a completion series. The last three are the flow's: one row of stock
 * for the day before the range, the events inside it, and the day the account's record begins — the
 * first two read whole rather than bucketed because the replay is a pure function that a test can run
 * without a database.
 */
export async function loadTodoStats(db: D1Database, userId: string, query: TodoStatsQuery): Promise<TodoStats> {
  const end = addDays(query.to, 1)
  const [completed, created, open, abandoned, lists, tags, flowSeed, flowEvents, flowRecordDay] = await Promise.all([
    db.prepare(
      `SELECT id, list_id, priority, due_at, created_at, completed_at, completed_on
         FROM todos_tasks
        WHERE user_id = ?1 AND ${SQL_TASK_DONE} AND ${TASK_LIVE_PREDICATE}
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
        WHERE user_id = ?1 AND ${SQL_TASK_OPEN} AND ${TASK_LIVE_PREDICATE}`,
    ).bind(userId).all<OpenDbRow>(),
    // The abandoned rows of the range, counted by the day they left the plate. Not the current stock:
    // `open` above is a stock because a reader's backlog is whatever is owed right now, while an
    // abandonment is an event that happened on a day — and this range's second rate is measured over
    // this range's completions.
    db.prepare(
      `SELECT COUNT(*) AS n FROM todos_tasks
        WHERE user_id = ?1 AND ${SQL_TASK_CANCELLED} AND ${TASK_LIVE_PREDICATE}
          AND completed_on IS NOT NULL AND completed_on >= ?2 AND completed_on < ?3`,
    ).bind(userId, query.from, end).first<CountDbRow>(),
    db.prepare(
      `SELECT id, name FROM todos_lists WHERE user_id = ?1 ORDER BY position ASC, name COLLATE NOCASE ASC`,
    ).bind(userId).all<ListDbRow>(),
    db.prepare(
      `SELECT t.id AS id, t.name AS name, COUNT(*) AS n
         FROM todos_tag_links l
         JOIN todos_tags t ON t.user_id = l.user_id AND t.id = l.tag_id
         JOIN todos_tasks k ON k.user_id = l.user_id AND k.id = l.task_id
        WHERE l.user_id = ?1 AND ${sqlTaskDone('k.status')} AND ${taskLive('k')}
          AND k.completed_on IS NOT NULL AND k.completed_on >= ?2 AND k.completed_on < ?3
        GROUP BY t.id, t.name`,
    ).bind(userId, query.from, end).all<TagDbRow>(),
    db.prepare(
      `SELECT
         SUM(CASE WHEN t.created_on IS NOT NULL AND t.created_on < ?2 THEN 1 ELSE 0 END) AS created_before,
         SUM(CASE WHEN ${sqlTaskDone('t.status')} AND t.completed_on IS NOT NULL AND t.completed_on < ?2 THEN 1 ELSE 0 END)
           + SUM(CASE WHEN EXISTS (
               SELECT 1 FROM todos_task_events e
                WHERE e.user_id = t.user_id AND e.task_id = t.id AND e.kind = 'status'
                  AND ${sqlTaskDone('e.from_status')} AND e.on_day >= ?2 AND e.on_day < ?3
                  AND NOT EXISTS (
                    SELECT 1 FROM todos_task_events d
                     WHERE d.user_id = e.user_id AND d.task_id = e.task_id AND d.kind = 'status'
                       AND ${sqlTaskDone('d.to_status')} AND d.on_day >= ?2 AND d.at <= e.at)
             ) THEN 1 ELSE 0 END) AS done_before,
         SUM(CASE WHEN ${sqlCancelled('t.status')} AND t.completed_on IS NOT NULL AND t.completed_on < ?2 THEN 1 ELSE 0 END)
           + SUM(CASE WHEN EXISTS (
               SELECT 1 FROM todos_task_events x
                WHERE x.user_id = t.user_id AND x.task_id = t.id AND x.kind = 'status'
                  AND ${sqlCancelled('x.from_status')} AND x.on_day >= ?2 AND x.on_day < ?3
                  AND NOT EXISTS (
                    SELECT 1 FROM todos_task_events y
                     WHERE y.user_id = x.user_id AND y.task_id = x.task_id AND y.kind = 'status'
                       AND ${sqlCancelled('y.to_status')} AND y.on_day >= ?2 AND y.at <= x.at)
             ) THEN 1 ELSE 0 END) AS cancelled_before,
         SUM(CASE WHEN t.status = 'in_progress' AND NOT EXISTS (
               SELECT 1 FROM todos_task_events s
                WHERE s.user_id = t.user_id AND s.task_id = t.id
                  AND s.to_status = 'in_progress' AND s.on_day >= ?2 AND s.on_day < ?3
             ) THEN 1 ELSE 0 END) AS in_progress_now
         FROM todos_tasks t
        WHERE t.user_id = ?1 AND ${TASK_LIVE_PREDICATE}`,
    ).bind(userId, query.from, end).all<FlowSeedDbRow>(),
    db.prepare(
      `SELECT kind, from_status, to_status, at, on_day
         FROM todos_task_events
        WHERE user_id = ?1 AND on_day >= ?2 AND on_day < ?3
        ORDER BY at ASC`,
    ).bind(userId, query.from, end).all<FlowEventDbRow>(),
    // Where this account's own record begins. Not cut to the range: the question is whether the history
    // the chart replays reaches back past it, and one indexed minimum answers that whatever the range is.
    db.prepare(
      `SELECT MIN(on_day) AS first_day FROM todos_task_events WHERE user_id = ?1`,
    ).bind(userId).first<FlowRecordDayRow>(),
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
    abandonedTotal: Number(abandoned?.n ?? 0),
    lists: (lists.results ?? []).map((row) => ({ id: row.id, name: row.name })),
    tags: (tags.results ?? []).map((row) => ({ id: row.id, name: row.name, count: Number(row.n) })),
    // The stock on the day before the range, one row of four sums. `cancelledBefore` mirrors
    // `doneBefore`'s shape — the row's own status and end day, plus the event-table add-back for a row
    // that was abandoned before the range and moved inside it, which has already lost the day the first
    // term reads — and it is what keeps an abandoned task out of both the `done` band and the `todo`
    // remainder the seed is computed from.
    flowSeed: {
      createdBefore: Number(flowSeed.results?.[0]?.created_before ?? 0),
      doneBefore: Number(flowSeed.results?.[0]?.done_before ?? 0),
      cancelledBefore: Number(flowSeed.results?.[0]?.cancelled_before ?? 0),
      inProgressNow: Number(flowSeed.results?.[0]?.in_progress_now ?? 0),
    },
    flowEvents: (flowEvents.results ?? []).map((row) => ({
      kind: row.kind === 'born' ? 'born' : 'status',
      fromStatus: row.from_status === null ? null : (row.from_status as TaskStatus),
      toStatus: row.to_status as TaskStatus,
      at: Number(row.at),
      onDay: row.on_day,
    })),
    earliestEventDay: flowRecordDay?.first_day ?? null,
    from: query.from,
    to: query.to,
    bucket: query.bucket,
    timezone: query.timezone,
    now: query.now,
  })
}
