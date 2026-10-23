/**
 * The todo module's vocabulary, shared by the worker, the client and the tests.
 *
 * A task itself is the assistant's `Task` — the tool layer has written that shape since the chat
 * could create one — and this module only adds the fields the to-do app needs on top of it. Keeping
 * the extension here rather than widening `Task` means a backup, a shared conversation or an old
 * answer version never has to learn about lists and tags it does not carry.
 */

import type { Task, TaskPriority, TaskStatus } from '../assistant'
import { isTaskOpen } from './status'
import { daysInMonth, getZonedParts, zonedTimeToUtc } from '../assistant-schedule'
import { ORGANIZER_COLORS, organizerColorOrNull } from '../organizer-colors'

export const REPEAT_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number]

/**
 * How often a task comes back.
 *
 * `interval` is in units of `freq` — every 2 weeks is `{ freq: 'weekly', interval: 2 }` — and the
 * next occurrence is counted from the due date rather than from the moment the reader ticked it,
 * so finishing a weekly report on Thursday does not move it to Thursday for good.
 *
 * `weekdays` narrows a weekly rhythm to the days named — `[1, 3, 5]` is every Monday, Wednesday and
 * Friday — and is only read when `freq` is weekly. `monthlyMode` chooses which day a monthly rhythm
 * lands on: the due date's own day (`day`, the default), the last day of the month, or the same
 * nth weekday the due date sits on.
 */
export interface RepeatRule {
  freq: RepeatFrequency
  interval: number
  /** Weekly only: 0 = Sunday … 6 = Saturday, ascending and deduplicated. */
  weekdays?: number[]
  /** Monthly only: which day of the month the next occurrence lands on. */
  monthlyMode?: RepeatMonthlyMode
}

export const REPEAT_MONTHLY_MODES = ['day', 'lastDay', 'nthWeekday'] as const
export type RepeatMonthlyMode = (typeof REPEAT_MONTHLY_MODES)[number]

export const MIN_REPEAT_INTERVAL = 1
export const MAX_REPEAT_INTERVAL = 99

/** The views the server can answer in one query. */
export const TASK_VIEWS = ['inbox', 'today', 'upcoming', 'overdue', 'open', 'completed', 'starred', 'all'] as const
export type TaskView = (typeof TASK_VIEWS)[number]

/**
 * How far ahead "upcoming" reaches.
 *
 * A week is what a reader can still plan around; anything further is a list they will look at when
 * it gets closer, and putting it in the same view makes that view unusable.
 */
export const UPCOMING_DAYS = 7

/**
 * The orders a listing can be asked to answer in.
 *
 * A named key rather than a column, because the caller is choosing a reading order and not a SQL
 * expression: the store decides what each key means, including the tiebreaker that keeps two pages
 * of the same query from disagreeing about rows that share a value.
 */
export const TASK_SORTS = ['due', 'priority', 'created', 'completed'] as const
export type TaskSort = (typeof TASK_SORTS)[number]

/** How long a reminder may be set before the due time. Presets are a form shortcut, not a stored unit. */
export const REMIND_OFFSETS = ['none', 'due', '15m', '1h', '1d'] as const
export type RemindOffset = (typeof REMIND_OFFSETS)[number]

/** The most reminders one task may carry. Five is what the reference app's paid tier offers. */
export const MAX_REMINDERS_PER_TASK = 5

/**
 * The durations a "remind me again" press offers, in minutes: ten minutes, an hour, nine hours
 * ("tonight") and a day ("tomorrow morning"). Deliberately durations rather than wall-clock times:
 * a snooze must work the same whatever zone the account is in or however close to midnight it is.
 */
export const SNOOZE_MINUTES = [10, 60, 540, 1440] as const
export type SnoozeMinutes = (typeof SNOOZE_MINUTES)[number]

export function isSnoozeMinutes(value: unknown): value is SnoozeMinutes {
  return typeof value === 'number' && (SNOOZE_MINUTES as readonly number[]).includes(value)
}

export const MAX_LIST_NAME_CHARS = 60
export const MAX_TAG_NAME_CHARS = 40
export const MAX_TAGS_PER_TASK = 8
export const MAX_STEPS_PER_TASK = 50
export const MAX_STEP_TEXT_CHARS = 200
/** The longest task note a person may write through the to-do app's own HTTP form. */
export const MAX_TASK_DESCRIPTION_CHARS = 10_000
/**
 * The longest task icon a person may store.
 *
 * Sized for a lucide name — `lucide:Briefcase` and friends — the way the list route already judges
 * one, rather than for the eight units an emoji needs: a name truncated to eight is a name no picker
 * can ever produce again, and a task that cannot show the face its reader chose is worse than one
 * that refused it.
 */
