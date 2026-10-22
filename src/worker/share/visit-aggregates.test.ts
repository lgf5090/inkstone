/// <reference types="node" />
// The node builtin above is what makes this file run its SQL for real: the worker tsconfig project
// lists only @cloudflare/workers-types, and `node:sqlite` is a Node module the platform does not
// have. It is reached here because a vitest worker is a Node process, and it is the only way to
// prove the aggregate statements against the row path they are supposed to reproduce. The double
// below is the same binding shape `tests/doubles/d1-sqlite.ts` implements — that file cannot be
// imported, since a composite project may not pull in a file outside its own include list.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  aggregateFromRows,
  visitAggregateFromResults,
  visitAggregateStatements,
  visitWhere,
  type VisitAggregate,
  type VisitAggregateQuery,
  type VisitFactRow,
  type VisitScope,
} from './visit-aggregates'
import { DAY_MS, timelineBucketCount } from './analytics'
import { SHARE_HUB_SCHEMA_STATEMENTS } from './hub-schema'
import { visitTrafficSql } from './selection-sql'

const NOW = 1_760_000_000_000
const QUERY: VisitAggregateQuery = {
  range: 'all',
  startTs: NOW - 30 * DAY_MS,
  duration: 30 * DAY_MS,
  clause: visitTrafficSql({ excludeBots: true }),
}

/** The `?1`-style placeholders D1 sends, which node:sqlite takes as an indexed-parameter object. */
function bindArgs(sql: string, values: unknown[]): unknown[] {
  return /\?\d+/.test(sql) ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))] : values
}

interface SqliteStatement {
  all(...args: unknown[]): Record<string, unknown>[]
  run(...args: unknown[]): { changes: number | bigint }
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

/** The four D1 verbs the aggregate statements use, answered the way the platform answers them. */
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
          return { results: sqlite.prepare(sql).all(...bindArgs(sql, values)) }
        },
        async first() {
          return sqlite.prepare(sql).all(...bindArgs(sql, values))[0] ?? null
        },
        async run() {
          return { meta: { changes: Number(sqlite.prepare(sql).run(...bindArgs(sql, values)).changes) } }
        },
      }
      return statement
    },
    // A batch is one read per statement, in the order the caller listed them; `visitAggregateFromResults`
    // unpacks the slots by that same position.
    async batch(statements: Array<{ all(): Promise<{ results: unknown[] }> }>) {
      const results = []
      for (const statement of statements) results.push(await statement.all())
      return results
    },
  }
  return db as unknown as D1Database
}

interface VisitSeed {
  user_id?: string
  note_id: string
  slug: string
  visited_at: number
  visitor_fp?: string | null
  country?: string | null
  referrer_host?: string | null
  device_type?: string | null
  os?: string | null
  browser?: string | null
  is_bot?: number
  is_self_referrer?: number
  is_owner?: number
}

const VISITS: VisitSeed[] = [
  // In scope: two visitors on note-a (one of them twice), one empty-fingerprint visit on note-b, and
  // a visit the clock put past the window, which the totals still count.
  { note_id: 'note-a', slug: 'note-a-v2', visited_at: NOW - DAY_MS, visitor_fp: 'f1', country: 'us', referrer_host: 'github.com', device_type: 'mobile', os: 'iOS', browser: 'Safari' },
  { note_id: 'note-a', slug: 'note-a-v1', visited_at: NOW - DAY_MS + 3_000, visitor_fp: 'f1' },
  { note_id: 'note-b', slug: 'b', visited_at: NOW - 10 * DAY_MS, country: 'CN', device_type: 'tablet', os: 'Windows' },
  { note_id: 'note-b', slug: 'b2', visited_at: NOW - 10 * DAY_MS + 4_000, visitor_fp: '', country: 'cn' },
  { note_id: 'note-a', slug: 'note-a-v2', visited_at: NOW + 5 * DAY_MS, visitor_fp: 'ffuture', country: 'fr' },
  // Out of scope: a bot, another account, and a visit before the window opens.
  { note_id: 'note-a', slug: 'note-a-v2', visited_at: NOW - 2 * DAY_MS, visitor_fp: 'fbot', country: 'de', is_bot: 1 },
  { note_id: 'note-c', slug: 'c', visited_at: NOW - 3 * DAY_MS, visitor_fp: 'fx', user_id: 'u2' },
  { note_id: 'note-a', slug: 'note-a-v1', visited_at: QUERY.startTs - 1_000, visitor_fp: 'fold' },
]

