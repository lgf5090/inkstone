// @vitest-environment node
/**
 * `chat_notifications.link`: the screen a delivered notice was about, carried on the row.
 *
 * A reminder that cannot be opened from is a delivery with the last step missing. The row said what
 * arrived and whether the reader had looked; it never said where the thing itself lives, so pressing the
 * notice could only ever show a list. The link is that pointer, spelled `<app>:<id>` — today `todo:<task
 * id>` — and it is deliberately not a URL: the row must not carry an address the deployment did not choose
 * (an open redirect waiting to be handed to a browser), while an app-and-id pair is resolved by the client,
 * which already knows how to reach a task and what to do when the reader cannot.
 *
 * Version 128 spends one column, as every version here does. The three properties that matter are that an
 * account predating it gets the column on its next boot, that the writer keeps what it was given and answers
 * null for what it was not, and that the backup carries it across — `chat_notifications` is in the export,
 * so a column that is exported but not in the import allowlist is a pointer a restore quietly loses.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase, REQUIRED_COLUMNS, SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { ASSISTANT_REQUIRED_COLUMNS, ASSISTANT_SCHEMA_STATEMENTS } from '../src/worker/assistant/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { exportAssistant, importAssistant, type AssistantBackup } from '../src/worker/assistant/backup'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
const LINK_VERSION = 128
const COLUMN = 'link'

interface ColumnInfo {
  name: string
  notnull: number
  dflt_value: string | null
}

function columnsOf(sqlite: DatabaseSync, table: string): ColumnInfo[] {
  return sqlite.prepare(`SELECT * FROM pragma_table_info(?)`).all(table) as unknown as ColumnInfo[]
}

function linkColumn(sqlite: DatabaseSync): ColumnInfo | undefined {
  return columnsOf(sqlite, 'chat_notifications').find((entry) => entry.name === COLUMN)
}

/** A database as a deployed account has it: booted, with the fingerprint and the ledger written. */
async function installed(): Promise<{ sqlite: DatabaseSync, env: ReturnType<typeof testBindings> }> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  const env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  await initializeDatabase(env)
  return { sqlite, env }
}

/** The boot a deploy performs, with the stored fingerprint that would otherwise return early dropped. */
async function reboot(sqlite: DatabaseSync): Promise<void> {
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
  await initializeDatabase(testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' }))
}

/** The notification table as the shape before version 128, with every later boot able to notice it is missing. */
function dropLinkColumn(sqlite: DatabaseSync): void {
  sqlite.prepare('ALTER TABLE chat_notifications DROP COLUMN ' + COLUMN).run()
}

describe('the version that gives a notification its pointer', () => {
  it('spends 128 on one nullable column of the notification table and nothing else', () => {
    const entries = SCHEMA_MIGRATIONS.filter((migration) => migration.version === LINK_VERSION)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.skipIfColumnExists).toEqual({ table: 'chat_notifications', column: COLUMN })
    expect(entry.statements).toHaveLength(1)
    expect(entry.statements[0]).toBe(`ALTER TABLE chat_notifications ADD COLUMN ${COLUMN} TEXT`)
    // Nullable with no default: "nobody said where this came from" is a fact, not an empty pointer.
    expect(entry.statements[0]).not.toMatch(/NOT NULL/i)
    expect(entry.statements[0]).not.toMatch(/DEFAULT/i)
  })

  it('asks the table for the column, so a fresh database has it without a migration', () => {
    const created = ASSISTANT_SCHEMA_STATEMENTS.find((text) => /CREATE TABLE IF NOT EXISTS chat_notifications/.test(text))
    expect(created).toBeDefined()
    expect(created).toContain(`${COLUMN} TEXT`)
    expect(ASSISTANT_REQUIRED_COLUMNS.chat_notifications).toContain(COLUMN)
    expect(REQUIRED_COLUMNS.chat_notifications).toContain(COLUMN)
  })

  it('gives an account that predates the column the column on its next boot', async () => {
    const { sqlite } = await installed()
    expect(linkColumn(sqlite)).toBeDefined()
    dropLinkColumn(sqlite)
    sqlite.prepare('DELETE FROM schema_migrations WHERE version = ?').run(LINK_VERSION)
    expect(linkColumn(sqlite)).toBeUndefined()

    await reboot(sqlite)
    const column = linkColumn(sqlite)
    expect(column, 'the boot that runs the migration must land the column').toBeDefined()
    expect(column!.notnull, 'a delivered notice predating the column says nothing about where it came from').toBe(0)
  })

  it('heals the column when the ledger claims 128 ran and the shape says it did not', async () => {
    const { sqlite } = await installed()
    dropLinkColumn(sqlite)
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).all(LINK_VERSION)).toHaveLength(1)
    expect(linkColumn(sqlite)).toBeUndefined()

    await reboot(sqlite)
    expect(linkColumn(sqlite), 'a spent version number must not be able to hide the column').toBeDefined()
  })
})

