// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { officeContentRoutes } from '../src/worker/routes/office-content'
import { officeHistoryRoutes } from '../src/worker/routes/office-history'
import { officeRoutes } from '../src/worker/routes/office'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

/**
 * The history protocol the official panel reads.
 *
 * The panel is a client of a wire shape, not of our store: `error.code` has to be `ErrorCode.OK` (1),
 * versions arrive as `historyIds` + `entities.datas`, and the creator comes from `entities.users`.
 * These tests assert that shape, the ownership rule, and the one deliberate gap: no changesets.
 */

const USER = 'user-alpha'
const OTHER = 'user-beta'

interface HistoryVersionJson {
  unitId: string
  userId: string
  userIds: string[]
  startRevision: number
  endRevision: number
  createTime: number
  command: string[]
}

interface HistoryListJson {
  error: { code: number }
  hasMore: boolean
  lastLabel: string
  historyIds: string[]
  entities: {
    datas: Record<string, HistoryVersionJson>
    users: Record<string, { name: string; avatar: string; anonymous: boolean }>
  }
}

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    c.set('user', {
      id: mocks.userId,
      username: mocks.userId,
      login: mocks.userId,
      name: mocks.userId,
      avatarUrl: '',
      role: 'owner',
      createdAt: 0,
      settingsRaw: '{}',
    })
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/universer-api/history', officeHistoryRoutes)
  instance.route('/api/office', officeContentRoutes)
  instance.route('/api/office', officeRoutes)
  return instance
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app().request(`http://localhost${path}`, init, env)
}

async function createFile(title: string): Promise<string> {
  const response = await request('/api/office/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'sheets', title }),
  })
  expect(response.status).toBe(201)
  const body = await response.json() as { file: { id: string } }
  return body.file.id
}

async function save(fileId: string, baseRev: number): Promise<void> {
  const response = await request(`/api/office/files/${fileId}/snapshot`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev, snapshot: { sheets: {}, sheetOrder: [] } }),
  })
  expect(response.status).toBe(200)
}

async function list(fileId: string, query = ''): Promise<HistoryListJson> {
  const response = await request(`/universer-api/history/${fileId}/list${query}`)
  expect(response.status).toBe(200)
  return await response.json() as HistoryListJson
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  mocks.userId = USER
})

describe('office history protocol', () => {
  it('lists saved revisions newest first with the protocol envelope', async () => {
    const fileId = await createFile('History sheet')
    await save(fileId, 0)
    await save(fileId, 1)

    const body = await list(fileId)
    expect(body.error.code).toBe(1)
    expect(body.hasMore).toBe(false)
    expect(body.historyIds).toEqual(['rev-2', 'rev-1'])

    const newest = body.entities.datas['rev-2']
    expect(newest).toMatchObject({
      unitId: fileId,
      userId: USER,
      userIds: [USER],
      startRevision: 2,
      endRevision: 2,
      command: [],
    })
    expect(newest?.createTime).toBeGreaterThan(0)
    expect(body.entities.users[USER]).toEqual({ name: USER, avatar: '', anonymous: false })
    expect(body.lastLabel).toBe('1')
  })

  it('pages backwards from the oldest revision it returned', async () => {
    const fileId = await createFile('Paged sheet')
    await save(fileId, 0)
    await save(fileId, 1)
    await save(fileId, 2)

    const first = await list(fileId, '?length=2')
    expect(first.historyIds).toEqual(['rev-3', 'rev-2'])
    expect(first.hasMore).toBe(true)
    expect(first.lastLabel).toBe('2')

    const second = await list(fileId, `?length=2&lastLabel=${first.lastLabel}`)
    expect(second.historyIds).toEqual(['rev-1'])
    expect(second.hasMore).toBe(false)
  })

  it('answers 404 for another account and for an unknown unit', async () => {
    const fileId = await createFile('Private sheet')
    await save(fileId, 0)

    mocks.userId = OTHER
    const denied = await request(`/universer-api/history/${fileId}/list`)
    expect(denied.status).toBe(404)

    mocks.userId = USER
    const unknown = await request('/universer-api/history/01m7zzzzzzzzzzzzzzzzzzzzzz/list')
    expect(unknown.status).toBe(404)
  })

  it('reports the account that wrote the revisions as the only creator', async () => {
    const fileId = await createFile('Creator sheet')
    const response = await request(`/universer-api/history/${fileId}/creators`)
    expect(response.status).toBe(200)
    const body = await response.json() as { error: { code: number }; creators: { userId: string; name: string; origins: number[] }[] }
    expect(body.error.code).toBe(1)
    expect(body.creators).toHaveLength(1)
    expect(body.creators[0]).toMatchObject({ userId: USER, name: USER, origins: [1] })
  })

  it('returns an empty changeset range instead of inventing a diff', async () => {
    const fileId = await createFile('Diff sheet')
    await save(fileId, 0)
    await save(fileId, 1)

    const response = await request(`/universer-api/history/${fileId}/cs?startRevision=0&endRevision=2`)
    expect(response.status).toBe(200)
    const body = await response.json() as { error: { code: number }; changesets: unknown[]; users: Record<string, unknown> }
    expect(body.error.code).toBe(1)
    expect(body.changesets).toEqual([])
    expect(body.users).toEqual({})
  })
})
