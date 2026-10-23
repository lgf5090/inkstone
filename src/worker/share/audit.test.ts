/// <reference types="node" />
// The worker tsconfig project lists only @cloudflare/workers-types, and `node:sqlite` is a Node module
// the platform does not have. The audit trail is gated on the account-scoped index the DDL declares and
// on a `LIMIT` inside the trim's subquery, so the statements are run for real rather than modelled.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/constants'
import { newId } from '../lib/id'
import { SHARE_HUB_SCHEMA_STATEMENTS } from './hub-schema'
import {
  SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT,
  parseShareAuditChanges,
  readShareAudit,
  recordShareAudit,
  shareAuditDiff,
  shareAuditPageLimit,
  shareAuditSnapshot,
  type ShareAuditEntry,
} from './audit'

const OWNER = 'owner-account'
const OTHER = 'other-account'
const NOTE = newId()
const SLUG = 'abcdefghij0123456789'

interface SqliteStatement {
  all(...args: unknown[]): Record<string, unknown>[]
  run(...args: unknown[]): { changes: number | bigint }
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

function bindArgs(sql: string, values: unknown[]): unknown[] {
  return /\?\d+/.test(sql)
    ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
    : values
}

/** The D1 verbs the audit reads and writes; a batch is one transaction, which is what the cap needs. */
function d1Over(sqlite: SqliteDatabase): D1Database {
  const db = {
    prepare(sql: string) {
      let values: unknown[] = []
      const statement = {
        bind(...bound: unknown[]) {
          values = bound
          return statement
        },
        async all() {
          const rows = sqlite.prepare(sql).all(...bindArgs(sql, values))
          return { results: rows, meta: { changes: rows.length } }
        },
        async first() {
          return (await statement.all()).results[0] ?? null
        },
        async run() {
          return { meta: { changes: Number(sqlite.prepare(sql).run(...bindArgs(sql, values)).changes) } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ all(): Promise<{ results: unknown[] }> }>) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.all())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return db as unknown as D1Database
}

/** The hub's tables, which is what declares `share_audit_log` and the account index over it. */
function seed(): D1Database {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDatabase
  for (const statement of SHARE_HUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  return d1Over(sqlite)
}

async function countRows(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM share_audit_log WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

const BASE = {
  slug: SLUG,
  isEnabled: 1,
  expiresAt: null,
  folderId: null,
  tags: [] as string[] | null,
  hasPassword: false,
}

describe('the share audit diff', () => {
  it('names only the fields that moved, with the value each side held', () => {
    const changes = shareAuditDiff(
      { ...BASE },
      { ...BASE, folderId: 'folder-1', tags: ['weekly'], isEnabled: 0 },
    )
    expect(changes).toEqual([
      { field: 'is_enabled', from: 1, to: 0 },
      { field: 'folder_id', from: null, to: 'folder-1' },
      { field: 'tags', from: '[]', to: '["weekly"]' },
    ])
  })

  it('records a passcode as the flag it is, and never as anything derived from it', () => {
    const changes = shareAuditDiff(
      { ...BASE },
      { ...BASE, hasPassword: true },
    )
    expect(changes).toEqual([{ field: 'has_password', from: false, to: true }])

    // A snapshot is built from a row read back, so the hash itself has nowhere to be copied from.
    const snapshot = shareAuditSnapshot({
      slug: SLUG,
      is_enabled: 1,
      expires_at: null,
      folder_id: null,
      tags: '[]',
      password_hash: 'scrypt$16384$8$5$salt$hash',
    })
    expect(snapshot.hasPassword).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('scrypt')
  })

  it('says nothing about a link that did not exist before, and nothing about a field that held still', () => {
    expect(shareAuditDiff(null, { ...BASE })).toEqual([])
    expect(shareAuditDiff({ ...BASE }, { ...BASE })).toEqual([])
  })

  it('reads a corrupt history cell as no changes, which is what a create or a revoke means', () => {
    expect(parseShareAuditChanges(null)).toEqual([])
    expect(parseShareAuditChanges('{}')).toEqual([])
    expect(parseShareAuditChanges('not json')).toEqual([])
    expect(parseShareAuditChanges('[1,"two",{"field":"slug","from":"a","to":"b"}]')).toEqual([
      { field: 'slug', from: 'a', to: 'b' },
    ])
  })
})

describe('the share audit trail', () => {
  function entry(userId: string, createdAt: number, changed = [{ field: 'is_enabled', from: 1, to: 0 }]): ShareAuditEntry {
    return { userId, noteId: NOTE, slug: SLUG, action: 'update', changed, createdAt }
  }

  it('appends the entries of one write and reads them back newest first', async () => {
    const db = seed()
    await recordShareAudit(db, [entry(OWNER, 1000), entry(OWNER, 2000)])
    const page = await readShareAudit(db, OWNER, NOTE, 1, LIMITS.shareAuditEntriesPerPage)
    expect(page.total).toBe(2)
    expect(page.entries.map((item) => item.createdAt)).toEqual([2000, 1000])
    expect(page.entries[0]?.changed).toEqual([{ field: 'is_enabled', from: 1, to: 0 }])
    expect(page.limit).toBe(LIMITS.shareAuditEntriesPerPage)
  })

  it('holds one account inside the ceiling it states, oldest rows first', async () => {
    const db = seed()
    const entries = Array.from({ length: SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT + 40 }, (_, index) =>
      entry(OWNER, 1_000 + index),
    )
    await recordShareAudit(db, entries)
    expect(await countRows(db, OWNER)).toBe(SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT)

    const page = await readShareAudit(db, OWNER, NOTE, 1, 10)
    // The tail that went is the oldest: the newest entry is still the first row a reader is shown.
    expect(page.entries[0]?.createdAt).toBe(1_000 + entries.length - 1)
    expect(page.total).toBe(SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT)
  })

  it('caps each account on its own, so one writer cannot empty another history', async () => {
    const db = seed()
    const mine = Array.from({ length: SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT - 5 }, (_, index) => entry(OWNER, index))
    const theirs = Array.from({ length: 30 }, (_, index) => entry(OTHER, index))
    await recordShareAudit(db, [...mine, ...theirs])
    expect(await countRows(db, OWNER)).toBe(SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT - 5)
    expect(await countRows(db, OTHER)).toBe(30)
  })

  it('pages without overlap and clamps a limit nobody meant', async () => {
    const db = seed()
    await recordShareAudit(db, Array.from({ length: 25 }, (_, index) => entry(OWNER, index)))
    const first = await readShareAudit(db, OWNER, NOTE, 1, 10)
    const second = await readShareAudit(db, OWNER, NOTE, 2, 10)
    const third = await readShareAudit(db, OWNER, NOTE, 3, 10)
    const past = await readShareAudit(db, OWNER, NOTE, 9, 10)
    expect(first.entries).toHaveLength(10)
    expect(second.entries).toHaveLength(10)
    expect(third.entries).toHaveLength(5)
    expect(past.entries).toHaveLength(0)
    expect(new Set([...first.entries, ...second.entries].map((item) => item.id)).size).toBe(20)
    expect(shareAuditPageLimit(undefined)).toBe(LIMITS.shareAuditEntriesPerPage)
    expect(shareAuditPageLimit('0')).toBe(1)
    expect(shareAuditPageLimit('999999')).toBeLessThanOrEqual(LIMITS.shareAuditEntriesPerPage)
  })

  it('answers another account with the same empty page a link with no history has', async () => {
    const db = seed()
    await recordShareAudit(db, [entry(OTHER, 1000)])
    const page = await readShareAudit(db, OWNER, NOTE, 1, 10)
    expect(page.entries).toEqual([])
    expect(page.total).toBe(0)
    // And a foreign note id reads nothing of the owner's rows either.
    const foreignNote = await readShareAudit(db, OTHER, newId(), 1, 10)
    expect(foreignNote.total).toBe(0)
    expect(await countRows(db, OTHER)).toBe(1)
  })

  it('leaves a failed append as a warning rather than a 500 on a write that already landed', async () => {
    const warnings: unknown[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      // A database that answers nothing at all: the entries have nowhere to go, and the caller must not
      // be told its owner-visible write failed.
      const broken = {
        prepare() {
          return {
            bind() {
              return this
            },
            all() {
              return Promise.reject(new Error('D1 unreachable'))
            },
          }
        },
        async batch() {
          throw new Error('D1 unreachable')
        },
      } as unknown as D1Database
      await expect(recordShareAudit(broken, [entry(OWNER, 1000)])).resolves.toBeUndefined()
    } finally {
      console.warn = original
    }
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0])).toContain('share audit append failed')
  })
})
