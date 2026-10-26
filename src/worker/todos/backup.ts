/**
 * The to-do app's rows as the scheduled archive can carry them.
 *
 * The section is a dump of `todos_*` rows in the shape the subscription section already uses — one object
 * of arrays keyed by table name, readable in a text editor, restored whole — with one addition the
 * subscription file does not need: the tables it covers are *enumerated from `todos/schema.ts`*. The
 * schema module already declares which tables the app owns, so this module reads that declaration, and a
 * table it has not been told about fails a test rather than quietly missing from every archive the account
 * makes afterwards. That drift is the whole finding this module answers: an app added to the schema and
 * left out of the backup keeps losing data in silence.
 *
 * No name in a statement comes from the file. Table names, column names and the `?n` placeholders are
 * built from this module's own constants; only *values* are read out of the document, and every one of
 * them passes a rule that judges it first, because a backup is external input and the server is the last
 * place that can say so.
 *
 * What the section deliberately does not carry:
 *
 *  - `todos_feeds` and `todos_mail_tokens`. A feed slug is a read grant over the whole task list and a
 *    mail token is a write grant over it, held in the clear so the settings screen can show the address
 *    again. Either one in a file that is emailed and sits in a bucket hands a reader of that file a way
 *    into the account that keeps working after the restore, which is exactly why the subscription section
 *    refuses its inbound token. Both are re-created in Settings, and a restore leaves a live feed or
 *    address alone rather than revoking something the file never described.
 *  - `todos_mail_messages`: the Message-Ids the mail path has already claimed. It is a delivery ledger,
 *    and restoring one neither files a message nor prevents one.
 *  - An interval that was still running when the archive was taken, and a habit stopwatch in the same
 *    state (`todos_counters.running_since`). Both travel as nothing: an open row restored hours or days
 *    later would bill every minute between the snapshot and the restore to that one task or habit, and no
 *    archive can know when the reader stopped it. Restored timers are at rest.
 *  - The bytes of a task's files. `todos_attachments` links a task to a row of the shared `attachments`
 *    table, while the archive's `attachments/` folder holds only the files note bodies mention, so task
 *    files do not travel. The link rows still do, and one is written only when the restoring account
 *    already holds that file — the common case, since the file hub is a different table a todo restore
 *    never touches — and every link the hub could not answer for is counted in the summary.
 *
 * Order matters in both directions and is derived rather than hand-listed: each table names the tables
 * whose ids its rows reference, and the topological order those edges produce is the write order, and
 * reversed, the clear order. A row's parents are therefore complete before the row is placed, which also
 * means a table another table points at must not drop rows while placing them — only the leaves may.
 *
 * Ids travel unchanged, because a step that names its task has to keep naming it after a restore; every
 * id in the file is checked against the repo's own guard before it reaches SQL, and a row that names an
 * account other than the restoring one is refused outright instead of being trusted with a session's
 * tenant column.
 *
 * A restore replaces this section's tables for one account and nothing else, so a restored account is not
 * the same as one that was never wiped: a habit that was mid-run is stopped, an interval that was open is
 * gone, a task's file is listed only if the hub still holds it, and the published feed and mail address it
 * used to have are waiting to be issued again. The summary says how many rows landed and which did not.
 */
import { TASK_PRIORITIES, TASK_STATUSES } from '@shared/assistant'
import {
  COUNTER_KINDS,
  MAX_COUNTER_DAY_AMOUNT,
  MAX_LIST_NAME_CHARS,
  MAX_STEP_TEXT_CHARS,
  MAX_TAG_NAME_CHARS,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TIME_ESTIMATE_MS,
  TIME_ENTRY_SOURCES,
  taskColorOrNull,
  taskIconOrNull,
} from '@shared/todos/model'
import { TODOS_REQUIRED_COLUMNS, TODOS_REQUIRED_TABLES } from './schema'
import { MAX_BATCH_STATEMENTS } from '../db/writes'
import { isValidId } from '../lib/id'

export const TODOS_BACKUP_VERSION = 1 as const

/** The task title ceiling the task route writes with, restated for the door that is not the route. */
const MAX_TASK_TITLE_CHARS = 300
/** A repeat rule is a small JSON document; the app's own ceiling on skipped days keeps it far below this. */
const MAX_REPEAT_RULE_CHARS = 4_096
/** The widest order a list or a step may hold. Positions are gaps a reader folds, not a count. */
const MAX_POSITION = 1_000_000
/** A task's revision number: every write moves it, and a restore keeps the count the account got to. */
const MAX_REV = 1_000_000_000

/** Ceilings on a restore. Above these the file is not one person's to-do list. */
const MAX_TASKS = 50_000
const MAX_ROWS_PER_TABLE = 500_000