export const MAX_TASK_ICON_CHARS = 40
/** The longest substring a task listing searches for; the HTTP `q` and both task tool surfaces share it. */
export const MAX_TASK_QUERY_CHARS = 200
/** The most a single listing answers with; a page smaller than this is what a caller normally asks for. */
export const MAX_TASKS_PER_QUERY = 500
/** A completed list is history: the newest page is enough to answer "what did I finish". */
export const COMPLETED_PAGE_SIZE = 200
/** One page of the trash: a holding area, not a shelf, so its pages are smaller than the listing's. */
export const TRASH_PAGE_SIZE = 50

/**
 * How long a deleted task stays restorable.
 *
 * Thirty days is long enough to notice a mistake a week later and short enough that the trash does not
 * become a second task list. The retention sweep is the only place that acts on it, but the number is
 * kept here rather than beside that sweep because the surfaces that promise the window — the trash
 * page and its copy — have to name the same one: a screen that advertises longer than the sweep keeps
 * promises a restore that will not come.
 */
export const TODO_TRASH_RETENTION_DAYS = 30

// ------------------------------------------------------------- time ledger

/** Who wrote a ledger row: the stopwatch, the focus overlay, or a hand-entered span. */
export const TIME_ENTRY_SOURCES = ['timer', 'focus', 'manual'] as const
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number]

export function isTimeEntrySource(value: unknown): value is TimeEntrySource {
  return typeof value === 'string' && (TIME_ENTRY_SOURCES as readonly string[]).includes(value)
}

/**
 * One interval on the ledger: a timed run (one row per account day it touched), or a back-filled span.
 *
 * `day` is the account's calendar day the interval belongs to, fixed by the server at write time —
 * a client never names it. `endAt` is null only while a timer is running; every aggregate reads the
 * closed rows, and a running row's own `day` is display-only. One row per account may run at a time;
 * the database, not the client, enforces that (`ux_todos_time_open`).
 */
export interface TodoTimeEntry {
  id: string
  taskId: string
  /** Instant the interval began, UTC milliseconds. */
  startAt: number
  /** Instant it ended, or null while it is still running. */
  endAt: number | null
  /** `YYYY-MM-DD` in the account's zone, the day the interval was filed under. */
  day: string
  source: TimeEntrySource
  createdAt: number
  updatedAt: number
}

/**
 * How far a client's clock may run ahead of the server's before a timestamp is refused.
 *
 * Five minutes covers the drift a sleeping laptop rebuilds on wake; past that the request is
 * describing a future that has not happened, and the ledger must not carry it.
 */
export const MAX_TIMER_START_FUTURE_MS = 5 * 60_000

/**
 * How far back the ledger may be written.
 *
 * Four hundred days is one remembered year plus its leap, the practical ceiling on "when did I do
 * this"; anything older is not a back-fill but a client clock nobody set, and a 'yesterday of 25
 * hours' filed against an ancient day is indistinguishable from real work afterwards. The account's
 * own creation time floors it further.
 */
export const MAX_TIME_ENTRY_AGE_DAYS = 400

/** The longest one interval may hold, in milliseconds. */
export const MAX_SINGLE_TIME_ENTRY_MS = 4 * 60 * 60_000

/** The most total a single account day may hold, in milliseconds — a day only has this many. */
export const MAX_DAY_TRACKED_MS = 24 * 60 * 60_000

/**
 * The largest estimate one task may carry, in milliseconds.
 *
 * Ten days of work is the ceiling a reader plans against, and one hundred hours is already a project
 * rather than a task; a bigger number is a client that mistyped a unit, and storing it would make every
 * consumption bar on the screen read as empty. Null — no estimate — is always accepted and is what a
 * clear writes.
 */
export const MAX_TIME_ESTIMATE_MS = 10 * 24 * 60 * 60_000

/**
 * The estimate presets the picker offers, in milliseconds.
 *
 * The same ladder the reference app puts beside its free-text field: quarters, halves and whole hours up
 * to a working day. They are values rather than labels because a label is the reader's language and this
 * file is not — `formatTaskDuration` renders whichever one is picked, and the custom entry parses the same
 * words back.
 */
export const TIME_ESTIMATE_PRESETS_MS = [
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  45 * 60_000,
  60 * 60_000,
  90 * 60_000,
  120 * 60_000,
  180 * 60_000,
  240 * 60_000,
  360 * 60_000,
  480 * 60_000,
] as const

/** Whether a value is an estimate the task row may carry: a whole number of milliseconds inside the ceiling. */
export function isTimeEstimateMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIME_ESTIMATE_MS
}

/**
 * The most tasks one batch may name.
 *
 * A batch is a gesture over a selection a person made on screen, and a hundred rows is more than one
 * screen holds. The ceiling is also what keeps the request body inside the route's usual limit and the
 * work behind one press bounded: a client that needs to change more than this is scripting, and a
 * script can send two batches.
 */
export const MAX_BATCH_TASKS = 100

