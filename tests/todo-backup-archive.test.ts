// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { buildSnapshot, materializeSnapshot } from '../src/worker/backup/snapshot'
import { BACKUP_TODOS_NAME, parseMarkdownBackupManifest } from '../src/shared/backup-format'
import { sha256Hex } from '../src/worker/lib/encoding'
import {
  TODOS_BACKUP_VERSION,
  applyBackupTodos,
  readBackupTodos,
  todosBackupCarriedColumns,
  todosBackupCarriedTables,
  todosBackupExcludedColumns,
  todosBackupExcludedTables,
} from '../src/worker/todos/backup'
import { TODOS_REQUIRED_COLUMNS, TODOS_REQUIRED_TABLES } from '../src/worker/todos/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * The archive's to-do section: what it carries, what it refuses, and what a restore may write.
 *
 * Three claims are worth the file. The section must cover *every* table the schema declares — a backup
 * that misses the newest one is the bug this whole module exists to stop, and only a test against the
 * schema's own list can catch it before the archive does. The round trip must put rows back unchanged,
 * because ids are how the file's rows point at each other and a restore that minted new ones would keep
 * the shape of a task list while emptying it of meaning. And a file the server does not trust has to be
 * refused whole, because a half-applied archive is a state the reader never had and cannot name.
 */

const USER = 'user-alice'
const OTHER = 'user-bob'

/** Ids the app could have made: the alphabet `lib/id` writes, padded to the length it writes. */
const idOf = (prefix: string): string => prefix.padEnd(26, '0')
const LIST = idOf('grp')
const SECTION = idOf('grp2')
const TAG = idOf('tag')
const TASK = idOf('task')
const ARCHIVED = idOf('task2')
const TRASHED = idOf('task3')
const STEP = idOf('step')
const REMINDER = idOf('rem')
const EVENT = idOf('evt')
const ENTRY = idOf('ent')
const OPEN_ENTRY = idOf('ent2')
const HABIT = idOf('hab')
const ATTACHMENT = idOf('att')
const NOTE = idOf('mem')
const SLUG = idOf('feed').slice(0, 20)

const TASK_COLUMNS = [
  'user_id', 'id', 'title', 'description', 'status', 'priority', 'position', 'due_at', 'start_at',
  'time_estimate_ms', 'completed_at', 'completed_on', 'created_on', 'project_id', 'list_id', 'icon', 'color',
  'starred', 'repeat_rule', 'planned_for', 'note_id', 'conversation_id', 'created_at', 'updated_at', 'rev',
  'archived_at', 'deleted_at',
] as const

let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite))
})

function insert(table: string, columns: readonly string[], values: Array<string | number | null>): void {
  sqlite.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...values)
}

/**
 * One row of most tables, and a second of the ones where the app keeps more than one answer.
 *
 * The two rows a restore cannot honour are seeded on purpose — an interval still running and a habit
 * stopwatch mid-run — because "the archive never holds one" is a claim about the export, and proving it
 * takes something to leave out.
 */