/** The instants a file may name, and the day shape every day column holds. */
const STAMP_MAX = Date.UTC(9999, 11, 31, 23, 59, 59)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** The two kinds of history row the flow chart replays, as the store that writes them spells them. */
const TASK_EVENT_KINDS = ['born', 'status'] as const

/** The account column: bound from the session in every statement, never read out of the file. */
const TENANT_COLUMN = 'user_id'

/** A value the bind takes: what the column holds, or SQL NULL. */
type BoundValue = string | number | null
/** A row the file cannot describe: it leaves, and the answer says which column said so. */
const UNPLACABLE = Symbol('todos.backup.unplacable')
/**
 * A value that says the document is not this account's archive rather than merely untidy: an id the app
 * cannot make. References between the file's own rows are read by id, so one that was never an id makes
 * every row that names it meaningless, and the only honest answer is to refuse the whole restore before
 * it has written half of a task list.
 */
const UNTRUSTED = Symbol('todos.backup.untrusted')
/** One reason, recorded without its count so a bad file cannot grow the answer without bound. */
type Note = (reason: string) => void

interface ColumnRule {
  readonly column: string
  /**
   * The value to bind, `null`, {@link UNPLACABLE} when the row cannot be described, or
   * {@link UNTRUSTED} when the file itself is not to be believed.
   */
  read: (value: unknown, note: Note) => BoundValue | typeof UNPLACABLE | typeof UNTRUSTED
}

interface PreparedRow {
  [column: string]: BoundValue
}

type IdSets = ReadonlyMap<string, ReadonlySet<string>>

interface TodoTableSpec {
  /** What the summary and the reader are told this collection of rows is called. */
  readonly label: string
  /** The tables whose ids these rows name. They are written first and cleared last. */
  readonly dependsOn: readonly string[]
  /** The columns that make one row unique inside the account, and the order the export reads them in. */
  readonly key: readonly string[]
  /**
   * Columns the account holds only one of, spelled in the database's own words as a case-folded index.
   * A file that names two lists called `Work` is not restored twice: the database would refuse the
   * second row by breaking the batch it travels in, and everybody in that batch would lose their place.
   */
  readonly unique?: readonly string[]
  readonly ceiling: number
  readonly rules: readonly ColumnRule[]
  /**
   * One row once the ids it points at are known: a reference the file does not carry is nulled where the
   * column allows it, and the row leaves where it would otherwise be unreachable from every screen and
   * every later delete.
   */
  readonly place?: (row: PreparedRow, ids: IdSets, note: Note) => PreparedRow | null
  /** Rows the section does not export at all, in the database's own words. */
  readonly readFilter?: string
}

// ------------------------------------------------------------ column rules

function idRule(column: string, options: { notNull?: boolean } = {}): ColumnRule {
  return {
    column,
    read: (value) => {
      if (value === null || value === undefined || value === '') return options.notNull ? UNPLACABLE : null
      // The repo's own guard, before the value reaches a statement: ids are how the file's rows point at
      // each other, and a value that was never one cannot be repaired without breaking that map.
      return isValidId(value) ? value : UNTRUSTED
    },
  }
}

/**
 * A text column, with the two ways it can be missing kept apart.
 *
 * `notNull` is the column's own promise: a description the reader left empty is a real value, and an
 * absent one in a hand-edited file is not. `nonEmpty` is the app's promise — a task, a list or a step
 * with nothing written on it is not a row any screen can offer, so it leaves rather than landing blank.
 */
function textRule(
  column: string,
  max: number,
  options: { notNull?: boolean; nonEmpty?: boolean } = {},
): ColumnRule {
  return {
    column,
    read: (value, note) => {
      if (value === null || value === undefined) return options.notNull ? UNPLACABLE : null
      if (typeof value !== 'string') return UNPLACABLE
      // Control characters other than tab and line breaks are not text a reader wrote.
      const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      if (options.nonEmpty && !text.trim()) return UNPLACABLE
      if (text.length > max) {
        note(`${column} longer than the app stores, cut to fit`)
        return text.slice(0, max)
      }
      return text
    },
  }
}

function stampRule(column: string, options: { notNull?: boolean } = {}): ColumnRule {
  return {
    column,
    read: (value, note) => {
      if (value === null || value === undefined || value === '') {
        if (!options.notNull) return null
        note(`${column} named no instant, stamped with the restore's clock`)
        return Date.now()
      }
      const instant = Number(value)
      if (!Number.isSafeInteger(instant) || instant < 0 || instant > STAMP_MAX) {
        if (!options.notNull) return null
        note(`${column} named an instant the calendar cannot hold, stamped with the restore's clock`)
        return Date.now()
      }
      return instant
    },
  }
}