/**
 * The changes a batch request can make. One operation for the whole batch, so a mixed request has no
 * order to guess.
 *
 * `due` is the page-level "move every overdue row to today" gesture, pressed from the overdue banner;
 * the selection bar at the foot of the list offers the other six — complete, delete, move, priority,
 * star and tag. `value` on a due batch is the day to land on — absent means the end of the reader's
 * own today — and the write touches `due_at` alone, never `planned_for`.
 */
export const TASK_BATCH_OPS = ['complete', 'delete', 'move', 'priority', 'star', 'tag', 'due'] as const
export type TaskBatchRequestOp = (typeof TASK_BATCH_OPS)[number]
/** The operations the selection bar offers; `due` is the banner's own gesture. */
export type TaskBatchOp = Exclude<TaskBatchRequestOp, 'due'>

export function isTaskBatchRequestOp(value: unknown): value is TaskBatchRequestOp {
  return typeof value === 'string' && (TASK_BATCH_OPS as readonly string[]).includes(value)
}

/** One task a batch could not change, and the reason it was left as it was. */
export interface TaskBatchFailure {
  id: string
  reason: string
}

/**
 * One task a batch did change.
 *
 * An object rather than a bare id because a completion is not only a status: a repeating row files
 * its next occurrence, and the caller that pressed the batch bar has to be told what that new row is
 * — the same thing the single-task PATCH answers with. Every operation shares the shape, so a `move`
 * or a `delete` answers `next` as null rather than as a field that only exists for one operation and
 * would make the caller guess which one it had sent.
 */
export interface TaskBatchDone {
  id: string
  /** The occurrence a completed repeating task filed, or null — which is also every other operation. */
  next: TodoTask | null
}

/**
 * What a batch answers with.
 *
 * Both lists are always present, because a batch is allowed to be partly true: the rows that changed
 * are named, the rows that did not are named with their reason, and the status stays 200 either way —
 * one account's bad id is not a server failure of the other ninety-nine. An id that names no task of
 * this account is `not found`, exactly as the single-task routes answer it, so a refusal never tells
 * the caller whether an id exists somewhere else.
 */
export interface TaskBatchResult {
  done: TaskBatchDone[]
  failed: TaskBatchFailure[]
}

export interface TaskList {
  id: string
  name: string
  /** A lucide icon name or one emoji, stored as the reader picked it. */
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number
  openCount: number
  doneCount: number
}

export interface TaskTag {
  id: string
  name: string
  color: string | null
  createdAt: number
  updatedAt: number
  openCount: number
}

export interface TaskStep {
  id: string
  taskId: string
  text: string
  done: boolean
  position: number
  createdAt: number
}