function seed(): void {
  insert('todos_lists',
    ['user_id', 'id', 'name', 'icon', 'color', 'position', 'archived_at', 'parent_id', 'created_at', 'updated_at'],
    [USER, LIST, 'Work', 'lucide:Briefcase', '#2563eb', 0, null, null, 1, 2])
  insert('todos_lists',
    ['user_id', 'id', 'name', 'icon', 'color', 'position', 'archived_at', 'parent_id', 'created_at', 'updated_at'],
    [USER, SECTION, 'Billing', null, null, 1, null, LIST, 1, 2])
  insert('todos_tags', ['user_id', 'id', 'name', 'color', 'created_at', 'updated_at'],
    [USER, TAG, 'Tax', '#e11d48', 1, 2])
  insert('todos_tasks', TASK_COLUMNS,
    [USER, TASK, 'File the return', 'Two lines\nof notes', 'in_progress', 'urgent', 1.5, 1_800_000_000_000,
      null, 900_000, null, null, '2026-10-19', null, LIST, 'lucide:Timer', '#2563eb', 1,
      '{"freq":"weekly","interval":2,"mode":"all"}', '2026-10-20', NOTE, null, 10, 11, 4, null, null])
  insert('todos_tasks', TASK_COLUMNS,
    [USER, ARCHIVED, 'Old quarter', '', 'done', 'medium', null, null, null, null, 1_800_000_100_000,
      '2026-10-21', '2026-10-01', null, null, null, null, 0, null, null, null, null, 10, 12, 2,
      1_800_000_200_000, null])
  insert('todos_tasks', TASK_COLUMNS,
    [USER, TRASHED, 'Gone', '', 'todo', 'low', null, null, null, null, null, null, '2026-10-02', null, null,
      null, null, 0, null, null, null, null, 10, 11, 1, null, 1_800_000_300_000])
  insert('todos_steps', ['user_id', 'id', 'task_id', 'text', 'done', 'position', 'created_at'],
    [USER, STEP, TASK, 'Collect receipts', 1, 0, 1])
  insert('todos_reminders', ['user_id', 'id', 'task_id', 'remind_at', 'fired_at', 'created_at'],
    [USER, REMINDER, TASK, 1_800_000_400_000, 1_800_000_350_000, 1])
  insert('todos_task_events', ['user_id', 'id', 'task_id', 'at', 'on_day', 'kind', 'from_status', 'to_status'],
    [USER, EVENT, TASK, 1_800_000_500_000, '2026-10-20', 'status', 'todo', 'in_progress'])
  insert('todos_tag_links', ['user_id', 'task_id', 'tag_id', 'created_at'], [USER, TASK, TAG, 1])
  insert('todos_task_links', ['user_id', 'task_id', 'depends_on_id', 'created_at'], [USER, TRASHED, TASK, 1])
  insert('todos_time_entries',
    ['user_id', 'id', 'task_id', 'start_at', 'end_at', 'day', 'source', 'created_at', 'updated_at'],
    [USER, ENTRY, TASK, 1_800_000_600_000, 1_800_000_700_000, '2026-10-20', 'focus', 1, 2])
  insert('todos_time_entries',
    ['user_id', 'id', 'task_id', 'start_at', 'end_at', 'day', 'source', 'created_at', 'updated_at'],
    [USER, OPEN_ENTRY, TASK, 1_800_000_800_000, null, '2026-10-21', 'timer', 1, 1])
  insert('todos_counters',
    ['user_id', 'id', 'title', 'kind', 'icon', 'color', 'goal', 'running_since', 'created_at', 'updated_at'],
    [USER, HABIT, 'Water', 'clicks', null, null, 8, 1_800_000_900_000, 1, 2])
  insert('todos_counter_ticks', ['user_id', 'counter_id', 'day', 'amount'], [USER, HABIT, '2026-10-20', 3])
  insert('attachments',
    ['id', 'user_id', 'scope', 'filename', 'mime', 'size', 'sha256', 'storage', 'created_at'],
    [ATTACHMENT, USER, 'todos', 'contract.pdf', 'application/pdf', 12, 'hash', 'r2', 1])
  insert('todos_attachments', ['user_id', 'task_id', 'attachment_id', 'created_at'], [USER, TASK, ATTACHMENT, 1])
  insert('todos_feeds', ['slug', 'user_id', 'password_hash', 'expires_at', 'revoked_at', 'created_at'],
    [SLUG, USER, null, null, null, 1])
  insert('todos_mail_tokens', ['user_id', 'token', 'created_at'], [USER, 'a-token-never-sent', 1])
  insert('todos_mail_messages', ['user_id', 'message_id', 'created_at'], [USER, 'mid@host', 1])
}

/** The same tasks under a second account: the tenant is the only column that differs. */
function copyTasksToOther(): void {
  for (const row of sqlite.prepare('SELECT * FROM todos_tasks WHERE user_id = ?').all(USER) as
    Array<Record<string, string | number | null>>) {
    const columns = Object.keys(row)
    insert('todos_tasks', columns, columns.map((column) => (column === 'user_id' ? OTHER : row[column])))
  }
}

/** Every table's rows for one account, in an order that does not depend on the engine's collation. */
function tableRows(userId = USER): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {}
  for (const table of TODOS_REQUIRED_TABLES) {
    const rows = sqlite.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId) as
      Array<Record<string, unknown>>
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    out[table] = rows
  }
  return out
}

function db(): D1Database {
  return env.DB as D1Database
}

