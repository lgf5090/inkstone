// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoStats } from '../src/shared/memos/types'
import { MEMOS_SCHEMA_STATEMENTS } from '../src/worker/memos/schema'
import { memoStatsRoutes } from '../src/worker/routes/memos/stats'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const SPACE_A = 's'.repeat(26)
const SPACE_B = 't'.repeat(26)
const MISSING_SPACE = 'z'.repeat(26)

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    if (!mocks.userId) {
      throw new (await import('../src/worker/lib/errors')).ApiError(401, 'unauthenticated', 'Please sign in first')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/memos/stats', memoStatsRoutes)

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

function memoId(index: number): string {
  return `${'a'.repeat(24)}${String(index).padStart(2, '0')}`
}

function seconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000)
}

interface MemoSeed {
  id: string
  userId?: string
  spaceId?: string | null
  parentId?: string | null
  state?: 'normal' | 'archived'
  createdAt?: number
  updatedAt?: number
  hasLink?: boolean
  hasCode?: boolean
  hasTaskList?: boolean
  hasIncompleteTasks?: boolean
}

function insertMemo(seed: MemoSeed): void {
  const createdAt = seed.createdAt ?? 1_000
  sqlite.prepare(
    `INSERT INTO memos_items (
       id, user_id, space_id, parent_id, content, content_search, title, snippet,
       visibility, state, pinned, has_link, has_code, has_task_list, has_incomplete_tasks,
       has_location, rev, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '', '', '', '', 'private', ?, 0, ?, ?, ?, ?, 0, 1, ?, ?)`,
  ).run(
    seed.id,
    seed.userId ?? OWNER,
    seed.spaceId ?? null,
    seed.parentId ?? null,
    seed.state ?? 'normal',
    seed.hasLink ? 1 : 0,
    seed.hasCode ? 1 : 0,
    seed.hasTaskList ? 1 : 0,
    seed.hasIncompleteTasks ? 1 : 0,
    createdAt,
    seed.updatedAt ?? createdAt,
  )
}

function insertTag(memoId: string, tag: string): void {
  sqlite.prepare('INSERT INTO memos_tags (memo_id, tag) VALUES (?, ?)').run(memoId, tag)
}

function insertAttachment(id: string, memoId: string | null, size: number, userId = OWNER): void {
  sqlite.prepare(
    `INSERT INTO memos_attachments (
       id, user_id, memo_id, filename, mime, size, storage, storage_key,
       width, height, thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at
     ) VALUES (?, ?, ?, 'file.bin', 'application/octet-stream', ?, 'r2', ?,
       NULL, NULL, NULL, NULL, NULL, NULL, 1000, 1000)`,
  ).run(id, userId, memoId, size, `key-${id}`)
}

function insertSpace(id: string, userId: string): void {
  sqlite.prepare(
    `INSERT INTO memos_spaces (id, user_id, title, description, icon, created_at, updated_at)
     VALUES (?, ?, 'Space', '', '', 100, 100)`,
  ).run(id, userId)
}

async function request(query = '', userId = OWNER): Promise<Response> {
  mocks.userId = userId
  return await app.request(`/api/memos/stats${query}`, {}, testBindings(db), ctx)
}

async function stats(query = '', userId = OWNER): Promise<MemoStats> {
  const response = await request(query, userId)
  expect(response.status).toBe(200)
  return await response.json() as MemoStats
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MEMOS_SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  mocks.userId = OWNER
})

