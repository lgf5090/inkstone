/**
 * The todo module's vocabulary, shared by the worker, the client and the tests.
 *
 * A task itself is the assistant's `Task` — the tool layer has written that shape since the chat
 * could create one — and this module only adds the fields the to-do app needs on top of it. Keeping
 * the extension here rather than widening `Task` means a backup, a shared conversation or an old
 * answer version never has to learn about lists and tags it does not carry.
 */

import type { Task, TaskPriority, TaskStatus } from '../assistant'
import { isTaskDone, isTaskOpen } from './status'
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
 *
 * The rest of the fields describe the *series* rather than the rhythm, and they all live in this one
 * JSON column on purpose: a series needs a little state (how many occurrences it has produced, which
 * days the reader let go), and giving it a table would mean a migration, a second place where a task
 * is copied, and a new way for the two to disagree. The rule rides with the row and is copied with it,
 * so the counter moves on exactly when the next occurrence is created and nowhere else.
 */
export interface RepeatRule {
  freq: RepeatFrequency
  interval: number
  /** Weekly only: 0 = Sunday … 6 = Saturday, ascending and deduplicated. */
  weekdays?: number[]
  /** Monthly only: which day of the month the next occurrence lands on. */
  monthlyMode?: RepeatMonthlyMode
  /**
   * The last instant this series may produce an occurrence for.
   *
   * An instant rather than a day because the ceiling has to be compared with the same clock the
   * occurrence is computed on; a day would need a zone to become comparable and the zone is the
   * account's, not the rule's.
   */
  untilAt?: number | null
  /**
   * How many occurrences the series produces in total, the row being finished counted as one of them.
   *
   * Read together with {@link produced}; a rule written before either field existed counts the row it
   * sits on as the first occurrence, which is the only reading that does not silently restart a
   * series the reader has already run three times.
   */
  count?: number | null
  /** How many occurrences this series has created, this row included. Maintained by the advance. */
  produced?: number
  /**
   * Count the next occurrence from the day the reader finished rather than from the old due date.
   *
   * Off by default, and the default is the whole point: finishing Thursday's report on Friday morning
   * should put the next one on next Thursday, not permanently move the rhythm onto Fridays.
   */
  fromCompletionDate?: boolean
  /** Stop producing occurrences without deleting the series or losing its place. */
  paused?: boolean
  /**
   * Days (`YYYY-MM-DD`, the reader's own) this series steps over without landing on.
   *
   * One missed week can be let go without pausing the whole rhythm, which is what a pause would
   * wrongly promise: the series would stay stopped until somebody remembered to start it again.
   */
  excludedDays?: string[]
}

export const REPEAT_MONTHLY_MODES = ['day', 'lastDay', 'nthWeekday'] as const
export type RepeatMonthlyMode = (typeof REPEAT_MONTHLY_MODES)[number]

export const MIN_REPEAT_INTERVAL = 1
export const MAX_REPEAT_INTERVAL = 99

/**
 * How many occurrences a bounded series may ask for.
 *
 * The same ceiling covers the counter that reads it: a series can never produce more than it was
 * allowed to ask for, so one bound keeps a hand-edited rule from outgrowing the field that limits it.
 */
export const MIN_REPEAT_COUNT = 1
export const MAX_REPEAT_COUNT = 999

/**
 * How many days a series may step over.
 *
 * Exceptions are the odd missed week, not a calendar: at this length the list is a second rhythm, and
 * one that the rule's own frequency no longer describes.
 */
export const MAX_REPEAT_EXCLUDED_DAYS = 60

/**
 * The furthest day a series may promise to end on.
 *
 * A ceiling rather than a sanity check: `Date` accepts any number below 8.64e15, so a hand-edited
 * rule could name a date the calendar itself cannot render, and the advance that compares against it
 * would compute an occurrence out of nothing. Year 9999 is further out than any rhythm a reader sets.
 */
export const MAX_REPEAT_UNTIL_MS = Date.UTC(9999, 11, 31, 23, 59, 59)

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