async function snapshot(): Promise<string> {
  const text = await readBackupTodos(db(), USER)
  if (text === null) throw new Error('The account had no to-do data to export.')
  return text
}

/** A file with something in it changed, the way an opened archive would be. */
function edited(text: string, edit: (document: BackupFile) => void): string {
  const document = JSON.parse(text) as BackupFile
  edit(document)
  return JSON.stringify(document)
}

interface BackupFile {
  version: number
  tables: Record<string, Array<Record<string, unknown>>>
}

/** Wipes the account's rows in the tables the section owns. */
function wipeCarried(): void {
  for (const table of todosBackupCarriedTables()) sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(USER)
}

describe('the section covers the schema', () => {
  /** Tables the given list holds that the section neither carries nor refuses. */
  function uncoveredTables(all: readonly string[]): string[] {
    const known = new Set([...todosBackupCarriedTables(), ...Object.keys(todosBackupExcludedTables())])
    return all.filter((table) => !known.has(table))
  }

  /** A carried table's columns the section neither carries nor refuses, the account column aside. */
  function uncoveredColumns(table: string): string[] {
    const known = new Set([...todosBackupCarriedColumns(table), ...todosBackupExcludedColumns(table), 'user_id'])
    return (TODOS_REQUIRED_COLUMNS[table] ?? []).filter((column: string) => !known.has(column))
  }

  it('decides every table the schema declares, exactly once', () => {
    expect(uncoveredTables(TODOS_REQUIRED_TABLES)).toEqual([])
    const refused = Object.keys(todosBackupExcludedTables())
    expect(todosBackupCarriedTables().filter((table) => refused.includes(table))).toEqual([])
    // The other direction: a plan for a table the schema does not declare is a table nothing creates.
    expect(todosBackupCarriedTables().filter((table) => !TODOS_REQUIRED_TABLES.includes(table))).toEqual([])
    for (const table of todosBackupCarriedTables()) expect(TODOS_REQUIRED_COLUMNS[table]).toBeDefined()
  })

  it('goes red when a table appears in the schema and not in the section', () => {
    // The tripwire proved by the thing it is for: a table declared and unfed. Without this line the check
    // above is only an assertion about today — and `todos_task_links` is the one that already arrived.
    expect(uncoveredTables([...TODOS_REQUIRED_TABLES, 'todos_zz_probe'])).toEqual(['todos_zz_probe'])
  })

  it('decides every column of every table it carries', () => {
    for (const table of todosBackupCarriedTables()) expect(uncoveredColumns(table)).toEqual([])
    // Same tripwire one level down: a column the schema grows is carried or refused on purpose.
    const columns = [...(TODOS_REQUIRED_COLUMNS.todos_tasks ?? []), 'blocked_by']
    const known = new Set([...todosBackupCarriedColumns('todos_tasks'), 'user_id'])
    expect(columns.filter((column) => !known.has(column))).toEqual(['blocked_by'])
  })

  it('writes parents before the rows that name them', () => {
    const order = todosBackupCarriedTables()
    const ownerOf: Record<string, string> = {
      list_id: 'todos_lists',
      task_id: 'todos_tasks',
      tag_id: 'todos_tags',
      counter_id: 'todos_counters',
      parent_id: 'todos_lists',
    }
    for (const table of order) {
      for (const [column, owner] of Object.entries(ownerOf)) {
        if (owner === table || !order.includes(owner)) continue
        if (!(TODOS_REQUIRED_COLUMNS[table] ?? []).includes(column)) continue
        expect(order.indexOf(owner), `${table}.${column} names ${owner}`).toBeLessThan(order.indexOf(table))
      }
    }
  })
})

