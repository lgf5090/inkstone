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
 * `memos_items.content_cipher`. A local database that already ran the old number records 266 without
 * the Memos column, so 268 backfills exactly that column to make 266 truthful; 269 then adds the lock
 * column idempotently. Deleting 266 is not an option because the boot fingerprint caches the pass.
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
  it('adds the lock column and records 268/269 on a fresh boot', async () => {
    const sqlite = new DatabaseSync(':memory:')
    await boot(sqlite)

    expect(columns(sqlite, 'notes')).toContain('is_encrypted')
    expect(columns(sqlite, 'memos_items')).toContain('encrypted')
    expect(columns(sqlite, 'memos_items')).toContain('content_cipher')
    const applied = ledger(sqlite)
    expect(applied).toContain(266)
    expect(applied).toContain(268)
    expect(applied).toContain(269)
  })
})

describe('a database that already ran the old 266', () => {
  it('keeps 266 truthful by adding the Memos column, and converges without a duplicate', async () => {
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
    // 266 stays in the ledger; 268 makes the effect it names true instead of deleting the row.
    expect(columns(sqlite, 'memos_items')).toContain('content_cipher')
    expect(columns(sqlite, 'memos_items')).toContain('encrypted')
    const firstBoot = ledger(sqlite)
    expect(firstBoot).toContain(265)
    expect(firstBoot).toContain(266)
    expect(firstBoot).toContain(268)
    expect(firstBoot).toContain(269)

    // A second boot reads the stored fingerprint and must not add the column again.
    forgetFingerprint(sqlite)
    await boot(sqlite)
    const secondBoot = ledger(sqlite)
    expect(secondBoot).toContain(266)
    expect(secondBoot).toContain(268)
    expect(secondBoot).toContain(269)
    expect(columns(sqlite, 'notes').filter((name) => name === 'is_encrypted')).toHaveLength(1)
    expect(columns(sqlite, 'memos_items').filter((name) => name === 'content_cipher')).toHaveLength(1)
  })
})