function intRule(column: string, options: { min: number; max: number; notNull?: boolean }): ColumnRule {
  return {
    column,
    read: (value, note) => {
      const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
      if (!Number.isFinite(number)) {
        if (!options.notNull) return null
        note(`${column} was not a number, set to the smallest the app allows`)
        return options.min
      }
      const whole = Math.trunc(number)
      if (whole < options.min || whole > options.max) {
        note(`${column} was outside what the app allows, pulled back inside`)
        return Math.min(options.max, Math.max(options.min, whole))
      }
      return whole
    },
  }
}

/** A position a reader folded between two neighbours: REAL, because a gap can be halved for ever. */
function realRule(column: string): ColumnRule {
  return {
    column,
    read: (value) => {
      const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
      return Number.isFinite(number) ? number : null
    },
  }
}

function flagRule(column: string): ColumnRule {
  return { column, read: (value) => (truthy(value) ? 1 : 0) }
}

function dayRule(column: string, options: { notNull?: boolean } = {}): ColumnRule {
  return {
    column,
    read: (value, note) => {
      if (value === null || value === undefined || value === '') {
        return options.notNull ? UNPLACABLE : null
      }
      if (typeof value === 'string' && DAY_RE.test(value) && isRealDay(value)) return value
      note(`${column} was not a calendar day`)
      return options.notNull ? UNPLACABLE : null
    },
  }
}

/**
 * A column that stores one of a fixed set of words.
 *
 * `fallback` is what the app's own default is, and a word outside the set comes back as it rather than
 * taking the row down with it: a status no view matches would hide a task the reader still owns, and a
 * restore is not allowed to lose a row over one adjective. The substitution is counted, because it is
 * still the file being wrong.
 */
function wordRule(column: string, allowed: readonly string[], fallback: string | null): ColumnRule {
  return {
    column,
    read: (value, note) => {
      if (typeof value === 'string' && allowed.includes(value)) return value
      if (value === null || value === undefined || value === '') return fallback
      note(`${column} was a word the app does not know, restored as ${fallback ?? 'none'}`)
      return fallback
    },
  }
}

function iconRule(column: string): ColumnRule {
  return {
    column,
    read: (value, note) => {
      const icon = taskIconOrNull(value)
      if (icon === null && value !== null && value !== undefined && value !== '') {
        note(`${column} was not an icon the app can show`)
      }
      return icon
    },
  }
}

function colorRule(column: string): ColumnRule {
  return {
    column,
    read: (value, note) => {
      const color = taskColorOrNull(value)
      if (color === null && value !== null && value !== undefined && value !== '') {
        note(`${column} was not a colour of the palette`)
      }
      return color
    },
  }
}

/** A rule the app replays rather than a number it counts: read back as JSON or not at all. */
function jsonRule(column: string, max: number): ColumnRule {
  return {
    column,
    read: (value, note) => {
      if (value === null || value === undefined || value === '') return null
      if (typeof value !== 'string' || value.length > max) {
        note(`${column} was not a rule the app can read`)
        return null
      }
      try {
        JSON.parse(value)
      } catch {
        // A repeat rule that will not parse is a rule the replay would stop at, which is what "none"
        // means to every reader of the column — and the count says the file had something else here.
        note(`${column} was not readable, restored as no rule`)
        return null
      }
      return value
    },
  }
}

function truthy(value: unknown): boolean {
  if (typeof value === 'number') return value === 1
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes'].includes(String(value ?? '').toLocaleLowerCase())
}

