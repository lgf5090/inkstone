// @vitest-environment node
/**
 * The shape of `chat_active_runs.partial_text`, and the fact that it never leaves the database.
 *
 * A run lease is a lock, and a lock that says nothing about what it is holding is what lost an answer here:
 * a Worker isolate killed by its CPU limit takes the request with it, the assistant row is written at the end
 * of a turn so no row exists, and `chat_active_runs` goes on claiming the conversation for the rest of
 * `RUN_LEASE_MS` while the reader's side waits, gives up and is told nothing. The column lets the renewal
 * that already happens carry the words the turn had written, so there is something to read back.
 *
 * Two properties are load-bearing and are checked against a real database rather than against the source
 * text. It has to arrive on an account that predates it — including on one whose ledger already claims
 * version 108 was spent, which is the shape that has quietly broken this schema's boots before — and it has
 * to be nullable, because "nothing written yet" is not "an empty answer" and a NOT NULL column would make
 * every claim made before it un-insertable.
 *
 * The third is privacy: the fragment is model output the reader may never come back for, on a table that is
 * not a transcript. It is not in the export allowlist, and this is where that stays true.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase, REQUIRED_COLUMNS, SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { ASSISTANT_REQUIRED_COLUMNS, ASSISTANT_SCHEMA_STATEMENTS } from '../src/worker/assistant/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { RUN_PARTIAL_MAX_CHARS } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const LEASE_VERSION = 108
const COLUMN = 'partial_text'

interface ColumnInfo {
  name: string
  notnull: number
  dflt_value: string | null
}

function columnsOf(sqlite: DatabaseSync, table: string): ColumnInfo[] {
  return sqlite.prepare(`SELECT * FROM pragma_table_info(?)`).all(table) as unknown as ColumnInfo[]
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

/** The lease table as the shape before version 108, with every later boot able to notice it is missing. */
function dropPartialColumn(sqlite: DatabaseSync): void {
  sqlite.prepare('ALTER TABLE chat_active_runs DROP COLUMN ' + COLUMN).run()
}

function partialColumn(sqlite: DatabaseSync): ColumnInfo | undefined {
  return columnsOf(sqlite, 'chat_active_runs').find((entry) => entry.name === COLUMN)
}

describe('the version that gives a run lease its fragment', () => {
  it('spends 108 on one nullable column of the lease table and nothing else', () => {
    const entries = SCHEMA_MIGRATIONS.filter((migration) => migration.version === LEASE_VERSION)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.skipIfColumnExists).toEqual({ table: 'chat_active_runs', column: COLUMN })
    expect(entry.statements).toHaveLength(1)
    expect(entry.statements[0]).toBe(`ALTER TABLE chat_active_runs ADD COLUMN ${COLUMN} TEXT`)
    // Nullable, with no default: a fresh database gets the column from the table itself, and the two
    // directions have to agree or the boot's shape check refuses one of them.
    expect(entry.statements[0]).not.toMatch(/NOT NULL/i)
    expect(entry.statements[0]).not.toMatch(/DEFAULT/i)
  })

  it('asks the table for the column, so a fresh database has it without a migration', () => {
    const created = ASSISTANT_SCHEMA_STATEMENTS.find((text) => /CREATE TABLE IF NOT EXISTS chat_active_runs/.test(text))
    expect(created).toBeDefined()
    expect(created).toContain(`${COLUMN} TEXT`)
    expect(ASSISTANT_REQUIRED_COLUMNS.chat_active_runs).toContain(COLUMN)
    expect(REQUIRED_COLUMNS.chat_active_runs).toContain(COLUMN)
  })

  it('gives an account that predates the column the column on its next boot', async () => {
    const { sqlite } = await installed()
    expect(partialColumn(sqlite)).toBeDefined()
    // The pre-108 shape, which is what an account that has not been deployed since has.
    dropPartialColumn(sqlite)
    sqlite.prepare('DELETE FROM schema_migrations WHERE version = ?').run(LEASE_VERSION)
    expect(partialColumn(sqlite)).toBeUndefined()

    await reboot(sqlite)
    const column = partialColumn(sqlite)
    expect(column, 'the boot that runs the migration must land the column').toBeDefined()
    expect(column!.notnull, 'a claim predating the column has nothing written, which is NULL not an empty string')
      .toBe(0)
  })

  it('heals the column when the ledger claims 108 ran and the shape says it did not', async () => {
    const { sqlite } = await installed()
    // The other lineage's situation this schema has been broken by before: the note is there, the work is
    // not, and a boot that trusted the note serves a database every later write of the fragment fails.
    dropPartialColumn(sqlite)
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).all(LEASE_VERSION)).toHaveLength(1)
    expect(partialColumn(sqlite)).toBeUndefined()

    await reboot(sqlite)
    const column = partialColumn(sqlite)
    expect(column, 'a spent version number must not be able to hide the column').toBeDefined()
    expect(column!.notnull).toBe(0)
  })

  it('keeps the column out of every table a boot reports, until the repair lands it', async () => {
    const { sqlite } = await installed()
    // The shape check the boot ends with is what makes a missing column loud rather than half-working:
    // `REQUIRED_COLUMNS` naming it is the assertion, and a drop proves the check can see the gap.
    dropPartialColumn(sqlite)
    sqlite.prepare('DELETE FROM schema_migrations WHERE version = ?').run(LEASE_VERSION)
    const names = columnsOf(sqlite, 'chat_active_runs').map((entry) => entry.name)
    expect(names).not.toContain(COLUMN)
    expect(REQUIRED_COLUMNS.chat_active_runs.filter((column) => !names.includes(column))).toEqual([COLUMN])
    await reboot(sqlite)
    expect(REQUIRED_COLUMNS.chat_active_runs.filter((column) =>
      !columnsOf(sqlite, 'chat_active_runs').some((entry) => entry.name === column))).toEqual([])
  })
})

describe('the fragment stays inside the account that wrote it', () => {
  it('refuses the lease table on both sides of a backup', async () => {
    const { env } = await installed()
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const tables = await store.exportTables()
    // The positive half first: the allowlist is populated, so the absence below is a refusal rather than
    // an empty map that would pass the same way. The keys are the backup's own names, not table names.
    expect(Object.keys(tables)).toContain('messages')
    expect(Object.keys(tables).filter((key) => /active_runs|lease/.test(key))).toEqual([])
    // Nothing anywhere in the file carries the fragment, whichever table it would be hung off.
    for (const rows of Object.values(tables)) {
      for (const row of rows) expect(row).not.toHaveProperty(COLUMN)
    }

    // A hostile file naming the table is turned away rather than silently dropped.
    await expect(store.importRow('chat_active_runs', {
      conversation_id: 'whatever', started_at: 1, lease_until: 2_000_000_000_000, [COLUMN]: 'somebody else half answer',
    })).rejects.toThrow(/chat_active_runs/)
  })

  it('bounds what the column can be asked to hold', () => {
    // A lock table is not a document store. The ceiling is named, finite, and well short of a message the
    // reader could have sent, so an abandoned lease cannot be turned into a copy of the transcript.
    expect(Number.isInteger(RUN_PARTIAL_MAX_CHARS)).toBe(true)
    expect(RUN_PARTIAL_MAX_CHARS).toBeGreaterThan(0)
    expect(RUN_PARTIAL_MAX_CHARS).toBeLessThan(16_000)
  })
})
