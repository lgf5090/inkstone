// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS, type SchemaMigration } from '../src/worker/db/schema'

/**
 * The migration ledger must spend one number per entry.
 *
 * `applyMigrations` decides whether an entry runs by asking whether its number is already in
 * `schema_migrations`, and it records the number with `INSERT OR IGNORE` against a
 * `version INTEGER PRIMARY KEY`. Two entries that share a number therefore collapse into one ledger
 * row: the first boot writes the row, and every later boot skips *both* entries — the second one can
 * never run, and the first one runs only on the boot that happened to record it. The reader's shelf
 * and the reading library's `users.rss` column both claimed 30, and a probe against a boot onto a
 * database that had already spent 30 showed neither entry's statements being sent at all: the column
 * came back only from the shape repair, which is not a migration and knows nothing about the ledger.
 *
 * A number spent twice is also the one mistake that cannot be undone later, because the ledger of an
 * already-deployed account cannot be rewritten. So this is checked against the declaration rather
 * than a boot.
 */

/** The versions this project already spent more than one column on, and will not spend again. */
const MULTI_COLUMN_BASELINE = new Set<number>([32])

/** The `ADD COLUMN` statements a version brings in, as `table.column`. */
function addedColumns(migration: SchemaMigration): string[] {
  const out: string[] = []
  for (const statement of migration.statements) {
    const added = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/is.exec(statement)
    if (added) out.push(`${added[1]}.${added[2]}`)
  }
  return out
}

function duplicatedVersions(migrations: readonly SchemaMigration[]): number[] {
  const seen = new Map<number, number>()
  for (const migration of migrations) seen.set(migration.version, (seen.get(migration.version) ?? 0) + 1)
  return [...seen].filter(([, count]) => count > 1).map(([version]) => version).sort((a, b) => a - b)
}

function overSpentVersions(migrations: readonly SchemaMigration[]): number[] {
  return migrations
    .filter((migration) => addedColumns(migration).length > 1 && !MULTI_COLUMN_BASELINE.has(migration.version))
    .map((migration) => migration.version)
    .sort((a, b) => a - b)
}

describe('the migration ledger spends each version number once', () => {
  it('holds no version claimed by two entries', () => {
    expect(duplicatedVersions(SCHEMA_MIGRATIONS)).toEqual([])
  })

  it('holds at most one new column per version, outside the recorded baseline', () => {
    expect(overSpentVersions(SCHEMA_MIGRATIONS)).toEqual([])
  })

  it('catches both shapes of mistake, rather than passing because the ledger happens to be clean', () => {
    // Positive control. A guard that cannot fail is worth nothing against the next entry, and the
    // collision it exists to stop is invisible in the code — both entries read as correct alone.
    const collided: SchemaMigration[] = [
      { version: 5, statements: ['ALTER TABLE users ADD COLUMN a TEXT'] },
      { version: 5, statements: ['CREATE TABLE IF NOT EXISTS thing (id TEXT PRIMARY KEY)'] },
      { version: 6, statements: ['ALTER TABLE thing ADD COLUMN x TEXT', 'ALTER TABLE thing ADD COLUMN y TEXT'] },
    ]
    expect(duplicatedVersions(collided)).toEqual([5])
    expect(overSpentVersions(collided)).toEqual([6])
    // The same two entries are clean once the number is spent once and the column one at a time.
    const fixed: SchemaMigration[] = [
      { version: 5, statements: ['ALTER TABLE users ADD COLUMN a TEXT'] },
      { version: 7, statements: ['CREATE TABLE IF NOT EXISTS thing (id TEXT PRIMARY KEY)'] },
      { version: 6, statements: ['ALTER TABLE thing ADD COLUMN x TEXT'] },
      { version: 8, statements: ['ALTER TABLE thing ADD COLUMN y TEXT'] },
    ]
    expect(duplicatedVersions(fixed)).toEqual([])
    expect(overSpentVersions(fixed)).toEqual([])
  })
})