function isRealDay(value: string): boolean {
  const [year, month, day] = value.split('-').map((part) => Number(part))
  if (!year || !month || !day) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

// ------------------------------------------------------------ the reference graph

/** A reference into a table the file does not carry: the column is nullable, so the row stays and the
 *  nesting flattens. An inbox task and a top-level list are both readable; a dangling one is not. */
function flattenMissingParent(table: string, column: string, noun: string) {
  return (row: PreparedRow, ids: IdSets, note: Note): PreparedRow => {
    const value = row[column]
    if (typeof value === 'string' && !ids.get(table)?.has(value)) {
      note(`${column} named a ${noun} the file does not carry, restored at the top level`)
      row[column] = null
    }
    return row
  }
}

/**
 * The same flattening for a reference that points at the row itself.
 *
 * `flattenMissingParent` cannot see this one: the row's own id *is* in the file, so a task whose parent is
 * itself passes that check and lands in the account as a row nested inside itself — a tree a reader can
 * open forever. The same sentence covers both, because the repair is the same: put the row at the top.
 */
function flattenSelfOrMissingParent(table: string, keyColumn: string, column: string, noun: string) {
  return (row: PreparedRow, ids: IdSets, note: Note): PreparedRow => {
    const value = row[column]
    if (typeof value !== 'string') return row
    if (value === row[keyColumn] || !ids.get(table)?.has(value)) {
      note(`${column} named a ${noun} it cannot sit under, restored at the top level`)
      row[column] = null
    }
    return row
  }
}

/** Two placement steps, run in order — the second sees what the first left. */
function chainPlace(
  first: NonNullable<TodoTableSpec['place']>,
  second: NonNullable<TodoTableSpec['place']>,
): NonNullable<TodoTableSpec['place']> {
  return (row, ids, note) => {
    const placed = first(row, ids, note)
    return placed ? second(placed, ids, note) : null
  }
}

/**
 * A row whose parent the file does not carry is unreachable from every screen and every later delete, so
 * writing it would plant an orphan in the account instead of restoring a row. Every column the row names
 * is checked, because a link with one half missing means something a later read cannot undo: a tag no
 * task carries, or a blocker that can never be finished.
 */
function requireParents(nouns: Readonly<Record<string, readonly [table: string, noun: string]>>) {
  return (row: PreparedRow, ids: IdSets, note: Note): PreparedRow | null => {
    for (const [column, [table, noun]] of Object.entries(nouns)) {
      const value = row[column]
      if (typeof value === 'string' && !ids.get(table)?.has(value)) {
        note(`left out: the ${noun} it names is not in the file`)
        return null
      }
    }
    return row
  }
}

// ------------------------------------------------------------ the section

/**
 * One entry per table the section carries, keyed by the schema module's own table name.
 *
 * `TODOS_REQUIRED_TABLES` is what decides which tables exist; this map is what decides how each one
 * travels. A table the schema declares and this map does not — and `EXCLUDED_TABLES` does not either —
 * fails `tests/todo-backup-archive.test.ts`, which is the point: the day the app grows a `todos_*` table,
 * the archive has to be told, out loud.
 */
const TABLE_SPECS: Readonly<Record<string, TodoTableSpec>> = {
  todos_lists: {
    label: 'lists',
    dependsOn: [],
    key: ['id'],
    unique: ['name'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('id', { notNull: true }),
      textRule('name', MAX_LIST_NAME_CHARS, { notNull: true, nonEmpty: true }),
      iconRule('icon'),
      colorRule('color'),
      intRule('position', { min: 0, max: MAX_POSITION, notNull: true }),
      stampRule('archived_at'),
      idRule('parent_id'),
      stampRule('created_at', { notNull: true }),
      stampRule('updated_at', { notNull: true }),
    ],
    place: flattenMissingParent('todos_lists', 'parent_id', 'list'),
  },
  todos_tags: {
    label: 'tags',
    dependsOn: [],
    key: ['id'],
    unique: ['name'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('id', { notNull: true }),
      textRule('name', MAX_TAG_NAME_CHARS, { notNull: true, nonEmpty: true }),
      colorRule('color'),
      stampRule('created_at', { notNull: true }),
      stampRule('updated_at', { notNull: true }),
    ],
  },
  todos_counters: {
    label: 'habits',
    dependsOn: [],
    key: ['id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('id', { notNull: true }),
      // A habit's name is written under the list name's ceiling by the route that creates it.
      textRule('title', MAX_LIST_NAME_CHARS, { notNull: true, nonEmpty: true }),
      wordRule('kind', COUNTER_KINDS, 'clicks'),
      iconRule('icon'),
      colorRule('color'),
      intRule('goal', { min: 0, max: MAX_COUNTER_DAY_AMOUNT }),
      stampRule('created_at', { notNull: true }),
      stampRule('updated_at', { notNull: true }),
    ],
  },
  todos_tasks: {
    label: 'tasks',
    dependsOn: ['todos_lists'],
    key: ['id'],
    ceiling: MAX_TASKS,
    rules: [
      idRule('id', { notNull: true }),
      textRule('title', MAX_TASK_TITLE_CHARS, { notNull: true, nonEmpty: true }),
      textRule('description', MAX_TASK_DESCRIPTION_CHARS, { notNull: true }),
      wordRule('status', TASK_STATUSES, 'todo'),
      wordRule('priority', TASK_PRIORITIES, 'medium'),
      realRule('position'),
      stampRule('due_at'),
      stampRule('start_at'),
      intRule('time_estimate_ms', { min: 0, max: MAX_TIME_ESTIMATE_MS }),
      stampRule('completed_at'),
      dayRule('completed_on'),
      dayRule('created_on'),
      idRule('project_id'),
      idRule('list_id'),
      idRule('parent_id'),
      iconRule('icon'),
      colorRule('color'),
      flagRule('starred'),
      jsonRule('repeat_rule', MAX_REPEAT_RULE_CHARS),
      dayRule('planned_for'),
      idRule('note_id'),
      idRule('conversation_id'),
      stampRule('created_at', { notNull: true }),
      stampRule('updated_at', { notNull: true }),
      intRule('rev', { min: 1, max: MAX_REV, notNull: true }),
      stampRule('archived_at'),
      stampRule('deleted_at'),
    ],
    place: chainPlace(
      flattenMissingParent('todos_lists', 'list_id', 'list'),
      flattenSelfOrMissingParent('todos_tasks', 'id', 'parent_id', 'task'),
    ),
  },
  todos_reminders: {
    label: 'reminders',
    dependsOn: ['todos_tasks'],
    key: ['id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('id', { notNull: true }),
      idRule('task_id', { notNull: true }),
      stampRule('remind_at', { notNull: true }),
      // `fired_at` travels: a reminder the account already sent comes back already sent, or the next
      // sweep would hand the reader a pile of alarms they had years ago.
      stampRule('fired_at'),
      stampRule('created_at', { notNull: true }),
    ],
    place: requireParents({ task_id: ['todos_tasks', 'task'] }),
  },
  todos_task_events: {
    label: 'history rows',
    dependsOn: ['todos_tasks'],
    key: ['id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('id', { notNull: true }),
      idRule('task_id', { notNull: true }),
      stampRule('at', { notNull: true }),
      dayRule('on_day', { notNull: true }),
      wordRule('kind', TASK_EVENT_KINDS, 'status'),
      wordRule('from_status', TASK_STATUSES, null),
      wordRule('to_status', TASK_STATUSES, 'todo'),
    ],
    place: requireParents({ task_id: ['todos_tasks', 'task'] }),
  },
  todos_steps: {
    label: 'steps',
    dependsOn: ['todos_tasks'],
    key: ['id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('id', { notNull: true }),
      idRule('task_id', { notNull: true }),
      textRule('text', MAX_STEP_TEXT_CHARS, { notNull: true, nonEmpty: true }),
      flagRule('done'),
      intRule('position', { min: 0, max: MAX_POSITION, notNull: true }),
      stampRule('created_at', { notNull: true }),
    ],
    place: requireParents({ task_id: ['todos_tasks', 'task'] }),
  },
  todos_tag_links: {
    label: 'tag links',
    dependsOn: ['todos_tasks', 'todos_tags'],
    key: ['task_id', 'tag_id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('task_id', { notNull: true }),
      idRule('tag_id', { notNull: true }),
      stampRule('created_at', { notNull: true }),
    ],
    place: requireParents({ task_id: ['todos_tasks', 'task'], tag_id: ['todos_tags', 'tag'] }),
  },
  todos_task_links: {
    label: 'blocking links',
    dependsOn: ['todos_tasks'],
    key: ['task_id', 'depends_on_id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('task_id', { notNull: true }),
      idRule('depends_on_id', { notNull: true }),
      stampRule('created_at', { notNull: true }),
    ],
    // Both halves are checked: a task blocked by a row the file does not carry could never be finished,
    // and no later read could tell the reader why.
    place: requireParents({ task_id: ['todos_tasks', 'task'], depends_on_id: ['todos_tasks', 'blocker'] }),
  },
  todos_attachments: {
    label: 'task file links',
    dependsOn: ['todos_tasks'],
    key: ['task_id', 'attachment_id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('task_id', { notNull: true }),
      idRule('attachment_id', { notNull: true }),
      stampRule('created_at', { notNull: true }),
    ],
    place: requireParents({ task_id: ['todos_tasks', 'task'] }),
  },
  todos_time_entries: {
    label: 'ledger rows',
    dependsOn: ['todos_tasks'],
    key: ['id'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('id', { notNull: true }),
      idRule('task_id', { notNull: true }),
      stampRule('start_at', { notNull: true }),
      // Not null, and the reason is the open row: an interval with no end would bill every minute
      // between the archive and the restore to the task it names.
      stampRule('end_at', { notNull: true }),
      dayRule('day', { notNull: true }),
      wordRule('source', TIME_ENTRY_SOURCES, 'timer'),
      stampRule('created_at', { notNull: true }),
      stampRule('updated_at', { notNull: true }),
    ],
    place: requireParents({ task_id: ['todos_tasks', 'task'] }),
    readFilter: 'end_at IS NOT NULL',
  },
  todos_counter_ticks: {
    label: 'habit days',
    dependsOn: ['todos_counters'],
    key: ['counter_id', 'day'],
    ceiling: MAX_ROWS_PER_TABLE,
    rules: [
      idRule('counter_id', { notNull: true }),
      dayRule('day', { notNull: true }),
      intRule('amount', { min: 0, max: MAX_COUNTER_DAY_AMOUNT, notNull: true }),
    ],
    place: requireParents({ counter_id: ['todos_counters', 'habit'] }),
  },
}

/** Tables the section refuses, each with the reason the module header and the archive README repeat. */
const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  todos_feeds: 'a published feed address is a read grant over the whole task list, so it is re-published in Settings',
  todos_mail_tokens: 'the mail-to-task address is the write credential itself, so it is issued again in Settings',
  todos_mail_messages: 'a ledger of mail already delivered, which a restore neither replays nor prevents',
}