export interface TodoTask extends Task {
  listId: string | null
  /**
   * The task's own icon, or null while it wears its list's.
   *
   * The same vocabulary a list icon speaks — `lucide:<Name>` or a single emoji — so one picker and one
   * renderer serve both. Optional because an older answer, or a fixture written before the column
   * existed, simply has no face to speak of; every row this app reads answers with one, null included.
   */
  icon?: string | null
  /** The task's own colour from the shared palette, or null while it wears its list's. */
  color?: string | null
  /**
   * The face fields *this row's own write* asked for and could not carry, and why.
   *
   * A write-time report rather than a column: the row has no memory of what was asked of it. The store
   * judges a face with {@link taskIconOrNull} and {@link taskColorOrNull} and answers a value outside
   * that accept set with null rather than a refusal, because one unusable field must not undo the rest
   * of the write — while the HTTP route, judging the same value, answers 400. Null is also what a
   * caller that *clears* a face writes, so a tool or an agent that went straight to the store could
   * report "the icon is set" over a row that carries none. This field is what makes that loss visible
   * to the caller; see {@link taskFaceDrops}. Absent whenever the write lost nothing, which is every
   * read of a row and every ordinary write.
   */
  droppedFace?: TaskFaceDrop[]
  /**
   * Where the reader placed this task among its list's rows, or null while nobody has moved it.
   *
   * Only the default listing reads it: rows carrying a place are read in that order first, and rows
   * without one follow in the view's own order. An explicit `sort` is the reader's chosen reading and
   * ignores it. Optional because an older answer, or a fixture written before the column existed,
   * simply has no place to speak of.
   */
  position?: number | null
  tags: TaskTag[]
  starred: boolean
  repeat: RepeatRule | null
  /**
   * When the task may be begun, as an absolute instant, or null when the reader named no start.
   *
   * Independent of `dueAt`: a report can start on the first of the month and be owed on the last. The
   * plan view files a not-yet-due task under the future by this day, and falls back to the due date
   * when the task never named one.
   */
  startAt?: number | null
  /**
   * The task's pending reminders, as absolute instants in ascending order. Up to
   * `MAX_REMINDERS_PER_TASK`; fired ones are delivery history and are not listed.
   */
  reminders?: number[]
  /**
   * The earliest pending reminder, derived from {@link reminders}. Kept as its own field because the
   * quick-add preview and the assistant's task output speak one instant, not a list.
   */
  remindAt: number | null
  /**
   * @deprecated A delivery fact now lives on each `todos_reminders` row (`fired_at`) and is not part of
   * the task. Always null; kept until the old `todos_tasks` columns are dropped so older clients and
   * fixtures keep one shape to read.
   */
  remindedAt: number | null
  /**
   * The account-zone day (`YYYY-MM-DD`) the reader picked this task into "today", or null when it
   * was never picked. Orthogonal to `dueAt`: a task can be planned for today while being due next
   * week, and a task due today is in today without a plan. A stored day rather than a flag is what
   * lets yesterday's plan lapse at midnight with no sweep.
   */
  plannedFor: string | null
  noteId: string | null
  conversationId: string | null
  /**
   * The row's version, moved on by every write. A caller editing a task names the revision it read;
   * a write naming an older one is refused with a 409 rather than replacing an edit it never saw.
   */
  rev?: number
  /**
   * When the task was moved to the trash, or null while it is live. Only the trash page answers with a
   * stamp; every other read filters trashed rows out, so this is null there.
   */
  deletedAt?: number | null
  /**
   * The task's ledger rows — closed ones and, at most once across the account, the running one — as
   * the sync stream attaches them to every page it sends.
   *
   * The whole list, not a delta: a task the stream names arrives with the complete set of intervals
   * the server holds for it, so a receiving device replaces rather than merges — which is what lets a
   * deleted span on one device delete it on the other without a second tombstone stream. Every ledger
   * write moves the task's `updatedAt`, and that bump is what makes this page-level restatement
   * arrive at all. Reads outside the sync stream leave it absent, not empty.
   */
  timeEntries?: TodoTimeEntry[]
  /**
   * What the reader planned for this task, in milliseconds, or null when nobody estimated one.
   *
   * The row's own column (`todos_tasks.time_estimate_ms`, migration 148): a plan is a fact the reader
   * stated, so it is stored rather than derived. Absent on a row read before the column existed.
   */
  timeEstimateMs?: number | null
  /**
   * What the ledger says this task has actually taken, in milliseconds.
   *
   * Derived, never stored (D3): the sum of the task's *closed* intervals, so a timer still running is
   * not counted — it is not yet a fact, and counting the open slot is how "yesterday" starts growing
   * while nobody watches. The listing reads it in the same statement it reads the rows in, so a page of
   * a hundred tasks costs no second read per row.
   */
  timeSpentMs?: number
  /**
   * When this task's running interval began, or null while nothing is running on it.
   *
   * Derived from the account's one open ledger row, which `ux_todos_time_open` guarantees is at most
   * one: a non-null value is the whole of "this task is being timed", and the surfaces that show a
   * running timer read this rather than keeping a second flag of their own. The elapsed clock a screen
   * paints is interpolated from it locally; nothing asks the server every second.
   */
  runningSince?: number | null
  stepTotal: number
  stepDone: number
}

export interface TaskCounts {
  inbox: number
  today: number
  upcoming: number
  overdue: number
  all: number
  completed: number
  starred: number
  byList: Record<string, { open: number; done: number }>
  /** A tag carries both numbers for the same reason a list does: its view shows the finished rows too. */
  byTag: Record<string, { open: number; done: number }>
}

/** What one page of tasks answers with, so the client never has to compute "today" itself. */
export interface TaskPage {
  tasks: TodoTask[]
  /** How many tasks the filter on this page matches, whatever the page itself carries. */
  total: number
  counts: TaskCounts
  /** End of the reader's local day, in UTC milliseconds. */
  dayEnd: number
  /** The zone `dayEnd` was measured in, so the client reads the same calendar the server did. */
  timezone: string
}

/** One page of the trash: only the rows that still carry a deletion stamp, newest first. */
export interface TaskTrashPage {
  tasks: TodoTask[]
  /** The size of the whole trash, not of the page. */
  total: number
}

/** The spans the statistics may bucket a range into. */
export const TASK_STATS_BUCKETS = ['day', 'week', 'month'] as const
export type TaskStatsBucket = (typeof TASK_STATS_BUCKETS)[number]

/**
 * What the statistics answer with.
 *
 * The range is echoed because every number below is measured in the account's own days: a reader who
 * changes zone sees new days from then on, and the answer has to say which calendar it used. Rates are
 * fractions (0–1) rather than percentages, so a client can format them in its own locale without
 * parsing a rounded string back into a number.
 */
export interface TaskStatsRange {
  /** First day counted, `YYYY-MM-DD` in the account's zone. */
  from: string
  /** Last day counted, inclusive. */
  to: string
  bucket: TaskStatsBucket
  timezone: string
}