describe('a round trip through the archive', () => {
  it('puts every carried row back where it was', async () => {
    seed()
    const before = tableRows()
    const text = await snapshot()
    wipeCarried()
    sqlite.prepare('DELETE FROM todos_feeds WHERE user_id = ?').run(USER)
    sqlite.prepare('DELETE FROM todos_mail_tokens WHERE user_id = ?').run(USER)
    sqlite.prepare('DELETE FROM todos_mail_messages WHERE user_id = ?').run(USER)
    expect(Object.values(tableRows()).every((rows) => rows.length === 0)).toBe(true)

    const summary = await applyBackupTodos(db(), USER, text)

    const expected: Record<string, Array<Record<string, unknown>>> = {
      ...before,
      // The two documented losses: an interval with no end, and a stopwatch nobody stopped.
      todos_time_entries: before.todos_time_entries.filter((row) => row.end_at !== null),
      todos_counters: before.todos_counters.map((row) => ({ ...row, running_since: null })),
      // A restore republishes nothing, so the tables the section refuses come back empty of their own.
      todos_feeds: [],
      todos_mail_tokens: [],
      todos_mail_messages: [],
    }
    expect(tableRows()).toEqual(expected)
    expect(summary.rows.todos_tasks).toBe(3)
    expect(summary.skipped).toEqual([])
  })

  it('carries no credential and no half-started timer', async () => {
    seed()
    const text = await snapshot()
    const document = JSON.parse(text) as BackupFile

    expect(Object.keys(document.tables)).not.toContain('todos_feeds')
    expect(Object.keys(document.tables)).not.toContain('todos_mail_tokens')
    expect(text).not.toContain('a-token-never-sent')
    expect(text).not.toContain(SLUG)
    expect(text).not.toContain('running_since')
    // The tenant is the session's, never the file's: a row cannot say whose it is.
    expect(text).not.toContain('user_id')
    expect(document.tables.todos_time_entries).toHaveLength(1)
    expect(document.tables.todos_tasks).toHaveLength(3)
  })

  it('says nothing about an account that never used the app', async () => {
    expect(await readBackupTodos(db(), USER)).toBeNull()
  })

  it('leaves another account alone', async () => {
    seed()
    copyTasksToOther()
    const other = tableRows(OTHER)

    await applyBackupTodos(db(), USER, await snapshot())

    expect(tableRows(OTHER)).toEqual(other)
    expect(tableRows(USER).todos_tasks).toHaveLength(3)
  })

  it('puts the same rows back a second time', async () => {
    seed()
    const text = await snapshot()
    wipeCarried()

    await applyBackupTodos(db(), USER, text)
    const once = tableRows()
    await applyBackupTodos(db(), USER, text)

    expect(tableRows()).toEqual(once)
    expect(once.todos_tasks).toHaveLength(3)
    expect(once.todos_tag_links).toHaveLength(1)
    expect(once.todos_attachments).toHaveLength(1)
  })

  it('keeps a live feed and mail address a restore never mentions', async () => {
    seed()
    const before = tableRows()
    const text = await snapshot()
    // The ordinary case: the task tables are lost, the file hub and the published addresses are not.
    wipeCarried()

    await applyBackupTodos(db(), USER, edited(text, () => {}))

    expect(tableRows().todos_feeds).toEqual(before.todos_feeds)
    expect(tableRows().todos_mail_tokens).toEqual(before.todos_mail_tokens)
    expect(tableRows().todos_mail_messages).toEqual(before.todos_mail_messages)
  })
})

describe('a file the server does not trust', () => {
  it('refuses an archive that is not readable at all', async () => {
    seed()
    const text = await snapshot()
    wipeCarried()

    await expect(applyBackupTodos(db(), USER, 'not json')).rejects.toThrow(/readable/i)
    await expect(applyBackupTodos(db(), USER, edited(text, (file) => { file.version = 99 })))
      .rejects.toThrow(/version/i)
    expect(tableRows().todos_tasks).toHaveLength(0)
  })

  it('refuses a row that belongs to another account, and applies none of the file', async () => {
    seed()
    const text = await snapshot()
    wipeCarried()
    const smuggled = edited(text, (file) => {
      file.tables.todos_tasks.find((entry) => entry.id === TASK)!.user_id = OTHER
    })

    await expect(applyBackupTodos(db(), USER, smuggled)).rejects.toThrow(/another account/i)
    // Nothing half-applied: the account stays exactly as the failed restore found it.
    expect(tableRows().todos_tasks).toHaveLength(0)
  })

  it('refuses an id the app cannot make rather than rewriting what points at it', async () => {
    seed()
    const text = await snapshot()
    wipeCarried()
    const forged = edited(text, (file) => {
      file.tables.todos_tasks.find((entry) => entry.id === TASK)!.id = '../../../other-account'
    })

    await expect(applyBackupTodos(db(), USER, forged)).rejects.toThrow(/not one the app makes/i)
    expect(tableRows().todos_tasks).toHaveLength(0)
  })

  it('refuses a task list bigger than one person has', async () => {
    seed()
    const text = await snapshot()
    const padded = edited(text, (file) => {
      const row = file.tables.todos_tasks[0]!
      file.tables.todos_tasks = Array.from({ length: 50_001 }, () => ({ ...row }))
    })

    await expect(applyBackupTodos(db(), USER, padded)).rejects.toThrow(/over the 50000 limit/)
  })
})