/**
 * Columns a carried table does not travel with, and why.
 *
 * The schema module's own `TODOS_REQUIRED_COLUMNS` decides which columns a table has, so a new column is
 * either given a rule above or named here; anything else fails the parity test rather than being dropped
 * from every archive in silence. `user_id` is not in this list because it is not a loss: it is bound from
 * the session in every statement, and a file that names a different one is refused.
 */
const EXCLUDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  todos_counters: ['running_since'],
}

// ------------------------------------------------------------ the API

export interface TodosBackupSummary {
  /** Rows the restore wrote, per carried table. */
  readonly rows: Readonly<Record<string, number>>
  /** Rows and values the file carried that the restore could not place, counted per reason. */
  readonly skipped: readonly string[]
}

/** The tables the section carries, in the order a restore writes them: parents before children. */
export function todosBackupCarriedTables(): readonly string[] {
  return CARRIED_TABLES
}

/** The tables the section refuses, with the reason for each. */
export function todosBackupExcludedTables(): Readonly<Record<string, string>> {
  return EXCLUDED_TABLES
}

/** The columns one carried table travels with, before the account column the file never holds. */
export function todosBackupCarriedColumns(table: string): readonly string[] {
  return carriedColumns(table)
}

/** The columns of a carried table the file never holds. */
export function todosBackupExcludedColumns(table: string): readonly string[] {
  return EXCLUDED_COLUMNS[table] ?? []
}