/**
 * The headline numbers, and the three counting rules they are measured on (plan §5 D10).
 *
 * The rules are written down rather than left to each reader because one of these numbers was published
 * before the third status existed:
 *
 * - `completionRate` is finished over finished-plus-owed. A row the reader abandoned is in neither
 *   half. Widening the denominator when `cancelled` arrived would have moved a number people already
 *   compare week to week without them doing anything — the screen would have reported a regression
 *   that was really a change of algorithm.
 * - `abandonedRate` is the term that was left out, measured on its own over everything that either
 *   ended or is still owed, so the two rates read side by side without one hiding the other.
 * - Every *time* series — `net`, the backlog ages, the streaks, the lead times — is finished work only.
 *   An abandonment says nothing about when the reader finished something, because they did not.
 */
export interface TaskStatsSummary {
  /** Finish events in the range: a repeated task counts once per completion, not once per task id. */
  completed: number
  /** Rows created in the range, whatever their status is now. */
  created: number
  /** `completed - created`; positive means the range retired more than it filed. */
  net: number
  /** Tasks still owed when the statistics ran, the unfinished half of the completion rate. */
  open: number
  /**
   * `completed / (completed + open)`, or 0 when there is nothing either way.
   *
   * Abandoned rows are in neither half — see the rule above the interface. The number a reader who has
   * used this screen for months already recognised; `abandonedRate` carries what was left out.
   */
  completionRate: number
  /** Rows abandoned in the range, counted once per row that left the plate unfinished. */
  abandoned: number
  /**
   * `abandoned / (completed + abandoned + open)`, or 0 when there is nothing to measure over.
   *
   * The denominator is the completion rate's plus the abandonments the first rate deliberately left
   * out, so the two rates read as one story: of everything that ended or is still owed, this much was
   * finished, this much given up.
   */
  abandonedRate: number
  /** Finished in the range, by their own due date. */
  onTime: number
  /** Finished in the range that carried a due date: the on-time rate's denominator. */
  onTimeDue: number
  /** `onTime / onTimeDue`, or 0 when no finished task had a due date. */
  onTimeRate: number
  /** Median `created_at → completed_at` in milliseconds; null when nothing finished. */
  medianLeadTimeMs: number | null
  /** Consecutive days with a completion ending at the range's last day (or the day before, if it is still open). */
  currentStreak: number
  /** Longest run of consecutive completion days inside the range. */
  longestStreak: number
  /** Open tasks whose due date is already in the past. */
  overdue: number
}

/** One point of the trend: a day, a week (its Monday), or a month (its first day). */
export interface TaskStatsPoint {
  day: string
  completed: number
  created: number
}

/**
 * One slice of a distribution. `id` and `name` are null for the inbox, which has no row to name it:
 * the client already has a translation for the collection every unfiled task lands in.
 */
export interface TaskStatsNamedCount {
  id: string | null
  name: string | null
  completed: number
  /** Share of the range's completions; tag shares may sum past 1 because a task can carry several. */
  share: number
}

export interface TaskStatsPriorityCount {
  priority: TaskPriority
  completed: number
  share: number
}

/** Completions by the account-zone weekday (0 = Sunday) and hour (0–23) of `completed_at`. */
export interface TaskStatsWeekdayCount {
  weekday: number
  completed: number
}

export interface TaskStatsHourCount {
  hour: number
  completed: number
}

/**
 * One occupied cell of the weekday × hour heatmap.
 *
 * Only cells that hold a completion are listed: the grid is 168 cells and most of them are empty for
 * any real account, so sending the zeros would be four kilobytes of nothing. A missing cell reads as
 * zero, which is the same answer with less wire.
 */
export interface TaskStatsWeekdayHourCount {
  weekday: number
  hour: number
  completed: number
}

export interface TaskStatsDistributions {
  byList: TaskStatsNamedCount[]
  byTag: TaskStatsNamedCount[]
  byPriority: TaskStatsPriorityCount[]
  byWeekday: TaskStatsWeekdayCount[]
  byHour: TaskStatsHourCount[]
  /** The two marginals above, crossed: when in the week the work actually gets finished. */
  byWeekdayHour: TaskStatsWeekdayHourCount[]
}

export interface TaskStatsPriorityLead {
  priority: TaskPriority
  /** How many finished rows the average is measured over; 0 means `averageMs` is null. */
  count: number
  averageMs: number | null
}

export interface TaskStatsLeadTime {
  /** Median and 90th percentile of `created_at → completed_at`, in milliseconds. */
  p50: number | null
  p90: number | null
  byPriority: TaskStatsPriorityLead[]
}

/**
 * How old the open workload is, aged from the due date when there is one and from the day it was
 * filed otherwise. `none` is the row that carries neither a usable due date nor a creation time: it
 * cannot be placed on that axis and is kept visible rather than dropped.
 */
export interface TaskStatsBacklog {
  /** Less than 7 days old, including tasks not yet due. */
  under7: number
  /** 7 to 30 days old, both ends included. */
  days7to30: number
  /** More than 30 days old. */
  over30: number
  /** No due date and no creation time to age it by. */
  none: number
}