/**
 * The reminder tiers live in `todos/reminders`, a module with no imports of its own, and are re-exported
 * here so the rest of the app has one door to the to-do vocabulary. They cannot live *in* this file:
 * `shared/constants.ts` has to read the same list to validate `todo.defaultRemind`, and this module
 * reaches `organizer-colors`, which reaches `constants` — the ring would close.
 */
export {
  REMIND_OFFSETS,
  REMIND_OFFSET_MS,
  isRemindOffset,
  remindAtFor,
  remindOffsetForDelta,
} from './reminders'
export type { RemindOffset, RemindTier } from './reminders'

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
/**
 * The shape `GET /api/todos/export?format=json` answers with.
 *
 * Declared here rather than in the worker because both sides read it: the route builds it, the app hands
 * it to a file and a reader who restores one needs the `truncated` mark to survive the trip — a document
 * that walks only part of an account is a partial answer, and saying so is the difference between a
 * backup and a false sense of one.
 */
export interface TodoExportDocument {
  format: 'inkstone-todos'
  version: 1
  exportedAt: number
  timezone: string
  /** How many rows the walk took in, which is the ceiling when {@link truncated} says the walk stopped. */
  total: number
  truncated: boolean
  tasks: TodoTask[]
}
/** A completed list is history: the newest page is enough to answer "what did I finish". */
export const COMPLETED_PAGE_SIZE = 200
/** One page of the trash: a holding area, not a shelf, so its pages are smaller than the listing's. */
export const TRASH_PAGE_SIZE = 50
/**
 * One page of the shelf, which has the same job: a management screen a reader opens to find one thing,
 * not a list to work in. Its own name rather than `TRASH_PAGE_SIZE` because the two windows answer for
 * different pages — a retention sweep can change how long the trash holds rows, and nothing about that
 * has anything to say about the shelf.
 */
export const SHELF_PAGE_SIZE = 50

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
 *
 * `archive` is the shelf the day's closing gesture puts rows on, and `value` on it is a boolean: true
 * files the row, false takes it back — which is what lets the selection bar's undo mean something.
 */
export const TASK_BATCH_OPS = ['complete', 'delete', 'move', 'priority', 'star', 'tag', 'due', 'archive'] as const
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

/**
 * One end of a dependency, as the row that names it carries it: enough to read aloud, and enough to say
 * whether the wait is over.
 *
 * The status travels because "waiting on the report" and "waiting on the report (already done)" are
 * different facts for the reader, and re-reading the task table to work out which one it is would be a
 * second answer to a question the link already knows.
 */
export interface TaskRef {
  id: string
  title: string
  status: TaskStatus
}

/** Whether this row is still owed something else before it can be considered finished. */
export function taskIsBlocked(task: Pick<TodoTask, 'dependsOn'>): boolean {
  return task.dependsOn.some((entry) => !isTaskDone(entry.status))
}

export interface TodoTask extends Task {
  listId: string | null
  /**
   * The task this one is a step of, or null for a row that stands on its own.
   *
   * A place in a tree, not a second kind of row: a child is listed, counted, due, timed and exported like
   * any other task, and nothing about its status is inherited from the parent. The parent's added power is
   * only to gather its children next to it on the grouped listings, which is a reading of the rows already
   * on the page — a child whose parent is not on this page is shown at the top level, not hidden.
   *
   * The chain is kept acyclic, shallow and this-account-only by the store on write; see `checkedTaskParent`.
   */
  parentId: string | null
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
  /**
   * The tasks this one waits on, and the tasks waiting on it, as the reader arranged them.
   *
   * A dependency is a fact about order, not about visibility: a blocked task stays on the board, in the
   * badges, on the calendar and in the statistics exactly where it would be with none, because hiding it
   * would make the counts disagree with the rows a reader can see. What the pair adds is the chance to
   * say *why* a row is still open.
   *
   * Both sides are read from `todos_task_links` on every listing that returns rows, the way `tags` is,
   * and each carries the blocker's live status rather than a stored verdict — finishing a task unblocks
   * its dependents without a write ever touching them. Judge "is this waiting" with {@link taskIsBlocked}
   * rather than by re-reading the statuses here.
   */
  dependsOn: TaskRef[]
  blocks: TaskRef[]
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
   * When the reader put this task away, or null while it is in front of them.
   *
   * The shelf and the trash are different answers, and the difference is what the row keeps: an archived
   * task is not deleted — its status and its hours are untouched, it stays in the statistics, in every
   * export, sync and backup, and `getTask` still answers for its id. What it loses is the screens: the
   * working surfaces *and* the completed list, which is what makes closing a day change anything at all.
   * One rule states it, in `taskVisible`, rather than four screens each remembering to ask.
   */
  archivedAt?: number | null
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
 * The series fields, gated before they are read.
 *
 * Each guard accepts an absent field and refuses a shape this app could not have written — the same
 * trade the weekday list makes. Dropping a malformed ceiling would be the quiet answer, and a series
 * that runs past the day the reader said it ends is a rule they never asked for; refusing it instead
 * costs a rhythm the reader did write, so the wrongness has to be loud, which on the write side it is
 * (the route answers 400) and on the read side it is not (the row stops repeating) — which is why the
 * only writer of these fields is this app's own editor and store.
 */
function isRepeatNumberField(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isInteger(value))
}