/**
 * The account's to-do data as JSON, or null when the account has none.
 *
 * Null rather than an empty document, exactly as the subscription section does it: an archive of a reader
 * who never opened the app should not grow a file that a restore then treats as "clear everything".
 */
export async function readBackupTodos(db: D1Database, userId: string): Promise<string | null> {
  const tables: Record<string, Array<Record<string, unknown>>> = {}
  let total = 0
  for (const table of CARRIED_TABLES) {
    const spec = specFor(table)
    const columns = carriedColumns(table)
    const { results } = await db.prepare(
      `SELECT ${columns.join(', ')} FROM ${table} WHERE ${TENANT_COLUMN} = ?1`
      + (spec.readFilter ? ` AND ${spec.readFilter}` : '')
      + ` ORDER BY ${spec.key.join(', ')}`,
    ).bind(userId).all<Record<string, unknown>>()
    tables[table] = results
    total += results.length
  }
  if (total === 0) return null
  return JSON.stringify({
    version: TODOS_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
  })
}

/**
 * Put a carried document back, replacing whatever the account has in these tables now.
 *
 * Replace rather than merge, because that is what "restore this backup" means and a merge would produce a
 * state that never existed at any moment — and because a restore that ran twice has to leave the same
 * rows, which only a replace can promise. The whole document is judged *before* anything is written: one
 * unreadable id or one row naming another account fails the restore as a whole rather than leaving the
 * account holding the first ninety per cent of a task list.
 */