describe('a row the file cannot place', () => {
  /** Seeds, exports, and hands the document to the emptied account with one edit applied. */
  async function restore(edit: (file: BackupFile) => void) {
    seed()
    const text = await snapshot()
    wipeCarried()
    const summary = await applyBackupTodos(db(), USER, edited(text, edit))
    return { summary, rows: tableRows() }
  }

  it('leaves a step whose task the file does not carry out, and says so', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_tasks = file.tables.todos_tasks.filter((entry) => entry.id !== TASK)
    })

    expect(rows.todos_steps).toHaveLength(0)
    expect(rows.todos_tasks).toHaveLength(2)
    // A habit is not a task, so its days survive the loss of one row of the task table.
    expect(rows.todos_counter_ticks).toHaveLength(1)
    const notes = summary.skipped.join('\n')
    expect(notes).toMatch(/steps - left out: the task it names is not in the file/)
    expect(notes).toMatch(/reminders - left out/)
    expect(notes).toMatch(/ledger rows - left out/)
    expect(notes).toMatch(/blocking links - left out: the blocker it names is not in the file/)
  })

  it('levels a task whose list the file does not carry', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_lists = file.tables.todos_lists.filter((entry) => entry.id !== LIST)
    })

    expect(rows.todos_tasks.find((entry) => entry.id === TASK)?.list_id).toBeNull()
    expect(rows.todos_lists.find((entry) => entry.id === SECTION)?.parent_id).toBeNull()
    // Flattened rather than lost: the column is nullable, and an inbox task is a readable task.
    expect(rows.todos_tasks).toHaveLength(3)
    const notes = summary.skipped.join('\n')
    expect(notes).toMatch(/tasks - list_id named a list the file does not carry/)
    expect(notes).toMatch(/lists - parent_id named a list the file does not carry/)
  })

  it('levels a row the file nested inside itself, on both trees', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_lists.find((entry) => entry.id === SECTION)!.parent_id = SECTION
      file.tables.todos_tasks.find((entry) => entry.id === TASK)!.parent_id = TASK
    })

    // A row whose parent is itself passes "is that id in the file" — its own id is — and lands as a place
    // in a tree nothing can draw. Both trees are flattened rather than dropped.
    expect(rows.todos_lists.find((entry) => entry.id === SECTION)?.parent_id).toBeNull()
    expect(rows.todos_tasks.find((entry) => entry.id === TASK)?.parent_id).toBeNull()
    expect(rows.todos_lists).toHaveLength(2)
    expect(rows.todos_tasks).toHaveLength(3)
    const notes = summary.skipped.join('\n')
    expect(notes).toMatch(/lists - parent_id named the list itself/)
    expect(notes).toMatch(/tasks - parent_id named the task itself/)
  })

  it('drops a task file link the account holds no file for', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_attachments[0]!.attachment_id = idOf('att2')
    })

    expect(rows.todos_attachments).toHaveLength(0)
    expect(summary.skipped.join('\n'))
      .toMatch(/task file links - left out: the account holds no such file/)
  })

  it('keeps one of two rows the account can only hold once', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_tags.push({ ...file.tables.todos_tags[0]!, id: idOf('tag2'), name: 'tax' })
    })

    // Case-folded, because `idx_todos_tags_unique` is: `Tax` and `tax` are one tag to the database, and a
    // second insert would break the batch the rest of the file is travelling in.
    expect(rows.todos_tags).toHaveLength(1)
    expect(summary.skipped.join('\n')).toMatch(/tags - repeated a name the account can hold only once/)
  })

  it('folds a word the app does not know and says what it happened to', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_tasks.find((entry) => entry.id === TASK)!.status = 'shimmering'
    })

    expect(rows.todos_tasks.find((entry) => entry.id === TASK)?.status).toBe('todo')
    expect(summary.skipped.join('\n')).toMatch(/tasks - status was a word the app does not know/)
  })

  it('refuses to file a task under a day that is not one', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_tasks.find((entry) => entry.id === TASK)!.created_on = '2026-02-30'
    })

    expect(rows.todos_tasks.find((entry) => entry.id === TASK)?.created_on).toBeNull()
    expect(summary.skipped.join('\n')).toMatch(/tasks - created_on was not a calendar day/)
  })

  it('leaves out an entry that is not a row, and a table this build does not know', async () => {
    const { summary, rows } = await restore((file) => {
      file.tables.todos_steps.push(null as unknown as Record<string, unknown>)
      file.tables.todos_tasks.find((entry) => entry.id === TASK)!.title = '   '
      file.tables.todos_zz_future = [{ id: idOf('zzz') }]
    })

    // The blank title takes the task with it, and the task's step and link go with the task.
    expect(rows.todos_tasks).toHaveLength(2)
    expect(rows.todos_steps).toHaveLength(0)
    const notes = summary.skipped.join('\n')
    expect(notes).toMatch(/steps - held an entry that is not a row at all/)
    expect(notes).toMatch(/tasks - left out: title is not a value the app can store/)
    expect(notes).toMatch(/todos_zz_future names a table this build does not restore/)
  })

  it('applies an empty document without writing anything', async () => {
    seed()
    const text = JSON.stringify({ version: TODOS_BACKUP_VERSION, exportedAt: new Date().toISOString(), tables: {} })
    wipeCarried()

    const summary = await applyBackupTodos(db(), USER, text)

    expect(Object.values(summary.rows).every((landed) => landed === 0)).toBe(true)
    expect(tableRows().todos_tasks).toHaveLength(0)
  })
})

