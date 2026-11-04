// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The lock column's ledger transition, run against a real SQLite database rather than a shape check.
 *
 * The branch first shipped `notes.is_encrypted` as migration 266. Memos then merged and took 266 for
 * `memos_items.content_cipher`. A local database that already ran the old number must record 268/269
 * without re-adding the column, and must not keep 266 in the ledger in a way that makes the Memos
 * migration look applied forever.
 */

function boot(sqlite: DatabaseSync): Promise<unknown> {
  // A new wrapper is a new `initializeDatabase` cache key, which is what makes this a boot.
  return initializeDatabase({ DB: makeD1(sqlite) } as unknown as Env)
}

function columns(sqlite: DatabaseSync, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

function ledger(sqlite: DatabaseSync): number[] {
  return (sqlite.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: number }>)
    .map((row) => row.version)
}

function forgetFingerprint(sqlite: DatabaseSync): void {
  sqlite.prepare(`DELETE FROM app_meta WHERE key = 'database-state-v1'`).run()
}

describe('the notes lock migration on a real D1-shaped database', () => {
  it('adds the column and the Memos columns on a fresh boot, under 268/269', async () => {
    const sqlite = new DatabaseSync(':memory:')
    await boot(sqlite)

    expect(columns(sqlite, 'notes')).toContain('is_encrypted')
    expect(columns(sqlite, 'memos_items')).toContain('encrypted')
    expect(columns(sqlite, 'memos_items')).toContain('content_cipher')
    const applied = ledger(sqlite)
    expect(applied).toContain(268)
    expect(applied).toContain(269)
  })
})

describe('a database that already ran the old 266', () => {
  it('keeps the column, frees the number for Memos, and converges on the next boot', async () => {
    const sqlite = new DatabaseSync(':memory:')
    await boot(sqlite)

    // Reproduce the old branch's database: notes column present, Memos columns absent, 266 recorded
    // as this branch's migration, and no fresh fingerprint to skip the migration pass.
    sqlite.exec(`ALTER TABLE memos_items DROP COLUMN content_cipher`)
    sqlite.exec(`ALTER TABLE memos_items DROP COLUMN encrypted`)
    sqlite.exec(`DELETE FROM schema_migrations WHERE version IN (265, 266, 267, 268, 269)`)
    sqlite.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (266, 1)`).run()
    forgetFingerprint(sqlite)

    await boot(sqlite)

    expect(columns(sqlite, 'notes')).toContain('is_encrypted')
    // The shape repair replays the Memos column even though its ledger row was freed in this pass.
    expect(columns(sqlite, 'memos_items')).toContain('content_cipher')
    expect(columns(sqlite, 'memos_items')).toContain('encrypted')
    const firstBoot = ledger(sqlite)
    expect(firstBoot).not.toContain(266)
    expect(firstBoot).toContain(268)
    expect(firstBoot).toContain(269)

    // The next boot restores the Memos ledger row without touching a column that already exists.
    forgetFingerprint(sqlite)
    await boot(sqlite)
    const secondBoot = ledger(sqlite)
    expect(secondBoot).toContain(265)
    expect(secondBoot).toContain(266)
    expect(secondBoot).toContain(268)
    expect(secondBoot).toContain(269)
    expect(columns(sqlite, 'notes').filter((name) => name === 'is_encrypted')).toHaveLength(1)
  })
})