describe('what the writer keeps', () => {
  let sqlite: DatabaseSync
  let env: ReturnType<typeof testBindings>
  let store: AssistantStore

  beforeEach(async () => {
    const fresh = await installed()
    sqlite = fresh.sqlite
    env = fresh.env
    store = new AssistantStore(env.DB as D1Database, USER, env)
  })

  it('carries the pointer it was given, and answers null for a notice nobody pointed', async () => {
    const pointed = await store.createNotification({ title: 'Renew the lease', body: 'Due today', link: 'todo:0123456789abcdefghjkmnpqrs' })
    const plain = await store.createNotification({ title: 'Morning digest', body: 'Nothing yet' })

    expect(pointed.link).toBe('todo:0123456789abcdefghjkmnpqrs')
    expect(plain.link).toBeNull()

    const listed = await store.listNotifications()
    expect(listed.find((entry) => entry.id === pointed.id)!.link).toBe('todo:0123456789abcdefghjkmnpqrs')
    expect(listed.find((entry) => entry.id === plain.id)!.link).toBeNull()
    expect(linkColumn(sqlite)!.notnull).toBe(0)
  })

  it('keeps one account\'s pointer out of another account\'s list', async () => {
    await store.createNotification({ title: 'Mine', body: 'x', link: 'todo:secrettaskidsecrettaskid' })
    const other = new AssistantStore(env.DB as D1Database, OTHER, env)
    expect(await other.listNotifications()).toEqual([])
  })

  it('does not let an over-long pointer be written as a free-form document', async () => {
    const long = await store.createNotification({ title: 'Bound', body: 'x', link: `todo:${'z'.repeat(4_000)}` })
    expect(long.link!.length).toBeLessThanOrEqual(200)
    expect((await store.listNotifications()).find((entry) => entry.id === long.id)!.link).toBe(long.link)
  })
})

describe('the pointer through a backup', () => {
  /** The notification rows a file carries, the way the export writes them. */
  function notificationsOf(backup: AssistantBackup): Record<string, unknown>[] {
    const entries = backup.data.notifications
    return Array.isArray(entries) ? entries as Record<string, unknown>[] : []
  }

  it('is exported, and lands back on the row a restore writes', async () => {
    const { env } = await installed()
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const written = await store.createNotification({ title: 'Renew the lease', body: 'Due today', link: 'todo:task-42' })

    const backup = await exportAssistant(store)
    expect(notificationsOf(backup).find((row) => row.id === written.id)!.link).toBe('todo:task-42')

    const restored = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(restored, JSON.parse(JSON.stringify(backup)) as Record<string, unknown>)
    const landed = (await restored.listNotifications()).find((entry) => entry.id === written.id)
    expect(landed, 'a restore that loses the notice is not a restore').toBeDefined()
    expect(landed!.link, 'a restored reminder that cannot be opened from lost its last step').toBe('todo:task-42')
  })

  it('lands an older file without the key as a notice with no pointer, not no notice', async () => {
    const { env } = await installed()
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const written = await store.createNotification({ title: 'Renew the lease', body: 'Due today', link: 'todo:task-42' })

    const backup = await exportAssistant(store)
    // A file written before the column existed names no `link` key at all.
    for (const row of notificationsOf(backup)) delete row.link

    const restored = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(restored, JSON.parse(JSON.stringify(backup)) as Record<string, unknown>)
    const landed = (await restored.listNotifications()).find((entry) => entry.id === written.id)
    expect(landed, 'an absent pointer must not make the whole row vanish').toBeDefined()
    expect(landed!.link).toBeNull()
  })

  it('does not move one account\'s pointer onto another account\'s row', async () => {
    const { env, sqlite } = await installed()
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const written = await store.createNotification({ title: 'Mine', body: 'x', link: 'todo:mine' })
    const backup = await exportAssistant(store)

    // The account receiving the file already knows this id, and the notice it holds is its own.
    sqlite.prepare(
      `INSERT INTO chat_notifications (user_id, id, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(OTHER, written.id, 'Theirs', 'y', 'todo:theirs', 1)

    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)) as Record<string, unknown>)

    const theirs = (await target.listNotifications()).find((entry) => entry.id === written.id)!
    expect(theirs.link, 'the file must not re-point a notice the reader already had').toBe('todo:theirs')
    expect(await target.listNotifications(), 'the held id must not be doubled by the file').toHaveLength(1)
    expect((await store.listNotifications()).find((entry) => entry.id === written.id)!.link).toBe('todo:mine')
  })
})