function isRepeatBooleanField(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean'
}

const REPEAT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isRepeatExcludedDays(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!Array.isArray(value) || value.length > MAX_REPEAT_EXCLUDED_DAYS) return false
  return value.every((day) => typeof day === 'string' && REPEAT_DAY_PATTERN.test(day))
}

/**
 * Reads a stored repeat rule.
 *
 * Returns null rather than throwing: a row written by an older build, or by a hand-edited backup,
 * must not take the whole listing down with it. An unknown shape simply means "does not repeat".
 * A modifier that does not belong to the rule's frequency is left out instead of refusing the rule:
 * an extra field is not a reason to forget the rhythm the reader did write.
 *
 * Every field of the rule is read here, including the one only the server writes (`produced`).
 * This function is the only way a stored rule becomes a value again — the row decoders, the sync
 * merge and the backup import all go through it — so a field left out would not merely be hidden:
 * the counter would reset on the next read, and a bounded series would restart instead of ending.
 * Absent and cleared are read as the same answer, because a rule that names no limit has none.
 */
export function parseRepeatRule(value: unknown): RepeatRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isRepeatFrequency(raw.freq)) return null
  const interval = typeof raw.interval === 'number' && Number.isFinite(raw.interval)
    ? Math.trunc(raw.interval)
    : 1
  if (interval < MIN_REPEAT_INTERVAL || interval > MAX_REPEAT_INTERVAL) return null
  if (raw.weekdays !== undefined && normalizeWeekdays(raw.weekdays) === null) return null
  if (raw.monthlyMode !== undefined && !isRepeatMonthlyMode(raw.monthlyMode)) return null
  if (!isRepeatNumberField(raw.untilAt) || !isRepeatNumberField(raw.count) || !isRepeatNumberField(raw.produced)) return null
  if (!isRepeatBooleanField(raw.paused) || !isRepeatBooleanField(raw.fromCompletionDate)) return null
  if (!isRepeatExcludedDays(raw.excludedDays)) return null
  const untilAt = typeof raw.untilAt === 'number' ? raw.untilAt : null
  const count = typeof raw.count === 'number' ? raw.count : null
  const produced = typeof raw.produced === 'number' ? raw.produced : null
  if (untilAt !== null && (untilAt <= 0 || untilAt > MAX_REPEAT_UNTIL_MS)) return null
  if (count !== null && (count < MIN_REPEAT_COUNT || count > MAX_REPEAT_COUNT)) return null
  if (produced !== null && (produced < 0 || produced > MAX_REPEAT_COUNT)) return null
  const rule: RepeatRule = { freq: raw.freq, interval }
  if (raw.freq === 'weekly') {
    const weekdays = normalizeWeekdays(raw.weekdays)
    if (weekdays?.length) rule.weekdays = weekdays
  }
  if (raw.freq === 'monthly' && raw.monthlyMode !== undefined && raw.monthlyMode !== 'day') {
    rule.monthlyMode = raw.monthlyMode
  }
  if (untilAt !== null) rule.untilAt = untilAt
  if (count !== null) rule.count = count
  if (produced !== null) rule.produced = produced
  if (raw.paused === true) rule.paused = true
  if (raw.fromCompletionDate === true) rule.fromCompletionDate = true
  if (Array.isArray(raw.excludedDays)) {
    const days = [...new Set(raw.excludedDays as string[])].sort()
    if (days.length) rule.excludedDays = days
  }
  return rule
}