/**
 * The two sort orders added after the list shipped — `sort=created` and `sort=completed` — each read a
 * column no index led with, so every page of a long-lived account sorted its whole table. One number per
 * index, as everywhere else: reusing a number would collapse the ledger row and hide the second index
 * from every boot after the first.
 */
describe('the task sort indexes spend a number each', () => {
  function statementsAt(version: number): string[] {
    return SCHEMA_MIGRATIONS
      .filter((migration) => migration.version === version)
      .flatMap((migration) => migration.statements)
  }

  it('gives the created and completed orders one index apiece', () => {
    expect(statementsAt(111)).toEqual([
      expect.stringMatching(/CREATE INDEX IF NOT EXISTS idx_todos_tasks_created\s+ON todos_tasks\(user_id, created_at\)/),
    ])
    expect(statementsAt(112)).toEqual([
      expect.stringMatching(/CREATE INDEX IF NOT EXISTS idx_todos_tasks_completed\s+ON todos_tasks\(user_id, completed_at\)/),
    ])
  })
})

/**
 * The statistics' two day columns and the index they group by.
 *
 * The columns store the reader's calendar day rather than a UTC date derived at query time, and each
 * one arrives under its own number so a ledger that already spent one cannot hide the other. The
 * index reads `completed_on`, so it has to be numbered after both columns exist.
 */
describe('the task day columns spend a number each', () => {
  function migrationAt(version: number) {
    return SCHEMA_MIGRATIONS.find((migration) => migration.version === version)
  }

  it('adds one column per version, guarded so a fresh install can replay them', () => {
    expect(migrationAt(113)).toMatchObject({
      skipIfColumnExists: { table: 'todos_tasks', column: 'completed_on' },
      statements: [`ALTER TABLE todos_tasks ADD COLUMN completed_on TEXT`],
    })
    expect(migrationAt(114)).toMatchObject({
      skipIfColumnExists: { table: 'todos_tasks', column: 'created_on' },
      statements: [`ALTER TABLE todos_tasks ADD COLUMN created_on TEXT`],
    })
  })

  it('gives the completed day its own index under its own number', () => {
    expect(migrationAt(115)?.statements).toEqual([
      expect.stringMatching(/CREATE INDEX IF NOT EXISTS idx_todos_tasks_completed_on\s+ON todos_tasks\(user_id, completed_on\)/),
    ])
  })
})

/**
 * The account switch that lets an MCP key read tasks at all.
 *
 * On by default: every key minted before the switch existed already carried `todos:read`, and turning
 * the switch off by default would silently revoke what those readers were using. One column, one number,
 * guarded so a fresh install replays nothing twice.
 */
describe('the to-do read switch', () => {
  it('arrives on, under its own guarded number', () => {
    expect(SCHEMA_MIGRATIONS.find((migration) => migration.version === 124)).toMatchObject({
      skipIfColumnExists: { table: 'mcp_preferences', column: 'todo_read_enabled' },
      statements: ['ALTER TABLE mcp_preferences ADD COLUMN todo_read_enabled INTEGER NOT NULL DEFAULT 1'],
    })
  })
})

/**
 * The two organizer columns a list gained: the archive stamp and the parent pointer.
 *
 * Each arrives under its own number and carries its own guard, so a database whose ledger already
 * spent one number still gets the other column, and a fresh install replays neither twice.
 */
describe('the list organizer columns spend a number each', () => {
  function migrationAt(version: number) {
    return SCHEMA_MIGRATIONS.find((entry) => entry.version === version)
  }

  it('adds the archive stamp and the parent pointer under their own numbers', () => {
    expect(migrationAt(120)).toMatchObject({
      skipIfColumnExists: { table: 'todos_lists', column: 'archived_at' },
      statements: [`ALTER TABLE todos_lists ADD COLUMN archived_at INTEGER`],
    })
    expect(migrationAt(121)).toMatchObject({
      skipIfColumnExists: { table: 'todos_lists', column: 'parent_id' },
      statements: [`ALTER TABLE todos_lists ADD COLUMN parent_id TEXT`],
    })
  })
})
