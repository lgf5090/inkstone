/// <reference types="node" />
// The worker tsconfig project lists only @cloudflare/workers-types, and `node:sqlite` is a Node module the
// platform does not have. It is reached here because a vitest worker is a Node process, and it is the only
// way to prove these routes against the constraints their answers depend on: the `json_each` element rule,
// the window functions both hygiene reports read, the `?N` bind numbering, and the batch the visit wipe
// runs as one transaction. The double below is the same binding shape `tests/doubles/d1-sqlite.ts`
// implements — that file cannot be imported, since a composite project may not pull in a file outside its
// own include list.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { LIMITS, SHARE_STALE_DEFAULT_DAYS } from '@shared/constants'
import { CHANNEL_UNMARKED, CHANNEL_UNRECOGNIZED, collectionChannelToken } from '@shared/share-channel'
import type {
  ShareGlobalAnalytics,
  ShareNoteAnalytics,
  ShareStatsResponse,
  ShareVisitsResponse,
} from '@shared/share-hub'
import { SHARE_CATEGORY_STATUS, shareMatchesStatus } from '@shared/share-selection'
import type { ShareSelectionSubject } from '@shared/share-selection'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { DAY_MS, analyticsWindow } from '../src/worker/share/analytics'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { shareStatusSql } from '../src/worker/share/selection-sql'
import { SHARE_HUB_SCHEMA_STATEMENTS } from '../src/worker/share/hub-schema'
import { serializeShareTags } from '../src/worker/share/store'
import { expiredAckMetaKey, parseExpiredAck, shareAnalyticsRoutes } from '../src/worker/routes/share-analytics'

const OWNER = 'owner-account'
const OTHER = 'other-account'

const DIGEST_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const DIGEST_B = 'b2c3d4e5f60718293a4b5c6d7e8f90a1'
const DIGEST_C = 'c3d4e5f60718293a4b5c6d7e8f90a1b2'
/**
 * Public link tails in the shape `isValidSlug` accepts, because the log route validates the `slug` it is
 * given before it looks anything up: a fixture spelled `slug-a` would answer 400 and prove nothing.
 */
const SLUG_A = 'a'.repeat(20)
const SLUG_B = 'b'.repeat(20)
const SLUG_FOREIGN = 'c'.repeat(20)
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Every fixture is built against one instant; the routes read `Date.now()` themselves. */
const T0 = Date.now()

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

/** The verb D1 judges a statement by, so a write through `all()` still answers with `meta`. */
function topLevelVerb(sql: string): string | null {
  let depth = 0
  for (const match of sql.matchAll(/[()]|\b(select|insert|update|delete)\b/gi)) {
    const token = match[0]
    if (token === '(') depth += 1
    else if (token === ')') depth -= 1
    else if (depth === 0) return token.toLowerCase()
  }
  return null
}

/** Every statement the routes prepare, so a test can read the SQL they actually sent. */
let preparedSql: string[] = []

