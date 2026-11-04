// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { BLOG_REQUIRED_INDEXES } from '../src/worker/blog/schema'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * Migration 270 adds the asset-side index the media library asks for.
 *
 * The migration is one `CREATE INDEX IF NOT EXISTS`, so the interesting part is not that a fresh
 * database has it — schema statements already build it — but that a database which ran the blog
 * schema before the index existed records the number once and stays correct on every later boot.
 */

function boot(sqlite: DatabaseSync): Promise<unknown> {
  // A new wrapper is a new `initializeDatabase` cache key, which is what makes this a boot.
  return initializeDatabase({ DB: makeD1(sqlite) } as unknown as Env)
}

function forgetFingerprint(sqlite: DatabaseSync): void {
  sqlite.prepare(`DELETE FROM app_meta WHERE key = 'database-state-v1'`).run()
}

function ledger(sqlite: DatabaseSync): number[] {
  return (sqlite.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: number }>)
    .map((row) => row.version)
}

function indexes(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>)
    .map((row) => row.name)
}

describe('the blog asset index migration', () => {
  it('exists on a fresh database and is registered as required', async () => {
    const sqlite = new DatabaseSync(':memory:')
    await boot(sqlite)

    expect(indexes(sqlite)).toContain('idx_blog_post_assets_asset')
    expect(ledger(sqlite)).toContain(270)
    expect(BLOG_REQUIRED_INDEXES).toContain('idx_blog_post_assets_asset')
  })

  it('converges when the same database boots twice', async () => {
    const sqlite = new DatabaseSync(':memory:')
    await boot(sqlite)
    forgetFingerprint(sqlite)
    await boot(sqlite)

    expect(ledger(sqlite).filter((version) => version === 270)).toHaveLength(1)
    expect(indexes(sqlite).filter((name) => name === 'idx_blog_post_assets_asset')).toHaveLength(1)
  })

  it('restores an index a pre-270 database never built, without duplicating the ledger row', async () => {
    const sqlite = new DatabaseSync(':memory:')
    await boot(sqlite)

    // The shape of a database that ran the blog schema at 204 and stopped before 270.
    sqlite.exec('DROP INDEX idx_blog_post_assets_asset')
    sqlite.exec('DELETE FROM schema_migrations WHERE version = 270')
    forgetFingerprint(sqlite)
    await boot(sqlite)

    expect(indexes(sqlite)).toContain('idx_blog_post_assets_asset')
    expect(ledger(sqlite).filter((version) => version === 270)).toHaveLength(1)
  })
})