/**
 * The series a row already runs, kept under a rhythm a caller named over the top of it.
 *
 * Two of the app's doors build a rule out of what a model typed, and a model has no words for a
 * ceiling, a pause or a day let go of: asked to make a task fortnightly, it names only the fortnight.
 * Writing that rule alone would delete a limit the reader never mentioned, so the series rides over.
 *
 * The two modifiers are decided by the frequency they modify rather than carried blindly: `weekdays`
 * and `monthlyMode` say which days a *given* rhythm lands on, so naming the same rhythm again without
 * them keeps the days already picked, while a different rhythm starts without days it cannot mean.
 */
export function withPreviousSeries(rule: RepeatRule, previous: RepeatRule | null | undefined): RepeatRule {
  if (!previous) return rule
  const sameRhythm = previous.freq === rule.freq
  return {
    ...previous,
    ...rule,
    weekdays: sameRhythm ? rule.weekdays ?? previous.weekdays : rule.weekdays,
    monthlyMode: sameRhythm ? rule.monthlyMode ?? previous.monthlyMode : rule.monthlyMode,
  }
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

/**
 * The nth (1–5) weekday of a month, falling back to the month's last one when it has only four.
 *
 * Exported because the quick-add parser has to land a typed `every 2nd monday` on the same day this
 * advance will land the next occurrence on. Two copies of this rule would put the reader's first
 * occurrence on one day and every occurrence after it on another.
 */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
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

/** How far the skipped-day walk will look ahead before it gives up, so a fully-excluded rhythm cannot spin. */
const MAX_REPEAT_SKIPS = 400

/** The reader's own `YYYY-MM-DD` for an instant, built from the same parts every day rule already uses. */
function zonedDay(instant: number, timeZone: string): string {
  const parts = getZonedParts(new Date(instant), timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/** Why a series stopped producing occurrences, in words a surface can repeat back. */
export type RepeatStop = 'paused' | 'until' | 'count'

export interface RepeatAdvance {
  /** The instant the next occurrence is owed at, or `null` when the series has stopped. */
  dueAt: number | null
  /** Set only when `dueAt` is null: which ceiling the series ran into. */
  stopped?: RepeatStop
  /**
   * The rule to carry onto the next occurrence, with its own counter moved on.
   *
   * Equal to the incoming rule when the series stopped — a finished series has no row to write to,
   * and handing back a moved counter there would make a reopen count an occurrence nobody made.
   */
  rule: RepeatRule
}

/**
 * The next occurrence a series owes, and whether it owes one at all.
 *
 * One function owns every reason a repeat can stop, because each of them is a promise the reader made
 * through the same JSON column and two of them (`untilAt`, `count`) are only honest if they are checked
 * against the *same* candidate date the occurrence is created from. Checked against a date computed
 * elsewhere, a series can silently produce one occurrence too many on the boundary day.
 *
 * `anchorDueAt` is the row's own due date, or null when it never had one; `completedAt` is the instant
 * the reader finished it. A series with no due date and no completion-day anchor has nothing to count
 * from, and the caller already declines to date the next occurrence in that case — see `completeTask`.
 */
export function advanceRepeat(
  rule: RepeatRule,
  opts: { anchorDueAt: number | null, completedAt: number, timeZone: string },
): RepeatAdvance {
  if (rule.paused) return { dueAt: null, stopped: 'paused', rule }
  // Counted from the old due date unless the reader asked otherwise. The default is the whole point:
  // finishing Thursday's report on Friday morning should put the next one on next Thursday.
  const anchor = rule.fromCompletionDate ? opts.completedAt : (opts.anchorDueAt ?? opts.completedAt)
  // How many occurrences exist so far, this row included. A rule written before the counter existed
  // counts its own row as the first, which is the only reading that does not restart a series the
  // reader has already run three times.
  const produced = Math.max(1, Math.trunc(rule.produced ?? 1))
  if (rule.count != null && produced >= rule.count) return { dueAt: null, stopped: 'count', rule }
  const excluded = rule.excludedDays?.length ? new Set(rule.excludedDays) : null
  let candidate = nextOccurrence(anchor, rule, opts.timeZone)
  // A skipped day steps over to the next one rather than cancelling the occurrence: the rhythm goes on,
  // only this landing is let go. Bounded, so a reader who excluded every day the rule can land on gets
  // a stopped series rather than a hung request.
  for (let skips = 0; excluded && excluded.has(zonedDay(candidate, opts.timeZone)); skips += 1) {
    if (skips >= MAX_REPEAT_SKIPS) return { dueAt: null, stopped: 'until', rule }
    candidate = nextOccurrence(candidate, rule, opts.timeZone)
    if (rule.count != null && produced + skips + 1 >= rule.count) return { dueAt: null, stopped: 'count', rule }
  }
  if (rule.untilAt != null && candidate > rule.untilAt) return { dueAt: null, stopped: 'until', rule }
  return { dueAt: candidate, rule: { ...rule, produced: produced + 1 } }
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

/**
 * The dimensions the worklog groups tracked hours by.
 *
 * Three, because those are the three ways the app already files a task: the list it is in, the tags it
 * wears, and itself. A tag is deliberately allowed to overlap — the same hour appears under each of the
 * task's tags — which is why the breakdown is read one dimension at a time and never summed.
 */
export const WORKLOG_DIMENSIONS = ['list', 'tag', 'task'] as const
export type WorklogDimension = (typeof WORKLOG_DIMENSIONS)[number]

/** How many groups one reading answers with; the rest is counted, not dropped. */
export const WORKLOG_GROUP_LIMIT = 8

/** One bucket of the breakdown. */
export interface WorklogGroup {
  key: string
  label: string
  trackedMs: number
}

/** The hours the ledger holds over a window, read one dimension at a time. */
export interface Worklog {
  range: { from: string, to: string, dimension: WorklogDimension }
  /** Time the account actually spent inside the window, counting only closed spans. */
  totalMs: number
  /** How many closed spans that came from — the difference between forty hours and forty minutes. */
  entryCount: number
  /** Every day in the window, worked on or not: a day nobody touched is a zero, not an absence. */
  byDay: { day: string, trackedMs: number }[]
  byGroup: WorklogGroup[]
  /** Groups the window held beyond `WORKLOG_GROUP_LIMIT`, named rather than silently dropped. */
  truncatedGroups: number
  /** Tasks that finished in the window with a plan attached, and how many of them outgrew it. */
  estimatedCount: number
  overEstimateCount: number
  /**
   * `overEstimateCount / estimatedCount`, or `null` when nothing was planned.
   *
   * Null rather than zero, because a `0` here reads as "you never overrun" to an account that has
   * never typed an estimate — the absence of a denominator is not a result.
   */
  overEstimateRate: number | null
}

/**
 * The end-of-day pass: the four questions one close-out asks about one day.
 *
 * Four buckets, not one filtered page, because the four want different answers and share nothing else:
 * what the day finished, what the day touched but left open, what is already behind the reader, and
 * what tomorrow already holds. They are read together so the screen answers one snapshot — a pass that
 * files rows while it is open would otherwise re-cut the other three under the reader's hands.
 */
export interface FinishDayBucket {
  /** The rows, in the order the plate would have shown them. */
  rows: TodoTask[]
  /**
   * Rows the bucket held beyond the page this answer carries.
   *
   * Named rather than dropped: a close-out that quietly shows the first fifty of ninety finished tasks
   * would let the reader believe the day held fifty.
   */
  more: number
}

export interface FinishDay {
  /** The account-zone day the pass describes, and the one after it, as `YYYY-MM-DD`. */
  day: string
  tomorrow: string
  timezone: string
  /**
   * Time the ledger holds for that day, closed spans only.
   *
   * This is the worklog's own number for a one-day window, taken from the same statement, because the
   * day-close page and the statistics must not be able to disagree about how much of the day was spent.
   * The end-of-day pass reads it against the length the account plans for a working day.
   */
  trackedMs: number
  /** Closed on this day, still off the shelf. The bucket the pass files away. */
  done: FinishDayBucket
  /** Still open, with a closed span on the ledger for this day. */
  worked: FinishDayBucket
  /** Still open, due before the moment the pass was read. */
  overdue: FinishDayBucket
  /** Still open, picked for tomorrow or due inside it. */
  planned: FinishDayBucket
}

/**
 * What a habit counts, in its own unit.
 *
 * Two kinds, because those are the two questions a habit answers: how many times, and how long. The
 * reference app carries a third — "every N minutes, ask me" — which is a recurring alarm rather than a
 * record, and belongs beside the reminder sweep instead of here.
 */
export const COUNTER_KINDS = ['clicks', 'stopwatch'] as const
export type CounterKind = (typeof COUNTER_KINDS)[number]

export function isCounterKind(value: unknown): value is CounterKind {
  return typeof value === 'string' && (COUNTER_KINDS as readonly string[]).includes(value)
}

/**
 * How many habits one account may hold.
 *
 * Forty is well past what the screen reads — a row each, with the days behind it — and a ceiling has to
 * live somewhere before a client's list of habits can be taken at its word.
 */
export const MAX_COUNTERS_PER_ACCOUNT = 40

/**
 * The largest amount one habit-day may hold.
 *
 * A day only has this many seconds, and a tap count past it is a client that mistyped a unit. The same
 * ceiling serves both kinds, so the clamp that enforces it holds no branch.
 */
export const MAX_COUNTER_DAY_AMOUNT = 24 * 60 * 60

/** How many days one reading covers: a year and its leap, so the heat map can show a whole year. */
export const COUNTER_WINDOW_DAYS = 366

/** One habit, as the reader named it: what it counts, and what a full day of it would be. */
export interface TodoCounter {
  id: string
  title: string
  kind: CounterKind
  icon: string | null
  color: string | null
  /**
   * What a full day is, in the kind's own unit — seconds for a stopwatch, taps for a counter.
   *
   * Null is not zero: "no target" and "a target of nothing" are different answers, and the run of days
   * a screen counts has to know which one it is measuring.
   */
  goal: number | null
  /** The instant this habit's own stopwatch began running, or null while it is stopped. */
  runningSince: number | null
  createdAt: number
  updatedAt: number
}

/** One day's amount for one habit — the cell a heat map shades. */
export interface CounterDay {
  day: string
  amount: number
}

/**
 * One habit's days over one window, read from the day the account is in.
 *
 * Every day between `from` and `to` is present, tapped or not: a day nobody did is a zero rather than
 * an absence, and a map that skipped it would show a gap the reader never chose.
 */
export interface CounterHistory {
  from: string
  to: string
  /** The account's own today, so a run of days is counted back from the right day. */
  today: string
  days: CounterDay[]
}

/** What the habits screen shows for one habit: its row, and the days behind it. */
export interface CounterReading extends CounterHistory {
  counter: TodoCounter
}

/** The whole habits screen in one answer: the reader's day, and every habit with its days. */
export interface CounterReadings {
  today: string
  readings: CounterReading[]
}

/** What a day holds after a tap: the total the database arrived at, not the step that was asked for. */
export interface CounterTick {
  day: string
  amount: number
}

/** A stopped run: the habit as it now stands, and the day its seconds landed on — or none. */
export interface CounterStop {
  counter: TodoCounter
  filed: CounterDay | null
}

/**
 * Whether one day counts toward a run: the target, or any amount at all when none was set.
 *
 * One function rather than a condition at each caller, because the streak beside a row's name and the
 * shading of its cell must not be able to answer "did today count" differently.
 */
export function counterDayMet(amount: number, goal: number | null): boolean {
  return goal === null ? amount > 0 : amount >= goal
}

/** The priorities, ordered as the app shows them. Re-exported so callers need one import. */
export type { TaskPriority, TaskStatus }