function d1Over(sqlite: SqliteDatabase): D1Database {
  const db = {
    prepare(sql: string) {
      preparedSql.push(sql)
      let values: unknown[] = []
      const run = () => Number(sqlite.prepare(sql).run(...bindArgs(sql, values)).changes)
      const statement = {
        bind(...bound: unknown[]) {
          values = bound
          return statement
        },
        async all() {
          if (topLevelVerb(sql) === 'select') {
            return { results: sqlite.prepare(sql).all(...bindArgs(sql, values)) }
          }
          if (/\breturning\b/i.test(sql)) {
            const rows = sqlite.prepare(sql).all(...bindArgs(sql, values))
            return { results: rows, meta: { changes: rows.length } }
          }
          const changes = run()
          return { results: [], meta: { changes } }
        },
        async first() {
          const result = await statement.all()
          return (result.results as Record<string, unknown>[])[0] ?? null
        },
        async run() {
          return { meta: { changes: run() } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ all(): Promise<{ results: unknown[]; meta?: { changes: number } }> }>) {
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

interface SeedNote {
  id: string
  userId?: string
  title?: string
  deletedAt?: number | null
  isPinned?: number
  isStarred?: number
}

interface SeedShare {
  noteId: string
  slug: string
  userId?: string
  folderId?: string | null
  tags?: string[]
  passwordHash?: string | null
  expiresAt?: number | null
  isEnabled?: number
  views?: number
  lastViewedAt?: number | null
  createdAt?: number
}

interface SeedVisit {
  noteId: string
  slug: string
  userId?: string
  visitedAt: number
  visitorFp?: string | null
  country?: string | null
  referrerHost?: string | null
  deviceType?: string | null
  os?: string | null
  browser?: string | null
  userAgent?: string | null
  isBot?: boolean
  isSelfReferrer?: boolean
  isOwner?: boolean
  channel?: string | null
}

interface Seed {
  notes?: SeedNote[]
  shares?: SeedShare[]
  visits?: SeedVisit[]
  folders?: { id: string; userId?: string; name: string }[]
  tags?: { id: string; userId?: string; name: string }[]
  collections?: { slug: string; userId?: string; title?: string | null }[]
}

/** One database with every table the analytics routes touch, and the rows they read. */
function seed(input: Seed): D1Database {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDatabase
  for (const statement of SHARE_HUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  for (const statement of SCHEMA_STATEMENTS) {
    if (/CREATE TABLE IF NOT EXISTS (notes|shares|app_meta) \(/.test(statement)) sqlite.exec(statement)
  }
  const db = d1Over(sqlite)
  for (const note of input.notes ?? []) {
    db.prepare(
      `INSERT INTO notes (id, user_id, title, content, excerpt, is_pinned, is_starred, deleted_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'body', 'excerpt', ?4, ?5, ?6, 1000, 1000)`,
    )
      .bind(note.id, note.userId ?? OWNER, note.title ?? 'A note', note.isPinned ?? 0, note.isStarred ?? 0, note.deletedAt ?? null)
      .run()
  }
  for (const share of input.shares ?? []) {
    db.prepare(
      `INSERT INTO shares (slug, note_id, user_id, folder_id, tags, password_hash, expires_at, views, is_enabled, last_viewed_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
      .bind(
        share.slug,
        share.noteId,
        share.userId ?? OWNER,
        share.folderId ?? null,
        serializeShareTags(share.tags ?? []),
        share.passwordHash ?? null,
        share.expiresAt ?? null,
        share.views ?? 0,
        share.isEnabled ?? 1,
        share.lastViewedAt ?? null,
        share.createdAt ?? 1000,
      )
      .run()
  }
  for (const visit of input.visits ?? []) {
    db.prepare(
      `INSERT INTO share_visits (user_id, note_id, slug, visited_at, visitor_fp, country, region, city,
                                 referrer, referrer_host, device_type, os, browser, language, user_agent,
                                 is_bot, is_self_referrer, is_owner, channel)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13, ?14, ?15)`,
    )
      .bind(
        visit.userId ?? OWNER,
        visit.noteId,
        visit.slug,
        visit.visitedAt,
        visit.visitorFp ?? null,
        visit.country ?? null,
        visit.referrerHost ?? null,
        visit.deviceType ?? null,
        visit.os ?? null,
        visit.browser ?? null,
        visit.userAgent ?? null,
        visit.isBot ? 1 : 0,
        visit.isSelfReferrer ? 1 : 0,
        visit.isOwner ? 1 : 0,
        visit.channel ?? null,
      )
      .run()
  }
  for (const folder of input.folders ?? []) {
    db.prepare(
      `INSERT INTO share_folders (id, user_id, parent_id, name, icon, color, position, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, NULL, NULL, 1000, 1000, 1000)`,
    )
      .bind(folder.id, folder.userId ?? OWNER, folder.name)
      .run()
  }
  for (const tag of input.tags ?? []) {
    db.prepare(
      `INSERT INTO share_tags (id, user_id, name, color, is_pinned, created_at) VALUES (?1, ?2, ?3, NULL, 0, 1000)`,
    )
      .bind(tag.id, tag.userId ?? OWNER, tag.name)
      .run()
  }
  for (const collection of input.collections ?? []) {
    db.prepare(
      `INSERT INTO share_collections (id, slug, user_id, target_type, target_value, password_hash, expires_at, is_enabled, member_sort, title, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'folder', 'target', NULL, NULL, 1, NULL, ?4, 1000, 1000)`,
    )
      .bind(newId(), collection.slug, collection.userId ?? OWNER, collection.title ?? null)
      .run()
  }
  return db
}

/** The hub mounts these under `/api/share`; the account is what `requireAuth` would have set. */
function app(userId: string): Hono<AppBindings> {
  const router = new Hono<AppBindings>()
  // The same wiring `worker/app.ts` gives every route: without it an ApiError would read as a 500.
  router.onError((err, c) => errorResponse(c, err))
  router.use('*', async (c, next) => {
    c.set('userId', userId)
    await next()
  })
  router.route('/api/share', shareAnalyticsRoutes)
  return router
}

async function get<T>(db: D1Database, userId: string, path: string): Promise<{ status: number; json: T }> {
  const response = await app(userId).request(`/api/share${path}`, undefined, { DB: db } as unknown as Env)
  return { status: response.status, json: (await response.json()) as T }
}

async function send<T>(
  db: D1Database,
  userId: string,
  method: 'POST' | 'DELETE',
  path: string,
): Promise<{ status: number; json: T }> {
  const response = await app(userId).request(`/api/share${path}`, { method }, { DB: db } as unknown as Env)
  return { status: response.status, json: (await response.json()) as T }
}

interface ErrorBody {
  error?: { code?: string; message?: string }
}

/**
 * The dashboard's whole fixture: three real visits and one bot on the current window, one row in the
 * previous window, one owner preview, and one foreign account nobody may see.
 */
function dashboardSeed() {
  const noteA = newId()
  const noteB = newId()
  const foreignNote = newId()
  const db = seed({
    notes: [
      { id: noteA, title: 'Alpha' },
      { id: noteB, title: 'Beta' },
      { id: foreignNote, userId: OTHER, title: 'Not yours' },
    ],
    shares: [
      { slug: SLUG_A, noteId: noteA, views: 999, lastViewedAt: T0 - 40 * DAY_MS },
      { slug: SLUG_B, noteId: noteB, views: 999 },
      { slug: SLUG_FOREIGN, noteId: foreignNote, userId: OTHER },
    ],
    visits: [
      {
        noteId: noteA,
        slug: SLUG_A,
        visitedAt: T0 - 60 * 60 * 1000,
        visitorFp: DIGEST_A,
        country: 'cn',
        deviceType: 'mobile',
        os: 'iOS',
        browser: 'Safari',
        userAgent: DESKTOP_UA,
        channel: 'weibo',
      },
      {
        noteId: noteA,
        slug: SLUG_A,
        visitedAt: T0 - 2 * 60 * 60 * 1000,
        visitorFp: DIGEST_A,
        country: 'us',
        referrerHost: 't.co',
        channel: null,
      },
      { noteId: noteB, slug: SLUG_B, visitedAt: T0 - 3 * 60 * 60 * 1000, visitorFp: DIGEST_B, channel: '', isOwner: true },
      {
        noteId: noteA,
        slug: SLUG_A,
        visitedAt: T0 - 4 * 60 * 60 * 1000,
        visitorFp: DIGEST_C,
        isBot: true,
        userAgent: GOOGLEBOT_UA,
      },
      // The previous 7d window, so the three trend badges have something to be measured against.
      { noteId: noteA, slug: SLUG_A, visitedAt: T0 - 10 * DAY_MS, visitorFp: DIGEST_C },
      // Another account's traffic, which no reading here may answer with.
      { noteId: foreignNote, slug: SLUG_FOREIGN, userId: OTHER, visitedAt: T0 - 60 * 1000, visitorFp: DIGEST_C },
    ],
  })
  return { db, noteA, noteB, foreignNote }
}

beforeEach(() => {
  preparedSql = []
})

describe('GET /analytics/global', () => {
  it('measures every KPI over share_visits and never over shares.views', async () => {
    const { db } = dashboardSeed()
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?range=7d')

    expect(json.range).toBe('7d')
    // Three non-bot rows and two fingerprints, while `shares.views` says 999 on both links.
    expect(json.totalViews).toBe(3)
    expect(json.totalVisitors).toBe(2)
    expect(json.totalShares).toBe(2)
    expect(json.activeShares).toBe(2)
    expect(json.timeline).toHaveLength(7)
    expect(json.viewsPerDay).toBe(0.4)
    expect(Number.isFinite(json.viewsPerDay)).toBe(true)
    expect(json.topNotes).toEqual([
      { noteId: expect.any(String), noteTitle: 'Alpha', slug: SLUG_A, views: 2, visitors: 1 },
      { noteId: expect.any(String), noteTitle: 'Beta', slug: SLUG_B, views: 1, visitors: 1 },
    ])
    expect(json.topCountries.map((item) => item.name).sort()).toEqual(['CN', 'UNKNOWN', 'US'])
    expect(json.topReferrers.map((item) => item.name)).toEqual(['Direct', 't.co'])
    expect(json.devices.map((item) => item.name)).toContain('mobile')
    expect(json.osList.map((item) => item.name)).toContain('iOS')
    expect(json.browsers.map((item) => item.name)).toContain('Safari')
    expect(json.filterStats).toEqual({ bots: 1, selfReferrals: 0, owner: 1 })
  })

  it('keeps the two kinds of missing channel marker in separate rows', async () => {
    const { db } = dashboardSeed()
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(json.channels.map((item) => item.name).sort()).toEqual([CHANNEL_UNMARKED, CHANNEL_UNRECOGNIZED, 'weibo'])
  })

  it('names a collection directory behind its marker and leaves a hand-written token alone', async () => {
    const note = newId()
    const db = seed({
      notes: [{ id: note, title: 'Alpha' }],
      shares: [{ slug: 'slug-a', noteId: note }],
      collections: [{ slug: 'abcdefabcdefabcdefab', title: 'Weekly' }],
      visits: [
        {
          noteId: note,
          slug: 'slug-a',
          visitedAt: T0 - 60_000,
          channel: collectionChannelToken('abcdefabcdefabcdefab'),
        },
        { noteId: note, slug: 'slug-a', visitedAt: T0 - 120_000, channel: 'weibo' },
      ],
    })
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(json.channels.find((item) => item.name === collectionChannelToken('abcdefabcdefabcdefab'))?.label).toBe(
      'Weekly',
    )
    expect(json.channels.find((item) => item.name === 'weibo')?.label).toBeUndefined()
  })

  it('answers the traffic filters the query asks for, and nothing else', async () => {
    const { db } = dashboardSeed()
    const raw = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?excludeBots=false')
    expect(raw.json.totalViews).toBe(4)
    expect(raw.json.totalVisitors).toBe(3)

    const noOwner = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?excludeOwner=true')
    expect(noOwner.json.totalViews).toBe(2)

    const noSelf = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?excludeSelf=true')
    expect(noSelf.json.totalViews).toBe(3)
  })

  it('reports a previous period of nothing as no change, not as a rise from nothing', async () => {
    const note = newId()
    const db = seed({
      notes: [{ id: note }],
      shares: [{ slug: 'slug-a', noteId: note }],
      visits: [{ noteId: note, slug: 'slug-a', visitedAt: T0 - 60_000, visitorFp: DIGEST_A }],
    })
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?range=24h')
    expect(json.totalViews).toBe(1)
    expect(json.viewsDelta).toBeUndefined()
    expect(json.visitorsDelta).toBeUndefined()
    expect(json.viewsPerDayDelta).toBeUndefined()
    // A one-day window is measured per day, never per zero.
    expect(json.viewsPerDay).toBe(1)
    expect(json.timeline).toHaveLength(24)
  })

  it('measures the rate against the same length of previous window', async () => {
    const { db } = dashboardSeed()
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?range=7d')
    expect(json.viewsDelta).toBe(200)
    expect(json.visitorsDelta).toBe(100)
    // 3 views over 7 days is 0.4/day and 1 over the same length is 0.1/day, so the pace tripled.
    expect(json.viewsPerDayDelta).toBe(300)
  })

  it('caps the top-notes card at the shared card limit', async () => {
    const notes = Array.from({ length: 12 }, () => newId())
    const db = seed({
      notes: notes.map((id) => ({ id })),
      shares: notes.map((id, index) => ({ slug: `slug-${index}`, noteId: id })),
      visits: notes.map((id, index) => ({
        noteId: id,
        slug: `slug-${index}`,
        visitedAt: T0 - (index + 1) * 60_000,
        visitorFp: `fp-${index}`,
      })),
    })
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(json.topNotes).toHaveLength(10)
    expect(json.topCountries).toHaveLength(1)
  })

  it('lists the quiet links the stale report owns, and the lapsed ones the notice owns', async () => {
    const staleNote = newId()
    const neverNote = newId()
    const expiredNote = newId()
    const db = seed({
      notes: [{ id: staleNote }, { id: neverNote }, { id: expiredNote }],
      shares: [
        { slug: 'slug-stale', noteId: staleNote, lastViewedAt: T0 - 31 * DAY_MS, views: 7 },
        { slug: 'slug-never', noteId: neverNote },
        { slug: 'slug-expired', noteId: expiredNote, expiresAt: T0 - 60 * 60 * 1000 },
      ],
    })
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(json.staleLinks.thresholdDays).toBe(SHARE_STALE_DEFAULT_DAYS)
    expect(json.staleLinks.total).toBe(2)
    expect(json.staleLinks.neverViewed).toBe(1)
    expect(json.staleLinks.items.map((item) => item.slug).sort()).toEqual(['slug-never', 'slug-stale'])
    // `views` is the all-time counter the card prints, so a link read once years ago is not "never read".
    expect(json.staleLinks.items.find((item) => item.slug === 'slug-stale')?.views).toBe(7)
    expect(json.expiredLinks?.total).toBe(1)
    expect(json.expiredLinks?.items[0]?.slug).toBe('slug-expired')
    expect(json.expiredLinks?.acknowledgedAt).toBeNull()
  })

  it('holds no other account row anywhere in the reading', async () => {
    const { db, foreignNote } = dashboardSeed()
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?excludeBots=false')
    const text = JSON.stringify(json)
    expect(text).not.toContain(foreignNote)
    expect(text).not.toContain(SLUG_FOREIGN)
    expect(text).not.toContain('Not yours')
    expect(text).not.toContain(OTHER)
  })
})

describe('visit rows leaving the worker', () => {
  it('truncates the fingerprint and drops the raw user agent', async () => {
    const { db } = dashboardSeed()
    const { json } = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?excludeBots=false')
    const text = JSON.stringify(json)
    expect(text).not.toContain(DIGEST_A)
    expect(text).not.toContain(DIGEST_B)
    expect(text).not.toContain('Mozilla')
    expect(text).not.toContain('user_agent')
    expect(text).not.toContain('visitor_fp')
    expect(json.recentVisits.map((row) => row.visitorFp)).toEqual([
      DIGEST_A.slice(0, 8),
      DIGEST_A.slice(0, 8),
      DIGEST_B.slice(0, 8),
      DIGEST_C.slice(0, 8),
    ])
    expect(json.recentVisits.find((row) => row.isBot)?.botName).toBe('Googlebot')
    expect(json.recentVisits.find((row) => !row.isBot)?.botName).toBeNull()
  })

  it('keeps a trashed note rows traffic in the log instead of dropping it', async () => {
    const note = newId()
    const db = seed({
      notes: [{ id: note, deletedAt: T0 - 1000 }],
      shares: [{ slug: 'slug-a', noteId: note }],
      visits: [{ noteId: note, slug: 'slug-a', visitedAt: T0 - 60_000, visitorFp: DIGEST_A }],
    })
    const { json } = await get<ShareVisitsResponse>(db, OWNER, '/visits')
    expect(json.total).toBe(1)
    expect(json.visits[0]?.noteTitle).toBe('A note')
  })
})

describe('POST /analytics/expired-ack', () => {
  it('keeps the dismissal per account and hides only what lapsed before it', async () => {
    const expiredNote = newId()
    const db = seed({
      notes: [{ id: expiredNote }],
      shares: [{ slug: 'slug-expired', noteId: expiredNote, expiresAt: T0 - 60 * 60 * 1000 }],
    })
    const before = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(before.json.expiredLinks?.total).toBe(1)

    expect((await send<{ ok: boolean }>(db, OWNER, 'POST', '/analytics/expired-ack')).json).toEqual({ ok: true })

    const after = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(after.json.expiredLinks?.total).toBe(0)
    expect(after.json.expiredLinks?.acknowledgedAt).toBeGreaterThan(0)

    // The stamp is one row of `app_meta` under a versioned, per-account key.
    const stored = await db
      .prepare(`SELECT key, value FROM app_meta WHERE key = ?1`)
      .bind(expiredAckMetaKey(OWNER))
      .first<{ key: string; value: string }>()
    expect(stored?.key).toBe(`share:expired-ack:v1:${OWNER}`)
    expect(parseExpiredAck(stored?.value ?? null)).toBe(after.json.expiredLinks?.acknowledgedAt)
    expect(expiredAckMetaKey(OWNER)).not.toBe(expiredAckMetaKey(OTHER))

    // The notice stays dismissed for a link that lapsed before the dismissal, whatever it says next.
    await db.prepare(`UPDATE shares SET expires_at = ?1 WHERE slug = ?2`).bind(T0 - 500, 'slug-expired').run()
    const again = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(again.json.expiredLinks?.total).toBe(0)

    const foreign = await get<ShareGlobalAnalytics>(db, OTHER, '/analytics/global')
    expect(foreign.json.expiredLinks?.acknowledgedAt).toBeNull()
  })

  it('reads a corrupt dismissal as never dismissed', () => {
    expect(parseExpiredAck(null)).toBeNull()
    expect(parseExpiredAck('')).toBeNull()
    expect(parseExpiredAck('abc')).toBeNull()
    expect(parseExpiredAck('-1')).toBeNull()
    expect(parseExpiredAck('1.5')).toBeNull()
    expect(parseExpiredAck(String(T0))).toBe(T0)
  })
})

describe('GET /analytics/note/:noteId', () => {
  it('answers the one link, scoped to the window and to the note', async () => {
    const { db, noteA } = dashboardSeed()
    const { status, json } = await get<ShareNoteAnalytics>(db, OWNER, `/analytics/note/${noteA}?range=24h`)
    expect(status).toBe(200)
    expect(json.slug).toBe(SLUG_A)
    expect(json.noteTitle).toBe('Alpha')
    expect(json.url).toBe(`http://localhost/s/${SLUG_A}`)
    expect(json.hasPassword).toBe(false)
    expect(json.isEnabled).toBe(true)
    expect(json.expiresAt).toBeNull()
    expect(json.totalViews).toBe(2)
    expect(json.totalVisitors).toBe(1)
    expect(json.timeline).toHaveLength(24)
    expect(json.recentVisits).toHaveLength(2)
    expect(json.recentVisits.every((row) => row.noteId === noteA)).toBe(true)
  })

  it('refuses a malformed and a foreign note id with the same 404', async () => {
    const { db, foreignNote } = dashboardSeed()
    const malformed = await get<ErrorBody>(db, OWNER, '/analytics/note/not-an-id')
    const foreign = await get<ErrorBody>(db, OWNER, `/analytics/note/${foreignNote}`)
    const missing = await get<ErrorBody>(db, OWNER, `/analytics/note/${newId()}`)
    expect(malformed.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(JSON.stringify(foreign.json)).not.toContain('Not yours')
  })

  it('summarizes the whole history for range=all from the earliest row the account has', async () => {
    const note = newId()
    const db = seed({
      notes: [{ id: note }],
      shares: [{ slug: 'slug-a', noteId: note }],
      visits: [
        { noteId: note, slug: 'slug-a', visitedAt: T0 - 400 * DAY_MS, visitorFp: DIGEST_A },
        { noteId: note, slug: 'slug-a', visitedAt: T0 - 60_000, visitorFp: DIGEST_B },
      ],
    })
    const { json } = await get<ShareNoteAnalytics>(db, OWNER, `/analytics/note/${note}?range=all`)
    expect(json.totalViews).toBe(2)
    expect(json.timeline).toHaveLength(12)
    expect(analyticsWindow('all', T0, T0 - 400 * DAY_MS).duration).toBeGreaterThanOrEqual(399 * DAY_MS)
  })
})

describe('GET /visits', () => {
  it('pages with the shared limits and holds OFFSET inside four figures', async () => {
    const note = newId()
    const db = seed({
      notes: [{ id: note }],
      shares: [{ slug: 'slug-a', noteId: note }],
      visits: Array.from({ length: 5 }, (_, index) => ({
        noteId: note,
        slug: 'slug-a',
        visitedAt: T0 - index * 60_000,
        visitorFp: `fp-${index}`,
      })),
    })
    const first = await get<ShareVisitsResponse>(db, OWNER, '/visits?page=1&limit=2')
    expect(first.json).toMatchObject({ total: 5, page: 1, limit: 2, totalPages: 3 })
    expect(first.json.visits).toHaveLength(2)
    const last = await get<ShareVisitsResponse>(db, OWNER, '/visits?page=3&limit=2')
    expect(last.json.visits).toHaveLength(1)

    // `page` and `limit` are capped by the shared product limits, so the deepest OFFSET a caller can name
    // is (shareVisitsPageMax - 1) * shareVisitsPerPage = 9 900 rows.
    const clamped = await get<ShareVisitsResponse>(db, OWNER, '/visits?page=99999&limit=99999')
    expect(clamped.json.page).toBe(LIMITS.shareVisitsPageMax)
    expect(clamped.json.limit).toBe(LIMITS.shareVisitsPerPage)
    expect(clamped.json.visits).toEqual([])
    expect(clamped.json.totalPages).toBe(1)
  })

  it('refuses an unknown filter and an unusable channel instead of answering with everything', async () => {
    const { db } = dashboardSeed()
    const filter = await get<ErrorBody>(db, OWNER, '/visits?filter=everything')
    const squatted = await get<ErrorBody>(db, OWNER, '/visits?channel=__squatted__')
    const injection = await get<ErrorBody>(db, OWNER, "/visits?channel=' OR 1=1--")
    expect(filter.status).toBe(400)
    expect(squatted.status).toBe(400)
    expect(injection.status).toBe(400)
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM share_visits`).first<{ n: number }>()
    expect(rows).toMatchObject({ n: 6 })
  })

  it('splits the log by the single-choice filter, one class at a time', async () => {
    const { db } = dashboardSeed()
    expect((await get<ShareVisitsResponse>(db, OWNER, '/visits')).json.total).toBe(5)
    expect((await get<ShareVisitsResponse>(db, OWNER, '/visits?filter=real')).json.total).toBe(3)
    const bot = await get<ShareVisitsResponse>(db, OWNER, '/visits?filter=bot')
    expect(bot.json.total).toBe(1)
    expect(bot.json.visits[0]?.botName).toBe('Googlebot')
    const owner = await get<ShareVisitsResponse>(db, OWNER, '/visits?filter=owner')
    expect(owner.json.total).toBe(1)
    expect(owner.json.visits[0]?.isOwner).toBe(true)
    expect((await get<ShareVisitsResponse>(db, OWNER, '/visits?filter=self')).json.total).toBe(0)
  })

  it('drills a channel down to its own rows, both kinds of miss included', async () => {
    const { db } = dashboardSeed()
    const weibo = await get<ShareVisitsResponse>(db, OWNER, '/visits?channel=weibo')
    expect(weibo.json.total).toBe(1)
    expect(weibo.json.visits[0]?.channel).toBe('weibo')
    const unmarked = await get<ShareVisitsResponse>(db, OWNER, `/visits?channel=${CHANNEL_UNMARKED}`)
    expect(unmarked.json.total).toBe(3)
    expect(unmarked.json.visits.every((row) => row.channel === null)).toBe(true)
    const unrecognized = await get<ShareVisitsResponse>(db, OWNER, `/visits?channel=${CHANNEL_UNRECOGNIZED}`)
    expect(unrecognized.json.total).toBe(1)
    expect(unrecognized.json.visits[0]?.channel).toBeNull()
  })

  it('narrows to one note or one slug, and answers 404 for another account link', async () => {
    const { db, noteA, noteB, foreignNote } = dashboardSeed()
    const byNote = await get<ShareVisitsResponse>(db, OWNER, `/visits?noteId=${noteA}`)
    // The log is not narrowed by the dashboard's traffic filters, so the bot row is in it too.
    expect(byNote.json.total).toBe(4)
    expect(byNote.json.visits.every((row) => row.noteId === noteA)).toBe(true)
    const bySlug = await get<ShareVisitsResponse>(db, OWNER, `/visits?slug=${SLUG_B}`)
    expect(bySlug.json.total).toBe(1)
    expect(bySlug.json.visits[0]?.noteId).toBe(noteB)

    expect((await get<ErrorBody>(db, OWNER, `/visits?noteId=${foreignNote}`)).status).toBe(404)
    expect((await get<ErrorBody>(db, OWNER, `/visits?slug=${SLUG_FOREIGN}`)).status).toBe(404)
    expect((await get<ErrorBody>(db, OWNER, '/visits?noteId=nope')).status).toBe(400)
    expect((await get<ErrorBody>(db, OWNER, '/visits?slug=nope')).status).toBe(400)
    expect((await get<ErrorBody>(db, OWNER, `/visits?noteId=${noteA}&slug=${SLUG_B}`)).status).toBe(400)
  })

  it('leaves out the traffic whose link has been revoked', async () => {
    const note = newId()
    const db = seed({
      notes: [{ id: note }],
      shares: [{ slug: 'slug-a', noteId: note }],
      visits: [
        { noteId: note, slug: 'slug-a', visitedAt: T0 - 60_000 },
        { noteId: note, slug: 'slug-gone', visitedAt: T0 - 120_000 },
      ],
    })
    const { json } = await get<ShareVisitsResponse>(db, OWNER, '/visits')
    expect(json.total).toBe(1)
    expect(json.visits[0]?.slug).toBe('slug-a')
  })

  it('treats a blank narrowing value as no narrowing at all', async () => {
    const { db } = dashboardSeed()
    const { json } = await get<ShareVisitsResponse>(db, OWNER, '/visits?noteId=%20&slug=')
    expect(json.total).toBe(5)
  })
})

describe('DELETE /visits', () => {
  it('empties the account log and leaves its link counters agreeing with it', async () => {
    const { db } = dashboardSeed()
    const response = await send<{ ok: boolean; deleted: number }>(db, OWNER, 'DELETE', '/visits')
    expect(response.json.ok).toBe(true)
    expect(response.json.deleted).toBe(5)

    const remaining = await db.prepare(`SELECT user_id, COUNT(*) AS n FROM share_visits GROUP BY user_id`).all<{ user_id: string; n: number }>()
    expect(remaining.results).toEqual([{ user_id: OTHER, n: 1 }])

    const counters = await db
      .prepare(`SELECT slug, views, last_viewed_at FROM shares WHERE user_id = ?1 ORDER BY slug`)
      .bind(OWNER)
      .all<{ slug: string; views: number; last_viewed_at: number | null }>()
    expect(counters.results).toEqual([
      { slug: SLUG_A, views: 0, last_viewed_at: null },
      { slug: SLUG_B, views: 0, last_viewed_at: null },
    ])

    const dashboard = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    expect(dashboard.json.totalViews).toBe(0)
    expect(dashboard.json.totalVisitors).toBe(0)
    expect(dashboard.json.topNotes).toEqual([])
    expect(dashboard.json.recentVisits).toEqual([])
    const log = await get<ShareVisitsResponse>(db, OWNER, '/visits')
    expect(log.json.total).toBe(0)
    expect(log.json.totalPages).toBe(0)
    const footer = await get<ShareStatsResponse>(db, OWNER, '/stats')
    expect(footer.json.globalStats).toMatchObject({ totalViews: 0, totalVisitors: 0, totalShares: 2 })
  })
})

describe('GET /stats', () => {
  const noteLive = newId()
  const notePaused = newId()
  const notePinned = newId()
  const noteStarred = newId()
  const noteGuarded = newId()
  const noteExpiringSoon = newId()
  const noteExpiring = newId()
  const noteExpired = newId()
  const noteTrashed = newId()
  const FOLDER_ID = newId()

  function statsSeed(): D1Database {
    return seed({
      notes: [
        { id: noteLive },
        { id: notePaused },
        { id: notePinned, isPinned: 1 },
        { id: noteStarred, isStarred: 1 },
        { id: noteGuarded },
        { id: noteExpiringSoon },
        { id: noteExpiring },
        { id: noteExpired },
        { id: noteTrashed, deletedAt: T0 - 1000 },
      ],
      folders: [{ id: FOLDER_ID, name: 'Published' }],
      tags: [{ id: newId(), name: 'report' }, { id: newId(), name: 'monthly-report' }],
      shares: [
        { slug: 's-live', noteId: noteLive, folderId: FOLDER_ID, tags: ['report', 'monthly-report'], views: 400 },
        { slug: 's-paused', noteId: notePaused, isEnabled: 0, tags: ['report'], views: 400 },
        { slug: 's-pinned', noteId: notePinned, folderId: FOLDER_ID },
        { slug: 's-starred', noteId: noteStarred },
        { slug: 's-guarded', noteId: noteGuarded, passwordHash: 'scrypt$1' },
        { slug: 's-soon', noteId: noteExpiringSoon, expiresAt: T0 + 3 * DAY_MS, tags: ['monthly-report'], views: 400 },
        { slug: 's-later', noteId: noteExpiring, expiresAt: T0 + 40 * DAY_MS },
        { slug: 's-expired', noteId: noteExpired, expiresAt: T0 - DAY_MS, views: 400 },
        { slug: 's-trashed', noteId: noteTrashed, tags: ['report'] },
      ],
      visits: [
        { noteId: noteLive, slug: 's-live', visitedAt: T0 - 60_000, visitorFp: DIGEST_A },
        { noteId: noteLive, slug: 's-live', visitedAt: T0 - 120_000, visitorFp: DIGEST_A },
        { noteId: notePaused, slug: 's-paused', visitedAt: T0 - 180_000, visitorFp: DIGEST_B },
        {
          noteId: noteLive,
          slug: 's-live',
          visitedAt: T0 - 240_000,
          visitorFp: null,
          isBot: true,
          userAgent: GOOGLEBOT_UA,
        },
        { noteId: noteLive, slug: 's-gone', visitedAt: T0 - 300_000, visitorFp: DIGEST_C },
      ],
    })
  }

  /** The eight links whose note row is live, as the shared JS rule reads them. */
  const liveSubjects: ShareSelectionSubject[] = [
    { isEnabled: true, expiresAt: null, hasPassword: false, isPinned: false, isStarred: false },
    { isEnabled: false, expiresAt: null, hasPassword: false, isPinned: false, isStarred: false },
    { isEnabled: true, expiresAt: null, hasPassword: false, isPinned: true, isStarred: false },
    { isEnabled: true, expiresAt: null, hasPassword: false, isPinned: false, isStarred: true },
    { isEnabled: true, expiresAt: null, hasPassword: true, isPinned: false, isStarred: false },
    { isEnabled: true, expiresAt: T0 + 3 * DAY_MS, hasPassword: false, isPinned: false, isStarred: false },
    { isEnabled: true, expiresAt: T0 + 40 * DAY_MS, hasPassword: false, isPinned: false, isStarred: false },
    { isEnabled: true, expiresAt: T0 - DAY_MS, hasPassword: false, isPinned: false, isStarred: false },
  ]

  it('numbers every category exactly as the shared JS rule reads the same rows', async () => {
    const db = statsSeed()
    const { json } = await get<ShareStatsResponse>(db, OWNER, '/stats')
    const stats = json.globalStats
    // `now` moves a few milliseconds between the route and this assertion; nothing here sits on a boundary.
    const now = Date.now()
    const countBy = (status: (typeof SHARE_CATEGORY_STATUS)[keyof typeof SHARE_CATEGORY_STATUS]) =>
      liveSubjects.filter((subject) => shareMatchesStatus(subject, status, now)).length

    expect(countBy('active')).toBe(6)
    expect(stats.totalShares).toBe(countBy('all'))
    expect(stats.activeShares).toBe(countBy('active'))
    expect(stats.pausedShares).toBe(countBy('paused'))
    expect(stats.pinnedShares).toBe(countBy('pinned'))
    expect(stats.starredShares).toBe(countBy('starred'))
    expect(stats.passwordShares).toBe(countBy('password'))
    expect(stats.expiringSoonShares).toBe(countBy('expiring_soon'))
    expect(stats.expiringShares).toBe(countBy('expiring'))
    expect(stats.permanentShares).toBe(countBy('permanent'))
    expect(stats.expiredShares).toBe(countBy('expired'))
  })

  it('counts the links of a trashed note out of every category, as the list does', async () => {
    const db = statsSeed()
    const { json } = await get<ShareStatsResponse>(db, OWNER, '/stats')
    expect(json.globalStats.totalShares).toBe(8)
    expect(json.globalStats.tagCounts.report).toEqual({ total: 2, shared: 1 })
  })

  it('takes PV and UV from one statement over share_visits, never from shares.views', async () => {
    const db = statsSeed()
    const { json } = await get<ShareStatsResponse>(db, OWNER, '/stats')
    const stats = json.globalStats
    // Three non-bot rows whose link still exists, over two fingerprints.
    expect(stats.totalViews).toBe(3)
    expect(stats.totalVisitors).toBe(2)
    const viewsSum = await db
      .prepare(`SELECT COALESCE(SUM(views), 0) AS total FROM shares WHERE user_id = ?1`)
      .bind(OWNER)
      .first<{ total: number }>()
    expect(viewsSum?.total).toBeGreaterThan(stats.totalViews)
    expect(stats.totalViews).not.toBe(viewsSum?.total)

    const empty = await get<ShareStatsResponse>(seed({}), OWNER, '/stats')
    expect(empty.json.globalStats).toMatchObject({ totalViews: 0, totalVisitors: 0 })
  })

  it('counts a folder once per link and only the live ones as shared', async () => {
    const db = statsSeed()
    const { json } = await get<ShareStatsResponse>(db, OWNER, '/stats')
    expect(json.globalStats.folderCounts[FOLDER_ID]).toEqual({ total: 2, shared: 2 })
  })

  it('matches a tag as an array element, never as a substring of another name', async () => {
    const db = statsSeed()
    const { json } = await get<ShareStatsResponse>(db, OWNER, '/stats')
    // `report` is carried by s-live, s-paused and the trashed s-trashed; `monthly-report` only by s-live and
    // s-soon, which is still active. A substring test would have put both names at the same totals.
    expect(json.globalStats.tagCounts.report).toEqual({ total: 2, shared: 1 })
    expect(json.globalStats.tagCounts['monthly-report']).toEqual({ total: 2, shared: 2 })
  })

  it('builds every count from the shared status rule, and repeats no rule inline', async () => {
    const db = statsSeed()
    preparedSql = []
    await get<ShareStatsResponse>(db, OWNER, '/stats')
    await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    await get<ShareVisitsResponse>(db, OWNER, '/visits')
    const normalized = preparedSql.map((sql) => sql.replace(/\s+/g, ' ').replace(/\?\d+/g, '?'))
    const now = Date.now()
    for (const status of Object.keys(SHARE_CATEGORY_STATUS)) {
      const fragment = shareStatusSql(status as Parameters<typeof shareStatusSql>[0], now, 2)
      if (!fragment) continue
      const expected = fragment.sql.replace(/\s+/g, ' ').replace(/\?\d+/g, '?')
      expect(normalized.some((sql) => sql.includes(expected))).toBe(true)
    }
    const all = normalized.join('\n')
    // The `OR is_enabled IS NULL` arm a `NOT NULL DEFAULT 1` column cannot produce appears nowhere, and
    // neither does a hand-spelled `is_enabled = 1 OR`.
    expect(all).not.toMatch(/is_enabled\s+IS\s+NULL/)
    expect(all).not.toMatch(/is_enabled\s*=\s*1\s+OR/)
  })

  it('keeps every statement scoped to the account that asked, with no value in its text', async () => {
    const db = statsSeed()
    const foreign = await get<ShareStatsResponse>(db, OTHER, '/stats')
    expect(foreign.json.globalStats.totalShares).toBe(0)
    expect(foreign.json.globalStats.totalViews).toBe(0)
    expect(foreign.json.globalStats.folderCounts).toEqual({})
    expect(foreign.json.globalStats.tagCounts).toEqual({})

    preparedSql = []
    await get<ShareStatsResponse>(db, OWNER, '/stats')
    await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global')
    await get<ShareVisitsResponse>(db, OWNER, `/visits?noteId=${noteLive}`)
    for (const sql of preparedSql) {
      expect(sql).toContain('?1')
      expect(sql).not.toContain(OWNER)
      expect(sql).not.toContain(DIGEST_A)
    }
    const visitReads = preparedSql.filter((sql) => /FROM share_visits/.test(sql))
    expect(visitReads.length).toBeGreaterThanOrEqual(9)
    for (const sql of visitReads) expect(sql).toMatch(/user_id = \?\d+/)
  })
})

describe('analytics reads and their limits', () => {
  it('requires an authenticated account', async () => {
    const router = new Hono<AppBindings>()
    router.onError((err, c) => errorResponse(c, err))
    router.route('/api/share', shareAnalyticsRoutes)
    const response = await router.request('/api/share/stats', undefined, { DB: seed({}) } as unknown as Env)
    expect(response.status).toBe(401)
  })

  it('brakes a runaway reader with the repo budget, not with a new ledger', async () => {
    const loop = 'runaway-account'
    const db = seed({})
    let status = 200
    for (let index = 0; index < 130; index += 1) {
      status = (await get<ErrorBody>(db, loop, '/stats')).status
      if (status === 429) break
    }
    expect(status).toBe(429)
    // The brake is per account: this one says nothing about any other reader.
    expect((await get<ShareStatsResponse>(db, OWNER, '/stats')).status).toBe(200)
  })

  it('labels a fingerprint the same way in the log and in the dashboard', async () => {
    const { db } = dashboardSeed()
    const log = await get<ShareVisitsResponse>(db, OWNER, '/visits?filter=bot')
    const dashboard = await get<ShareGlobalAnalytics>(db, OWNER, '/analytics/global?excludeBots=false')
    const botRow = log.json.visits[0]
    const botVisit = dashboard.json.recentVisits.find((row) => row.isBot)
    expect(botRow?.visitorFp).toBe(botVisit?.visitorFp)
    expect(botRow?.visitorFp).toBe(DIGEST_C.slice(0, 8))
  })
})