/**
 * One bucket of the cumulative flow: how much work stood in each status when the bucket ended.
 *
 * The three bands cover the work a reader can still be asked about — owed, under way, finished — and
 * they add up to the stock that is still on one of those three shelves. They are replayed from the
 * event table rather than counted from the rows: the rows only say where a task is now, and the
 * question the chart answers is where the backlog was.
 *
 * An abandoned row is in none of them. It is not owed and it was not finished, so the event that
 * abandoned it takes the task out of the band it stood in and puts it in no band: the chart gets
 * shorter rather than showing given-up work as work done (D10).
 */
export interface TaskStatsFlowPoint {
  day: string
  todo: number
  inProgress: number
  done: number
}

export interface TodoStats {
  range: TaskStatsRange
  summary: TaskStatsSummary
  series: TaskStatsPoint[]
  /** The same buckets as `series`, holding the status of the whole backlog rather than the day's work. */
  flow: TaskStatsFlowPoint[]
  /**
   * The first day in the range on which the replayed history is real, or null while none of it is.
   *
   * Two things can put the chart back into the guess: before the event table existed there was no record
   * of a task being started, so a reading further back shows a `todo` band that silently includes work
   * already under way; and a restore writes the task rows without the history they went through, so an
   * account can hold years of backlog above a table whose first row is the day it was restored. The line
   * marks the later of the two, which is where the reading stops being an approximation.
   */
  flowTrackedSince: string | null
  distributions: TaskStatsDistributions
  leadTime: TaskStatsLeadTime
  backlog: TaskStatsBacklog
}

export function isTaskStatsBucket(value: unknown): value is TaskStatsBucket {
  return typeof value === 'string' && (TASK_STATS_BUCKETS as readonly string[]).includes(value)
}

export function isTaskView(value: unknown): value is TaskView {
  return typeof value === 'string' && (TASK_VIEWS as readonly string[]).includes(value)
}

export function isTaskSort(value: unknown): value is TaskSort {
  return typeof value === 'string' && (TASK_SORTS as readonly string[]).includes(value)
}

export function isRepeatFrequency(value: unknown): value is RepeatFrequency {
  return typeof value === 'string' && (REPEAT_FREQUENCIES as readonly string[]).includes(value)
}

function isRepeatMonthlyMode(value: unknown): value is RepeatMonthlyMode {
  return typeof value === 'string' && (REPEAT_MONTHLY_MODES as readonly string[]).includes(value)
}

/**
 * The weekdays a weekly rule names, or null when the list is not one this app wrote.
 *
 * A day outside 0–6 or a value that is not a whole number makes the list unreadable rather than being
 * dropped: silently losing one of "every Monday and Friday" leaves a rule the reader never asked for.
 * Duplicates are one day, and the order is the week's, so two devices that store the same set agree.
 */
function normalizeWeekdays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const days = new Set<number>()
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 6) return null
    days.add(entry)
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * Reads a stored repeat rule.
 *
 * Returns null rather than throwing: a row written by an older build, or by a hand-edited backup,
 * must not take the whole listing down with it. An unknown shape simply means "does not repeat".
 * A modifier that does not belong to the rule's frequency is left out instead of refusing the rule:
 * an extra field is not a reason to forget the rhythm the reader did write.
 */
export function parseRepeatRule(value: unknown): RepeatRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isRepeatFrequency(raw.freq)) return null
  const interval = typeof raw.interval === 'number' && Number.isFinite(raw.interval)
    ? Math.trunc(raw.interval)
    : 1
  if (interval < MIN_REPEAT_INTERVAL || interval > MAX_REPEAT_INTERVAL) return null
  const weekdays = raw.weekdays === undefined ? null : normalizeWeekdays(raw.weekdays)
  if (raw.weekdays !== undefined && weekdays === null) return null
  if (raw.monthlyMode !== undefined && !isRepeatMonthlyMode(raw.monthlyMode)) return null
  const rule: RepeatRule = { freq: raw.freq, interval }
  if (raw.freq === 'weekly' && weekdays?.length) rule.weekdays = weekdays
  if (raw.freq === 'monthly' && raw.monthlyMode !== undefined && raw.monthlyMode !== 'day') {
    rule.monthlyMode = raw.monthlyMode
  }
  return rule
}

function shiftDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const cursor = new Date(Date.UTC(year, month - 1, day))
  cursor.setUTCDate(cursor.getUTCDate() + days)
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() }
}

function shiftMonths(year: number, month: number, day: number, months: number): { year: number; month: number; day: number } {
  const total = year * 12 + (month - 1) + months
  const nextYear = Math.floor(total / 12)
  const nextMonth = ((total % 12) + 12) % 12 + 1
  return { year: nextYear, month: nextMonth, day: Math.min(day, daysInMonth(nextYear, nextMonth)) }
}