describe('the archive itself', () => {
  /** The manifest and the section file, read out of the snapshot the way the archive would carry them. */
  async function packed(userId = USER) {
    const files = await materializeSnapshot(await buildSnapshot(env, userId))
    const text = (name: string): string => {
      const file = files.find((entry) => entry.path === name)
      if (!file) throw new Error(`The archive holds no ${name}.`)
      return new TextDecoder().decode(file.body)
    }
    return { files, text, manifest: parseMarkdownBackupManifest(JSON.parse(text('manifest.json'))) }
  }

  it('puts the section in the payload and pins it in the manifest', async () => {
    seed()
    const { files, text, manifest } = await packed()
    const todos = files.find((file) => file.path === BACKUP_TODOS_NAME)
    const declared = manifest?.todos

    expect(todos?.contentType).toBe('application/json; charset=utf-8')
    expect(declared).toEqual({
      path: BACKUP_TODOS_NAME,
      bytes: new TextEncoder().encode(text(BACKUP_TODOS_NAME)).byteLength,
      sha256: await sha256Hex(new TextEncoder().encode(text(BACKUP_TODOS_NAME))),
    })
    // What the archive carries is what the restore reads. It is handed to a second account on purpose:
    // the task tables travel, the file hub does not, so the one link the archive cannot honour is refused
    // out loud rather than written as a row no screen can reach.
    const summary = await applyBackupTodos(db(), OTHER, text(BACKUP_TODOS_NAME))
    expect(summary.rows.todos_tasks).toBe(3)
    expect(summary.skipped).toEqual(['1 task file links - left out: the account holds no such file'])
    expect(tableRows(OTHER).todos_tasks).toHaveLength(3)
    expect(tableRows(OTHER).todos_attachments).toHaveLength(0)
  })

  it('names the section in the archive README, refusals included', async () => {
    seed()
    const { text } = await packed()
    const readme = text('README.txt')

    expect(readme).toContain(BACKUP_TODOS_NAME)
    // An archive whose own documentation skips a section is a wrong fact, so the two things the section
    // refuses to carry are stated on the same line as the one it adds.
    expect(readme).toMatch(/todos\.json[\s\S]*(calendar feed|mail-to-task)[\s\S]*(Settings|re-created)/)
  })

  it('writes no section for an account that never used the app', async () => {
    const { files, manifest } = await packed()

    expect(files.some((file) => file.path === BACKUP_TODOS_NAME)).toBe(false)
    expect(manifest?.todos).toBeUndefined()
  })
})