export async function applyBackupTodos(
  db: D1Database,
  userId: string,
  carried: unknown,
): Promise<TodosBackupSummary> {
  const tables = parseDocument(carried)
  const notes = new Map<string, number>()
  const validated = new Map<string, PreparedRow[]>()
  const ids = new Map<string, Set<string>>()

  // First pass: judge every row and collect the ids the file really holds, in the order the references
  // are written in. Nothing is dropped for a missing parent yet, because a table's own rows are what its
  // children — and in the case of a list, itself — are checked against.
  for (const table of CARRIED_TABLES) {
    const spec = specFor(table)
    const note: Note = (reason) => countNote(notes, `${spec.label} - ${reason}`)
    const rows: PreparedRow[] = []
    const seen = new Set<string>()
    // Two lists of the same name, or two tags, would break the unique index the account keeps them apart
    // by — and a batch that breaks takes every row in its chunk with it. The second one leaves.
    const named = new Set<string>()
    for (const raw of fileRows(tables[table], spec, note)) {
      const row = readRow(spec, raw, userId, note)
      if (!row) continue
      const key = spec.key.map((column) => String(row[column] ?? '')).join('|')
      if (seen.has(key)) {
        note('repeated a row the file had already carried')
        continue
      }
      if (spec.unique) {
        const name = spec.unique.map((column) => String(row[column] ?? '').toLocaleLowerCase()).join('|')
        if (named.has(name)) {
          note(`repeated a ${spec.unique.join(' + ')} the account can hold only once`)
          continue
        }
        named.add(name)
      }
      seen.add(key)
      rows.push(row)
    }
    validated.set(table, rows)
    ids.set(table, heldIds(spec, rows))
  }

  for (const name of Object.keys(tables)) {
    if (!CARRIED_SET.has(name)) countNote(notes, `${name} names a table this build does not restore`)
  }

  // Second pass: place each row against the ids around it. A table another table names is never dropped
  // here — the ones that leave are leaves — so the sets the children were checked against stay true.
  const kept = new Map<string, PreparedRow[]>()
  for (const table of CARRIED_TABLES) {
    const spec = specFor(table)
    const note: Note = (reason) => countNote(notes, `${spec.label} - ${reason}`)
    const rows: PreparedRow[] = []
    for (const row of validated.get(table) ?? []) {
      const placed = spec.place ? spec.place(row, ids, note) : row
      if (placed) rows.push(placed)
    }
    kept.set(table, rows)
  }

  const statements: D1PreparedStatement[] = []
  for (const table of [...CARRIED_TABLES].reverse()) {
    statements.push(db.prepare(`DELETE FROM ${table} WHERE ${TENANT_COLUMN} = ?1`).bind(userId))
  }
  // `todos_attachments` points outside the section, at the shared file hub. A link is written only where
  // the account still holds the file, because a link to a row nobody owns is unreachable by every screen
  // that reads it — and the count says how many the hub could not answer for.
  const linkRows = kept.get('todos_attachments') ?? []
  const heldFiles = linkRows.length > 0 ? await loadAttachmentIds(db, userId) : null
  const written: Record<string, number> = {}
  for (const table of CARRIED_TABLES) {
    const spec = specFor(table)
    const note: Note = (reason) => countNote(notes, `${spec.label} - ${reason}`)
    const columns = carriedColumns(table)
    const sql = `INSERT INTO ${table} (${[TENANT_COLUMN, ...columns].join(', ')})`
      + ` VALUES (${[TENANT_COLUMN, ...columns].map((_, index) => `?${index + 1}`).join(', ')})`
    let landed = 0
    for (const row of kept.get(table) ?? []) {
      if (table === 'todos_attachments' && !heldFiles?.has(String(row.attachment_id))) {
        note('left out: the account holds no such file')
        continue
      }
      // The account is the session's, never the file's: it is the value written here and the predicate on
      // every statement around it, so no row a file names can land in somebody else's shelves.
      const values: BoundValue[] = [userId, ...columns.map((column) => row[column] ?? null)]
      statements.push(db.prepare(sql).bind(...values))
      landed += 1
    }
    written[table] = landed
  }

  await batchInChunks(db, statements)
  return { rows: written, skipped: [...notes].map(([reason, total]) => `${total} ${reason}`) }
}

// ------------------------------------------------------------ reading a file

function parseDocument(carried: unknown): Record<string, unknown> {
  const parsed = typeof carried === 'string' ? safeParse(carried) : carried
  if (!isRecord(parsed)) throw new Error('The backup contains no readable to-do data')
  if (parsed.version !== TODOS_BACKUP_VERSION) {
    throw new Error(`Unsupported to-do backup version: ${String(parsed.version)}`)
  }
  if (parsed.tables === undefined) return {}
  if (!isRecord(parsed.tables)) throw new Error("The backup's to-do tables are not a list of tables")
  return parsed.tables
}

/**
 * The rows one table's key holds, judged in bulk first.
 *
 * A ceiling is not a preference: past it the document is not one person's task list, and a restore that
 * tried would trade a transaction for a file nobody meant to send.
 */
function fileRows(value: unknown, spec: TodoTableSpec, note: Note): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`The backup's ${spec.label} are not a list`)
  if (value.length > spec.ceiling) {
    throw new Error(`The backup carries ${value.length} ${spec.label}, over the ${spec.ceiling} limit`)
  }
  const rows = value.filter(isRecord)
  if (rows.length !== value.length) note('held an entry that is not a row at all')
  return rows
}

function readRow(spec: TodoTableSpec, raw: Record<string, unknown>, userId: string, note: Note): PreparedRow | null {
  const account = raw[TENANT_COLUMN]
  if (account !== undefined && account !== null && account !== userId) {
    // The one thing a file may not be allowed to do is name whose row this is; the tenant column of
    // every statement comes from the session, and a file that disagrees is not this account's archive.
    throw new Error(`The backup carries a ${spec.label} row that belongs to another account`)
  }
  const row: PreparedRow = {}
  for (const rule of spec.rules) {
    const value = rule.read(raw[rule.column], note)
    if (value === UNTRUSTED) {
      throw new Error(`The backup carries a ${spec.label} row whose ${rule.column} is not one the app makes`)
    }
    if (value === UNPLACABLE) {
      note(`left out: ${rule.column} is not a value the app can store`)
      return null
    }
    row[rule.column] = value
  }
  return row
}