/** The weekday of the first day of a month, 0 = Sunday, as the calendar rather than the machine reads it. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * The next day in a weekly rhythm that names several weekdays.
 *
 * The occurrence's own week is the one the due date sits in, Monday-first; the days still ahead of it
 * in that week come first, then the days of the week `interval` weeks later. A Sunday due date is the
 * last day of its week, so the following Monday is already the next week — which is what a calendar
 * says, even though it is only one day away.
 */
function nextWeekdayOn(parts: { year: number; month: number; day: number }, interval: number, weekdays: readonly number[]): { year: number; month: number; day: number } {
  const dueWeekday = weekdayOf(parts.year, parts.month, parts.day)
  const daysSinceMonday = (dueWeekday + 6) % 7
  for (let step = 1; step <= interval * 7 + 7; step += 1) {
    if (!weekdays.includes((dueWeekday + step) % 7)) continue
    const weeksAhead = Math.floor((daysSinceMonday + step) / 7)
    if (weeksAhead !== 0 && weeksAhead !== interval) continue
    return shiftDays(parts.year, parts.month, parts.day, step)
  }
  // Unreachable with a non-empty weekday list: one interval plus a full week always contains one.
  return shiftDays(parts.year, parts.month, parts.day, interval * 7)
}

/** The nth (1–5) weekday of a month, falling back to the month's last one when it has only four. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  const first = weekdayOf(year, month, 1)
  const day = 1 + (weekday - first + 7) % 7 + (nth - 1) * 7
  return day <= daysInMonth(year, month) ? day : day - 7
}

/**
 * The due time of the next occurrence, in the reader's own calendar.
 *
 * The arithmetic happens on wall-clock parts and goes back through `zonedTimeToUtc`, so a weekly
 * task due at 09:00 stays at 09:00 across a daylight-saving change instead of drifting to 08:00.
 * A month that lacks the day (the 31st, or 29 February) clamps to its last day.
 *
 * A weekly rule that names weekdays walks them in order inside its own week and then in the week an
 * interval away; a monthly rule can instead land on the month's last day or on the same nth weekday
 * the due date sits on. Both keep the wall-clock hour of the due date.
 */
export function nextOccurrence(dueAt: number, rule: RepeatRule, timeZone: string): number {
  const parts = getZonedParts(new Date(dueAt), timeZone)
  const interval = Math.min(MAX_REPEAT_INTERVAL, Math.max(MIN_REPEAT_INTERVAL, Math.trunc(rule.interval)))
  let next: { year: number; month: number; day: number }
  if (rule.freq === 'daily') {
    next = shiftDays(parts.year, parts.month, parts.day, interval)
  } else if (rule.freq === 'weekly') {
    next = rule.weekdays?.length
      ? nextWeekdayOn(parts, interval, rule.weekdays)
      : shiftDays(parts.year, parts.month, parts.day, interval * 7)
  } else if (rule.freq === 'monthly' && rule.monthlyMode === 'lastDay') {
    const target = shiftMonths(parts.year, parts.month, 1, interval)
    next = { ...target, day: daysInMonth(target.year, target.month) }
  } else if (rule.freq === 'monthly' && rule.monthlyMode === 'nthWeekday') {
    const target = shiftMonths(parts.year, parts.month, 1, interval)
    const nth = Math.ceil(parts.day / 7)
    next = { ...target, day: nthWeekdayOfMonth(target.year, target.month, weekdayOf(parts.year, parts.month, parts.day), nth) }
  } else if (rule.freq === 'monthly') {
    next = shiftMonths(parts.year, parts.month, parts.day, interval)
  } else {
    next = shiftMonths(parts.year, parts.month, parts.day, interval * 12)
  }
  return zonedTimeToUtc(next.year, next.month, next.day, parts.hour, parts.minute, timeZone).getTime()
}

/**
 * When to remind the reader, as an absolute instant.
 *
 * Stored as a time rather than an offset because the sweep has to answer "is it due" without
 * knowing which offset the reader chose, and because a reminder set for "1 day before" must not
 * move when the due date is later edited by hand.
 */
export function remindAtFor(dueAt: number | null, offset: RemindOffset): number | null {
  if (dueAt === null || offset === 'none') return null
  switch (offset) {
    case 'due': return dueAt
    case '15m': return dueAt - 15 * 60_000
    case '1h': return dueAt - 60 * 60_000
    case '1d': return dueAt - 24 * 60 * 60_000
    default: return null
  }
}

/**
 * The reminder instants a caller asked for, as this app stores them.
 *
 * Absolute UTC milliseconds, ascending and deduplicated, and never more than five: two form rows that
 * name the same minute are one reminder, and a caller that sends six is held to the same ceiling the
 * route states. A value that is not a finite number is dropped rather than turned into `NaN`, which
 * would make every comparison false and park the row outside every sweep.
 */
export function normalizeReminderTimes(values: readonly number[]): number[] {
  const unique = new Set<number>()
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    unique.add(Math.trunc(value))
  }
  return [...unique].sort((a, b) => a - b).slice(0, MAX_REMINDERS_PER_TASK)
}