describe('memo stats', () => {
  it('returns zeroed statistics when the account has nothing', async () => {
    await expect(stats()).resolves.toEqual({
      total: 0,
      archived: 0,
      comments: 0,
      attachmentBytes: 0,
      tagCounts: {},
      typeCounts: { link: 0, code: 0, todo: 0, undo: 0 },
      dayCounts: {},
    })
  })

  it('counts normal top-level memos, archived memos, and normal comments', async () => {
    insertMemo({ id: memoId(1) })
    insertMemo({ id: memoId(2) })
    insertMemo({ id: memoId(3), state: 'archived' })
    insertMemo({ id: memoId(4), parentId: memoId(1) })
    insertMemo({ id: memoId(5), parentId: memoId(1), state: 'archived' })
    insertMemo({ id: memoId(6), userId: OTHER })

    const body = await stats()

    expect({ total: body.total, archived: body.archived, comments: body.comments }).toEqual({
      total: 2,
      archived: 1,
      comments: 1,
    })
  })

  it('groups tags over normal top-level memos only', async () => {
    insertMemo({ id: memoId(1) })
    insertTag(memoId(1), 'work')
    insertTag(memoId(1), 'daily')
    insertMemo({ id: memoId(2) })
    insertTag(memoId(2), 'work')
    insertMemo({ id: memoId(3), state: 'archived' })
    insertTag(memoId(3), 'old')
    insertMemo({ id: memoId(4), parentId: memoId(1) })
    insertTag(memoId(4), 'reply')
    insertMemo({ id: memoId(5), userId: OTHER })
    insertTag(memoId(5), 'theirs')

    const body = await stats()

    expect(body.tagCounts).toEqual({ work: 2, daily: 1 })
  })

  it('counts link, code, todo, and undo over normal top-level memos only', async () => {
    insertMemo({ id: memoId(1), hasLink: true })
    insertMemo({
      id: memoId(2),
      hasCode: true,
      hasTaskList: true,
      hasIncompleteTasks: true,
    })
    insertMemo({ id: memoId(3), state: 'archived', hasLink: true, hasCode: true })
    insertMemo({
      id: memoId(4),
      parentId: memoId(1),
      hasLink: true,
      hasTaskList: true,
      hasIncompleteTasks: true,
    })
    insertMemo({ id: memoId(5), userId: OTHER, hasLink: true, hasCode: true })

    const body = await stats()

    expect(body.typeCounts).toEqual({ link: 1, code: 1, todo: 1, undo: 1 })
  })

  it('buckets days in the requested IANA timezone and falls back to UTC', async () => {
    insertMemo({ id: memoId(1), createdAt: seconds('2026-01-01T15:30:00Z') })
    insertMemo({ id: memoId(2), createdAt: seconds('2026-01-01T16:30:00Z') })
    insertMemo({ id: memoId(3), createdAt: seconds('2026-01-02T15:30:00Z') })
    insertMemo({ id: memoId(4), parentId: memoId(1), createdAt: seconds('2026-01-02T15:30:00Z') })
    insertMemo({ id: memoId(5), state: 'archived', createdAt: seconds('2026-01-02T15:30:00Z') })
    insertMemo({ id: memoId(6), userId: OTHER, createdAt: seconds('2026-01-02T15:30:00Z') })

    const shanghai = await stats(`?tz=${encodeURIComponent('Asia/Shanghai')}`)
    expect(shanghai.dayCounts).toEqual({ '2026-01-01': 1, '2026-01-02': 2 })

    const fallback = await stats('?tz=Mars/Olympus')
    expect(fallback.dayCounts).toEqual({ '2026-01-01': 2, '2026-01-02': 1 })
  })

  it('applies from and to on the chosen time basis', async () => {
    insertMemo({
      id: memoId(1),
      createdAt: seconds('2026-01-01T00:00:00Z'),
      updatedAt: seconds('2026-01-05T00:00:00Z'),
    })
    insertMemo({
      id: memoId(2),
      createdAt: seconds('2026-01-03T00:00:00Z'),
      updatedAt: seconds('2026-01-03T00:00:00Z'),
    })

    const from = seconds('2026-01-02T00:00:00Z')
    const to = seconds('2026-01-04T00:00:00Z')
    const updated = await stats(`?from=${from}&to=${to}&timeBasis=updated&tz=UTC`)
    expect(updated.dayCounts).toEqual({ '2026-01-03': 1 })

    const created = await stats(
      `?from=${seconds('2026-01-01T00:00:00Z')}&to=${seconds('2026-01-03T00:00:00Z')}&tz=UTC`,
    )
    expect(created.dayCounts).toEqual({ '2026-01-01': 1 })
  })

  it('scopes every count to an owned space and sums all owned attachment bytes otherwise', async () => {
    insertSpace(SPACE_A, OWNER)
    insertSpace(SPACE_B, OWNER)

    insertMemo({ id: memoId(1), spaceId: SPACE_A, hasLink: true })
    insertTag(memoId(1), 'work')
    insertMemo({ id: memoId(2), spaceId: SPACE_A, parentId: memoId(1) })
    insertTag(memoId(2), 'reply')
    insertMemo({ id: memoId(3), spaceId: SPACE_A, state: 'archived' })
    insertMemo({ id: memoId(4), spaceId: SPACE_B, hasCode: true })
    insertTag(memoId(4), 'work')
    insertMemo({ id: memoId(5) })
    insertMemo({ id: memoId(6), userId: OTHER, spaceId: SPACE_A, hasLink: true })
    insertTag(memoId(6), 'theirs')

    insertAttachment('f1', memoId(1), 10)
    insertAttachment('f2', memoId(2), 20)
    insertAttachment('f3', memoId(3), 30)
    insertAttachment('f4', memoId(4), 40)
    insertAttachment('f5', null, 50)
    insertAttachment('f6', memoId(5), 60)
    insertAttachment('f7', memoId(6), 70, OTHER)

    const scoped = await stats(`?spaceId=${SPACE_A}`)
    expect(scoped).toEqual({
      total: 1,
      archived: 1,
      comments: 1,
      attachmentBytes: 60,
      tagCounts: { work: 1 },
      typeCounts: { link: 1, code: 0, todo: 0, undo: 0 },
      dayCounts: { '1970-01-01': 1 },
    })

    const all = await stats()
    expect(all.total).toBe(3)
    expect(all.archived).toBe(1)
    expect(all.comments).toBe(1)
    expect(all.tagCounts).toEqual({ work: 2 })
    expect(all.typeCounts).toEqual({ link: 1, code: 1, todo: 0, undo: 0 })
    expect(all.attachmentBytes).toBe(210)
  })

  it('sums attachment bytes for comments, archived memos, and unbound files', async () => {
    insertMemo({ id: memoId(1) })
    insertMemo({ id: memoId(2), parentId: memoId(1) })
    insertMemo({ id: memoId(3), state: 'archived' })

    insertAttachment('f1', memoId(1), 20)
    insertAttachment('f2', memoId(2), 30)
    insertAttachment('f3', memoId(3), 40)
    insertAttachment('f4', null, 10)
    insertAttachment('f5', memoId(1), 50, OTHER)

    const body = await stats()

    expect(body.attachmentBytes).toBe(100)
  })

  it('refuses every request without a session', async () => {
    const response = await request('', '')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })
  })

  it('rejects invalid numbers, time bases, and space ids with 400', async () => {
    const cases: Array<[string, string]> = [
      ['?from=abc', 'from must be a Unix timestamp in seconds'],
      ['?to=1.5', 'to must be a Unix timestamp in seconds'],
      ['?from=200&to=100', 'from must be less than to'],
      ['?timeBasis=archived', 'timeBasis must be created or updated'],
      ['?spaceId=bad', 'spaceId must be a valid id'],
    ]

    for (const [query, message] of cases) {
      const response = await request(query)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { code: 'bad_request', message } })
    }
  })

  it('answers 404 for another account space and for a missing space', async () => {
    insertSpace(SPACE_A, OTHER)

    for (const spaceId of [SPACE_A, MISSING_SPACE]) {
      const response = await request(`?spaceId=${spaceId}`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: { code: 'not_found', message: 'Space not found' },
      })
    }
  })
})