/** The ids of the rows that survived, in the shape the tables below them are checked against. */
function heldIds(spec: TodoTableSpec, rows: readonly PreparedRow[]): Set<string> {
  const held = new Set<string>()
  // A single-column key is a table's own id, which is what the tables below it name. A composite key is
  // a relationship between two of them, and nothing references a relationship.
  if (spec.key.length !== 1) return held
  const column = spec.key[0]!
  for (const row of rows) {
    const value = row[column]
    if (typeof value === 'string') held.add(value)
  }
  return held
}

async function loadAttachmentIds(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db.prepare(
    `SELECT id FROM attachments WHERE user_id = ?1`,
  ).bind(userId).all<{ id: string }>()
  return new Set((results ?? []).map((row) => row.id))
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Null is the caller's "this archive holds nothing readable", which it already has to answer: the
    // whole document is judged before a single row is written.
    return null
  }
}

// ------------------------------------------------------------ writing them back

/** D1 refuses an oversized batch, and a decade of a busy account's history is a plausible archive. */
async function batchInChunks(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += MAX_BATCH_STATEMENTS) {
    await db.batch(statements.slice(offset, offset + MAX_BATCH_STATEMENTS))
  }
}

function specFor(table: string): TodoTableSpec {
  const spec = TABLE_SPECS[table]
  if (!spec) throw new Error(`The to-do backup has no plan for the table ${table}`)
  return spec
}

/**
 * The carried tables, ordered by the references their rows declare.
 *
 * Derived from `TODOS_REQUIRED_TABLES` rather than written out again, so the archive cannot drift behind
 * the schema by forgetting a name: a table the schema declares and this module has no plan for lands in
 * neither list and fails the parity test. The tie-break is the schema's own declaration order, so the
 * result is the same on every boot and in every test.
 */
const CARRIED_TABLES: readonly string[] = restoreOrder()
const CARRIED_SET: ReadonlySet<string> = new Set(CARRIED_TABLES)
const CARRIED_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map(
  CARRIED_TABLES.map((table) => [table, planColumns(table)]),
)

/**
 * The columns one carried table travels with, in the order the schema module declares them.
 *
 * Judged when the module loads rather than only in the parity test: a column the schema declares and this
 * module neither carries nor refuses would otherwise be dropped out of every archive in silence — the same
 * failure the table list is built to make impossible, one level down. A rule for a column nothing declares
 * is refused in the same breath, because it would only be a statement that cannot be prepared.
 */
function carriedColumns(table: string): readonly string[] {
  const columns = CARRIED_COLUMNS.get(table)
  if (!columns) throw new Error(`The to-do backup carries no columns for ${table}`)
  return columns
}

function planColumns(table: string): readonly string[] {
  const spec = specFor(table)
  const declared = TODOS_REQUIRED_COLUMNS[table] ?? []
  if (declared.length === 0) throw new Error(`The to-do schema declares no columns for ${table}`)
  const rules = new Set(spec.rules.map((rule) => rule.column))
  const refused = new Set(EXCLUDED_COLUMNS[table] ?? [])
  for (const rule of spec.rules) {
    if (!declared.includes(rule.column)) {
      throw new Error(`The to-do backup plans ${table}.${rule.column}, which the schema does not declare`)
    }
  }
  const carried: string[] = []
  for (const column of declared) {
    if (column === TENANT_COLUMN) continue
    if (refused.has(column)) continue
    if (!rules.has(column)) throw new Error(`The to-do backup has no plan for ${table}.${column}`)
    carried.push(column)
  }
  return carried
}

function restoreOrder(): string[] {
  const tables = TODOS_REQUIRED_TABLES.filter((table) => table in TABLE_SPECS)
  const wanted = new Set(tables)
  const emitted = new Set<string>()
  const ordered: string[] = []
  while (ordered.length < tables.length) {
    const next = tables.find(
      (table) => !emitted.has(table)
        && TABLE_SPECS[table]!.dependsOn.every((parent) => !wanted.has(parent) || emitted.has(parent)),
    )
    if (!next) {
      // Only a hand-edited plan can make a table wait for itself; the alternative is an archive that
      // restores in an order nobody can read.
      throw new Error(`The to-do backup's table references cannot be ordered: ${tables.join(', ')}`)
    }
    emitted.add(next)
    ordered.push(next)
  }
  return ordered
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function countNote(notes: Map<string, number>, reason: string): void {
  notes.set(reason, (notes.get(reason) ?? 0) + 1)
}