/**
 * The tag names a caller asked for, as this app stores them.
 *
 * A leading `#` is how a reader writes a tag and not part of its name; duplicates differ only by
 * case, so `Work` and `work` are one tag. Order is kept, because the list is also what the reader
 * sees on the task.
 */
export function normalizeTagNames(input: unknown): string[] {
  const source = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(',') : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of source) {
    if (typeof entry !== 'string') continue
    const name = entry.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_NAME_CHARS)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= MAX_TAGS_PER_TASK) break
  }
  return out
}

/**
 * The colour a list or tag gets when its reader did not pick one.
 *
 * Derived from the name so two devices that create the same list independently agree, and so the
 * colour survives a restore that dropped the column. The palette is the one folders and note tags
 * already use: a second set of colours would be a second vocabulary for the same idea.
 */
export function defaultColorFor(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return ORGANIZER_COLORS[hash % ORGANIZER_COLORS.length]!
}

/**
 * The icon a task may store, or null when the value is not one.
 *
 * The same shape the task route already judges — control characters stripped, trimmed, no longer than
 * {@link MAX_TASK_ICON_CHARS}, an empty string read as "none" — because the route is not the only
 * door: the assistant's tools and the MCP surface write through the store directly, and a value that
 * reached a row by that road has to answer to the same rule. Refusing returns null rather than
 * throwing, so one bad value in a batch leaves the rest of the write standing.
 */
export function taskIconOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const icon = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!icon || icon.length > MAX_TASK_ICON_CHARS) return null
  return icon
}

/**
 * The colour a task may store, or null when the value is not one of the palette.
 *
 * {@link organizerColorOrNull} under the task's name, for the same reason {@link taskIconOrNull}
 * exists: the store is a second door beside the route, and a colour is a colour whichever door it
 * came through. A custom hex a reader mixed themselves stays allowed, lowercased, exactly as the
 * lists and tags that share the palette already allow it.
 */
export function taskColorOrNull(value: unknown): string | null {
  return typeof value === 'string' ? organizerColorOrNull(value) : null
}

/** One face field a task write named that its row will not carry. */
export interface TaskFaceDrop {
  field: 'icon' | 'color'
  /** What the caller has to send instead, in the words the surface repeats to whoever asked. */
  reason: string
}

/**
 * The face fields a write asked for and the shared guards refuse, judged by the guards themselves.
 *
 * The store's door answers an unusable icon or colour with null rather than a refusal, so a caller that
 * wrote through it could tell the reader the face was set when the row carries none — and null is also
 * what *clearing* a face writes, which is why the row alone cannot tell the two apart afterwards. This
 * is the half that says so: ask it what a patch will land and it names the fields that will not.
 *
 * It deliberately calls {@link taskIconOrNull} and {@link taskColorOrNull} rather than restating their
 * rules. The accept set is one rule with two doors (the route refuses, the store nulls); a second
 * spelling of it here is how the two would start disagreeing about what a face may be.
 */
export function taskFaceDrops(icon: unknown, color: unknown): TaskFaceDrop[] {
  const dropped: TaskFaceDrop[] = []
  // Absent, null and empty are the caller asking for no face, which is a write that lands exactly as
  // asked; only a value that meant something and will not reach the row is a loss.
  if (icon !== undefined && icon !== null && icon !== '' && taskIconOrNull(icon) === null) {
    dropped.push({
      field: 'icon',
      reason: `An icon is one emoji or an icon name such as Briefcase, at most ${MAX_TASK_ICON_CHARS} characters.`,
    })
  }
  if (color !== undefined && color !== null && color !== '' && taskColorOrNull(color) === null) {
    dropped.push({
      field: 'color',
      reason: 'A colour is one of the palette names or a six-digit hex such as #2563eb.',
    })
  }
  return dropped
}

/** The `done / total` a list card shows. A list with no tasks reads as `0 / 0`. */
export function taskListProgress(list: { openCount: number; doneCount: number }): { done: number; total: number } {
  return { done: list.doneCount, total: list.openCount + list.doneCount }
}

/**
 * The status a task moves to when its checkbox is pressed.
 *
 * The checkbox is the gesture for "flip this row between finished and not", so it reads off the open
 * set: work still owed becomes `done`, and anything that already stopped being owed becomes `todo`
 * again. A finished row reopens — that was the whole meaning while `done` was the only way to stop
 * owing a task. When the enum gained `cancelled`, the same press on an abandoned row reopens it rather
 * than quietly re-labeling it finished: the reader said "not going to do it", and one tap on the box
 * is the plain way to take that back. Choosing between finished and abandoned stays a deliberate edit
 * in the row's menu, not something the checkbox guesses at.
 */
export function toggledStatus(status: TaskStatus): TaskStatus {
  return isTaskOpen(status) ? 'done' : 'todo'
}

/** The priorities, ordered as the app shows them. Re-exported so callers need one import. */
export type { TaskPriority, TaskStatus }