/** The visit table only: the rest of the hub's tables are another module's business. */
function seedDb(rows: VisitSeed[] = VISITS): D1Database {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDatabase
  for (const statement of SHARE_HUB_SCHEMA_STATEMENTS) {
    if (statement.includes('share_visits')) sqlite.exec(statement)
  }
  const db = d1Over(sqlite)
  for (const row of rows) {
    db
      .prepare(
        `INSERT INTO share_visits (user_id, note_id, slug, visited_at, visitor_fp, country, referrer_host,
                                   device_type, os, browser, is_bot, is_self_referrer, is_owner, channel)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(
        row.user_id ?? 'u1',
        row.note_id,
        row.slug,
        row.visited_at,
        row.visitor_fp ?? null,
        row.country ?? null,
        row.referrer_host ?? null,
        row.device_type ?? null,
        row.os ?? null,
        row.browser ?? null,
        row.is_bot ?? 0,
        row.is_self_referrer ?? 0,
        row.is_owner ?? 0,
        null,
      )
      .run()
  }
  return db
}

/** The reference implementation: fetch the predicate's rows and group them in JS. */
async function rowPathAggregate(db: D1Database, scope: VisitScope, query = QUERY): Promise<VisitAggregate> {
  const where = visitWhere(scope, query)
  const result = await db
    .prepare(
      `SELECT visited_at, visitor_fp, country, referrer_host, device_type, os, browser,
              note_id AS target_id, slug
         FROM share_visits
        WHERE ${where.sql}`,
    )
    .bind(...where.binds)
    .all<VisitFactRow>()
  return aggregateFromRows(result.results ?? [], query)
}

async function sqlPathAggregate(db: D1Database, scope: VisitScope, query = QUERY): Promise<VisitAggregate> {
  const results = await db.batch(visitAggregateStatements(db, scope, query))
  return visitAggregateFromResults(results, query)
}

describe('visit aggregates: the SQL path matches the row path', () => {
  it('agrees on the whole account scope', async () => {
    const db = seedDb()
    expect(await sqlPathAggregate(db, { userId: 'u1' })).toEqual(await rowPathAggregate(db, { userId: 'u1' }))
  })

  it('agrees on one link scope', async () => {
    const db = seedDb()
    expect(await sqlPathAggregate(db, { userId: 'u1', targetId: 'note-a' }))
      .toEqual(await rowPathAggregate(db, { userId: 'u1', targetId: 'note-a' }))
  })

  it('agrees on every bounded range, not just the unbounded one', async () => {
    const db = seedDb()
    for (const range of ['24h', '7d', '30d'] as const) {
      const startTs = range === '24h' ? NOW - DAY_MS : range === '7d' ? NOW - 7 * DAY_MS : NOW - 30 * DAY_MS
      const query: VisitAggregateQuery = { ...QUERY, range, startTs, duration: NOW - startTs }
      expect(await sqlPathAggregate(db, { userId: 'u1' }, query))
        .toEqual(await rowPathAggregate(db, { userId: 'u1' }, query))
    }
  })

  it('agrees under each traffic filter, including the raw one', async () => {
    const db = seedDb()
    for (const filters of [
      { excludeBots: true },
      { excludeBots: true, excludeSelfReferrers: true, excludeOwner: true },
      { excludeBots: false, excludeSelfReferrers: false, excludeOwner: false },
    ]) {
      const query: VisitAggregateQuery = { ...QUERY, clause: visitTrafficSql(filters) }
      expect(await sqlPathAggregate(db, { userId: 'u1' }, query))
        .toEqual(await rowPathAggregate(db, { userId: 'u1' }, query))
    }
  })

  it('counts the seeded visits the way the dashboards show them', async () => {
    const aggregate = await sqlPathAggregate(seedDb(), { userId: 'u1' })
    const totals = (map: Map<string, number>): Record<string, number> => Object.fromEntries(map)

    expect(aggregate.views).toBe(5)
    expect(aggregate.visitors).toBe(2)
    expect(totals(aggregate.countries)).toEqual({ US: 1, UNKNOWN: 1, CN: 2, FR: 1 })
    expect(totals(aggregate.referrers)).toEqual({ 'github.com': 1, Direct: 4 })
    expect(totals(aggregate.devices)).toEqual({ mobile: 1, desktop: 3, tablet: 1 })
    expect(totals(aggregate.osList)).toEqual({ iOS: 1, other: 3, Windows: 1 })
    expect(totals(aggregate.browsers)).toEqual({ Safari: 1, Other: 4 })
    expect(aggregate.targets).toEqual(new Map([
      ['note-a', { views: 3, visitors: 2, slug: 'note-a-v2' }],
      ['note-b', { views: 2, visitors: 0, slug: 'b2' }],
    ]))
  })

  it('leaves the out-of-window visit in the totals but out of every bucket', async () => {
    const aggregate = await sqlPathAggregate(seedDb(), { userId: 'u1' })
    expect(aggregate.buckets).toHaveLength(timelineBucketCount('all'))
    // The buckets cover the window; the visit the clock put past it is counted in the totals only,
    // so they sum to one less than `views`.
    expect(aggregate.buckets.reduce((sum, bucket) => sum + bucket.views, 0)).toBe(4)
    expect(aggregate.buckets[8]).toEqual({ views: 2, visitors: 0 })
    expect(aggregate.buckets[11]).toEqual({ views: 2, visitors: 1 })
    expect(aggregate.buckets.filter((_, index) => index !== 8 && index !== 11).every((b) => b.views === 0)).toBe(true)
  })

  it('answers an account with no rows with zero-filled buckets on both paths', async () => {
    const db = seedDb()
    const empty = { userId: 'nobody' }
    const aggregate = await sqlPathAggregate(db, empty)
    expect(aggregate).toEqual(await rowPathAggregate(db, empty))
    expect(aggregate.views).toBe(0)
    expect(aggregate.visitors).toBe(0)
    expect(aggregate.buckets.every((bucket) => bucket.views === 0 && bucket.visitors === 0)).toBe(true)
    expect(aggregate.countries.size).toBe(0)
    expect(aggregate.targets.size).toBe(0)
  })

  it('keeps one account out of another account read entirely', async () => {
    const other = await sqlPathAggregate(seedDb(), { userId: 'u2' })
    expect(other.views).toBe(1)
    expect(other.visitors).toBe(1)
    expect(other.targets.has('note-a')).toBe(false)
  })
})

describe('visit aggregate statement budget', () => {
  it('summarizes an unbounded range in eight statements and never fetches visit rows', () => {
    const sql = statementText({ userId: 'u1' }, QUERY)
    expect(sql).toHaveLength(8)
    // Each statement is a summary: none selects a visit row's own columns, which is what would put
    // the whole window back in memory.
    expect(sql.filter((text) => /SELECT\s+visited_at,\s*visitor_fp/.test(text))).toEqual([])
    expect(sql.filter((text) => text.includes('GROUP BY'))).toHaveLength(7)
  })

  it('summarizes a bounded range in the same eight statements', () => {
    const sql = statementText({ userId: 'u1' }, { ...QUERY, range: '7d' })
    expect(sql).toHaveLength(8)
    expect(sql.filter((text) => text.includes('GROUP BY'))).toHaveLength(7)
  })

  it('binds the account, the range and the fallback instead of writing any of them into the text', () => {
    const sql = statementText({ userId: 'u1' }, { ...QUERY, clause: '' })
    const literals = sql.filter((text) => /'u1'|\b1\d{12}\b/.test(text))
    expect(literals).toEqual([])
    // Only the bucket labels are written into the text, and they are module constants, not input.
    expect(sql.join('\n')).toContain("'Direct'")
  })
})

/**
 * The SQL text a statement list carries, collected from the `prepare` calls rather than from the
 * caller, so a statement that never reached the database cannot be counted as made.
 */
function statementText(scope: VisitScope, query: VisitAggregateQuery): string[] {
  const seen: string[] = []
  const recorder = {
    prepare(sql: string) {
      seen.push(sql)
      return { bind: () => recorder }
    },
    bind() {
      return recorder
    },
  } as unknown as D1Database
  visitAggregateStatements(recorder, scope, query)
  return seen
}
