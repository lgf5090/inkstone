// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMOS_SCHEMA_STATEMENTS } from '../src/worker/memos/schema'
import {
  MEMO_SPACE_DESCRIPTION_MAX_LENGTH,
  MEMO_SPACE_ICON_MAX_LENGTH,
  MEMO_SPACE_TITLE_MAX_LENGTH,
  createSpace,
  deleteSpace,
  listSpaces,
  patchSpace,
  spaceBelongsToUser,
} from '../src/worker/memos/spaces'
import { memoSpaceRoutes } from '../src/worker/routes/memos/spaces'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const SPACE_A = 'a'.repeat(26)
const SPACE_B = 'b'.repeat(26)
const SPACE_OTHER = 'c'.repeat(26)
const ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{26}$/
const DEFERRED_DELETE_MESSAGE = 'Deleting a space together with its memos is not available yet. Use mode=unfile first'

const mocks = vi.hoisted(() => ({ userId: '' }))
const ids = vi.hoisted(() => ({ plan: [] as string[] }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    if (!mocks.userId) {
      throw new (await import('../src/worker/lib/errors')).ApiError(401, 'unauthenticated', 'Please sign in first')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

vi.mock('../src/worker/lib/id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/worker/lib/id')>()
  return { ...actual, newId: () => ids.plan.shift() ?? actual.newId() }
})

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/memos/spaces', memoSpaceRoutes)

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

function insertSpace(id: string, userId: string, title: string, createdAt = 100): void {
  sqlite.prepare(
    `INSERT INTO memos_spaces (id, user_id, title, description, icon, created_at, updated_at)
     VALUES (?, ?, ?, '', '', ?, ?)`,
  ).run(id, userId, title, createdAt, createdAt)
}

function insertMemo(
  id: string,
  userId: string,
  spaceId: string | null,
  parentId: string | null = null,
  updatedAt = 100,
): void {
  sqlite.prepare(
    `INSERT INTO memos_items (
       id, user_id, space_id, parent_id, content, content_search, title, snippet,
       visibility, state, pinned, has_link, has_code, has_task_list, has_incomplete_tasks,
       has_location, rev, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '', '', '', '', 'private', 'normal', 0, 0, 0, 0, 0, 0, 1, ?, ?)`,
  ).run(id, userId, spaceId, parentId, updatedAt, updatedAt)
}

function countSpaces(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM memos_spaces').get() as { count: number }).count
}

async function expectApiError(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, message })
}

async function request(suffix = '', init: RequestInit = {}, userId = OWNER): Promise<Response> {
  mocks.userId = userId
  return await app.request(
    `/api/memos/spaces${suffix}`,
    init,
    { DB: db } as unknown as AppBindings['Bindings'],
    ctx,
  )
}

function jsonRequest(method: string, suffix: string, body: unknown, userId = OWNER): Promise<Response> {
  return request(suffix, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, userId)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MEMOS_SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  mocks.userId = OWNER
  ids.plan.length = 0
})

describe('space store', () => {
  it('lists only the caller spaces, oldest first, counting top-level memos', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertSpace(SPACE_B, OWNER, 'Home', 200)
    insertSpace(SPACE_OTHER, OTHER, 'Theirs', 50)
    insertMemo('m1', OWNER, SPACE_A, null, 300)
    insertMemo('m2', OWNER, SPACE_A, null, 300)
    insertMemo('c1', OWNER, SPACE_A, 'm1', 300)
    insertMemo('m3', OTHER, SPACE_A, null, 300)
    insertMemo('m4', OWNER, SPACE_OTHER, null, 300)

    await expect(listSpaces(db, OWNER)).resolves.toEqual([
      { id: SPACE_A, title: 'Work', description: '', icon: '', memoCount: 2, createdAt: 100, updatedAt: 100 },
      { id: SPACE_B, title: 'Home', description: '', icon: '', memoCount: 0, createdAt: 200, updatedAt: 200 },
    ])
  })

  it('creates a trimmed space with a fresh 26-character id and second timestamps', async () => {
    const before = Math.floor(Date.now() / 1000)
    const space = await createSpace(db, OWNER, {
      title: '  Travel  ',
      description: '  Trips  ',
      icon: ' plane ',
    })

    expect(space.id).toMatch(ID_SHAPE)
    expect(space).toMatchObject({ title: 'Travel', description: 'Trips', icon: 'plane', memoCount: 0 })
    expect(space.createdAt).toBe(space.updatedAt)
    expect(space.createdAt).toBeGreaterThanOrEqual(before)
    expect(space.createdAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect(sqlite.prepare('SELECT user_id, title, description, icon FROM memos_spaces WHERE id = ?').get(space.id))
      .toEqual({ user_id: OWNER, title: 'Travel', description: 'Trips', icon: 'plane' })
  })

  it('defaults an omitted description and icon to empty strings', async () => {
    const space = await createSpace(db, OWNER, { title: 'Work' })
    expect(space).toMatchObject({ description: '', icon: '', memoCount: 0 })
  })

  it('refuses a missing, blank or oversized title', async () => {
    await expectApiError(createSpace(db, OWNER, {}), 400, 'Space title is required')
    await expectApiError(createSpace(db, OWNER, { title: null }), 400, 'Space title is required')
    await expectApiError(createSpace(db, OWNER, { title: '   ' }), 400, 'Space title cannot be empty')
    await expectApiError(createSpace(db, OWNER, { title: 42 }), 400, 'Space title must be a string')
    await expectApiError(
      createSpace(db, OWNER, { title: 'x'.repeat(MEMO_SPACE_TITLE_MAX_LENGTH + 1) }),
      400,
      `Space title cannot exceed ${MEMO_SPACE_TITLE_MAX_LENGTH} characters`,
    )
    expect(countSpaces()).toBe(0)
  })

  it('bounds the description and icon', async () => {
    const title = 'Work'
    await expectApiError(
      createSpace(db, OWNER, { title, description: 'd'.repeat(MEMO_SPACE_DESCRIPTION_MAX_LENGTH + 1) }),
      400,
      `Space description cannot exceed ${MEMO_SPACE_DESCRIPTION_MAX_LENGTH} characters`,
    )
    await expectApiError(
      createSpace(db, OWNER, { title, icon: 'i'.repeat(MEMO_SPACE_ICON_MAX_LENGTH + 1) }),
      400,
      `Space icon cannot exceed ${MEMO_SPACE_ICON_MAX_LENGTH} characters`,
    )
    await expectApiError(createSpace(db, OWNER, { title, icon: 7 }), 400, 'Space icon must be a string')
    expect(countSpaces()).toBe(0)
  })

  it('accepts values exactly at each bound', async () => {
    const space = await createSpace(db, OWNER, {
      title: 't'.repeat(MEMO_SPACE_TITLE_MAX_LENGTH),
      description: 'd'.repeat(MEMO_SPACE_DESCRIPTION_MAX_LENGTH),
      icon: 'i'.repeat(MEMO_SPACE_ICON_MAX_LENGTH),
    })
    expect(space.title).toHaveLength(MEMO_SPACE_TITLE_MAX_LENGTH)
    expect(space.description).toHaveLength(MEMO_SPACE_DESCRIPTION_MAX_LENGTH)
    expect(space.icon).toHaveLength(MEMO_SPACE_ICON_MAX_LENGTH)
  })

  it('patches the three editable fields of an owned space', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertMemo('m1', OWNER, SPACE_A, null, 100)
    insertMemo('c1', OWNER, SPACE_A, 'm1', 100)

    const space = await patchSpace(db, OWNER, SPACE_A, {
      title: ' Job ',
      description: ' Paid ',
      icon: 'briefcase',
    })

    expect(space).toMatchObject({
      id: SPACE_A,
      title: 'Job',
      description: 'Paid',
      icon: 'briefcase',
      memoCount: 1,
      createdAt: 100,
    })
    expect(space!.updatedAt).toBeGreaterThan(100)
    expect(sqlite.prepare('SELECT title, description, icon, updated_at FROM memos_spaces WHERE id = ?').get(SPACE_A))
      .toEqual({ title: 'Job', description: 'Paid', icon: 'briefcase', updated_at: space!.updatedAt })
  })

  it('leaves the space untouched when the patch names no editable field', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    await expect(patchSpace(db, OWNER, SPACE_A, {})).resolves.toMatchObject({
      id: SPACE_A,
      title: 'Work',
      createdAt: 100,
      updatedAt: 100,
    })
  })

  it('cannot patch another account space', async () => {
    insertSpace(SPACE_A, OTHER, 'Theirs', 100)
    await expect(patchSpace(db, OWNER, SPACE_A, { title: 'Mine' })).resolves.toBeNull()
    expect(sqlite.prepare('SELECT title FROM memos_spaces WHERE id = ?').get(SPACE_A)).toEqual({ title: 'Theirs' })
  })

  it('refuses an empty title or oversized icon on patch', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    await expectApiError(patchSpace(db, OWNER, SPACE_A, { title: ' ' }), 400, 'Space title cannot be empty')
    await expectApiError(
      patchSpace(db, OWNER, SPACE_A, { icon: 'i'.repeat(MEMO_SPACE_ICON_MAX_LENGTH + 1) }),
      400,
      `Space icon cannot exceed ${MEMO_SPACE_ICON_MAX_LENGTH} characters`,
    )
    expect(sqlite.prepare('SELECT title, icon FROM memos_spaces WHERE id = ?').get(SPACE_A))
      .toEqual({ title: 'Work', icon: '' })
  })

  it('answers ownership for memo validation', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    await expect(spaceBelongsToUser(db, OWNER, SPACE_A)).resolves.toBe(true)
    await expect(spaceBelongsToUser(db, OTHER, SPACE_A)).resolves.toBe(false)
    await expect(spaceBelongsToUser(db, OWNER, SPACE_B)).resolves.toBe(false)
  })

  it('unfiles the caller memos, including comments, before deleting the space', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertSpace(SPACE_OTHER, OTHER, 'Theirs', 100)
    insertMemo('m1', OWNER, SPACE_A, null, 100)
    insertMemo('c1', OWNER, SPACE_A, 'm1', 100)
    insertMemo('m2', OTHER, SPACE_A, null, 100)

    await expect(deleteSpace(db, OWNER, SPACE_A, 'unfile')).resolves.toBe(true)

    expect(sqlite.prepare('SELECT id FROM memos_spaces').all()).toEqual([{ id: SPACE_OTHER }])
    const rows = sqlite.prepare('SELECT id, user_id, space_id, updated_at FROM memos_items ORDER BY id').all() as Array<{
      id: string
      user_id: string
      space_id: string | null
      updated_at: number
    }>
    expect(rows.map((row) => ({ id: row.id, space_id: row.space_id }))).toEqual([
      { id: 'c1', space_id: null },
      { id: 'm1', space_id: null },
      { id: 'm2', space_id: SPACE_A },
    ])
    for (const row of rows.filter((entry) => entry.user_id === OWNER)) {
      expect(row.updated_at).toBeGreaterThan(100)
    }
    await expect(deleteSpace(db, OWNER, SPACE_A, 'unfile')).resolves.toBe(false)
  })

  it('cannot delete another account space', async () => {
    insertSpace(SPACE_A, OTHER, 'Theirs', 100)
    insertMemo('m1', OTHER, SPACE_A, null, 100)

    await expect(deleteSpace(db, OWNER, SPACE_A, 'unfile')).resolves.toBe(false)

    expect(sqlite.prepare('SELECT id FROM memos_spaces').all()).toEqual([{ id: SPACE_A }])
    expect(sqlite.prepare('SELECT space_id FROM memos_items WHERE id = ?').get('m1')).toEqual({ space_id: SPACE_A })
  })

  it('refuses mode=delete instead of cascading memos', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertMemo('m1', OWNER, SPACE_A, null, 100)

    await expectApiError(deleteSpace(db, OWNER, SPACE_A, 'delete'), 409, DEFERRED_DELETE_MESSAGE)

    expect(sqlite.prepare('SELECT id FROM memos_spaces').all()).toEqual([{ id: SPACE_A }])
    expect(sqlite.prepare('SELECT space_id FROM memos_items WHERE id = ?').get('m1')).toEqual({ space_id: SPACE_A })
  })

  it('retries when the generated id is taken by another account', async () => {
    insertSpace(SPACE_A, OTHER, 'Theirs', 100)
    ids.plan.push(SPACE_A, SPACE_B)

    const space = await createSpace(db, OWNER, { title: 'Mine' })

    expect(space.id).toBe(SPACE_B)
    expect(countSpaces()).toBe(2)
  })

  it('gives up with a conflict when every generated id is taken', async () => {
    insertSpace(SPACE_A, OTHER, 'Theirs', 100)
    ids.plan.push(...Array.from({ length: 10 }, () => SPACE_A))

    await expectApiError(createSpace(db, OWNER, { title: 'Mine' }), 409, 'Could not allocate a space id. Try again')

    expect(countSpaces()).toBe(1)
  })
})

describe('space routes', () => {
  it('refuses every space request without a session', async () => {
    const list = await request('', {}, '')
    expect(list.status).toBe(401)
    expect(await list.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })

    const create = await jsonRequest('POST', '', { title: 'Work' }, '')
    expect(create.status).toBe(401)
  })

  it('returns the caller spaces with memo counts', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertSpace(SPACE_OTHER, OTHER, 'Theirs', 50)
    insertMemo('m1', OWNER, SPACE_A, null, 300)
    insertMemo('c1', OWNER, SPACE_A, 'm1', 300)

    const response = await request()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      spaces: [
        { id: SPACE_A, title: 'Work', description: '', icon: '', memoCount: 1, createdAt: 100, updatedAt: 100 },
      ],
    })
  })

  it('creates a space and answers 201', async () => {
    const response = await jsonRequest('POST', '', { title: 'Work', description: 'Notes', icon: 'briefcase' })

    expect(response.status).toBe(201)
    const body = await response.json() as { id: string; title: string; description: string; icon: string; memoCount: number }
    expect(body.id).toMatch(ID_SHAPE)
    expect(body).toMatchObject({ title: 'Work', description: 'Notes', icon: 'briefcase', memoCount: 0 })
  })

  it('refuses a blank title and an oversized icon with 400', async () => {
    const blank = await jsonRequest('POST', '', { title: '  ' })
    expect(blank.status).toBe(400)
    expect(await blank.json()).toEqual({
      error: { code: 'bad_request', message: 'Space title cannot be empty' },
    })

    const oversized = await jsonRequest('POST', '', {
      title: 'Work',
      icon: 'i'.repeat(MEMO_SPACE_ICON_MAX_LENGTH + 1),
    })
    expect(oversized.status).toBe(400)
    expect((await oversized.json() as { error: { code: string } }).error.code).toBe('bad_request')
  })

  it('patches an owned space and hides another account space', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertSpace(SPACE_OTHER, OTHER, 'Theirs', 100)

    const updated = await jsonRequest('PATCH', `/${SPACE_A}`, { title: 'Renamed', id: SPACE_B })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ id: SPACE_A, title: 'Renamed', createdAt: 100 })

    const hidden = await jsonRequest('PATCH', `/${SPACE_OTHER}`, { title: 'Mine' })
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ error: { code: 'not_found', message: 'Space not found' } })
    expect(sqlite.prepare('SELECT title FROM memos_spaces WHERE id = ?').get(SPACE_OTHER))
      .toEqual({ title: 'Theirs' })
  })

  it('deletes with unfile by default and moves memos out', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertMemo('m1', OWNER, SPACE_A, null, 100)

    const response = await request(`/${SPACE_A}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(sqlite.prepare('SELECT id FROM memos_spaces').all()).toEqual([])
    expect(sqlite.prepare('SELECT space_id FROM memos_items WHERE id = ?').get('m1')).toEqual({ space_id: null })
  })

  it('cannot delete another account space', async () => {
    insertSpace(SPACE_OTHER, OTHER, 'Theirs', 100)

    const response = await request(`/${SPACE_OTHER}?mode=unfile`, { method: 'DELETE' })

    expect(response.status).toBe(404)
    expect(sqlite.prepare('SELECT id FROM memos_spaces').all()).toEqual([{ id: SPACE_OTHER }])
  })

  it('refuses mode=delete with a conflict until memos can be deleted with the space', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)
    insertMemo('m1', OWNER, SPACE_A, null, 100)

    const response = await request(`/${SPACE_A}?mode=delete`, { method: 'DELETE' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: 'conflict', message: DEFERRED_DELETE_MESSAGE },
    })
    expect(sqlite.prepare('SELECT id FROM memos_spaces').all()).toEqual([{ id: SPACE_A }])
    expect(sqlite.prepare('SELECT space_id FROM memos_items WHERE id = ?').get('m1')).toEqual({ space_id: SPACE_A })
  })

  it('refuses an unknown delete mode with 400', async () => {
    insertSpace(SPACE_A, OWNER, 'Work', 100)

    const response = await request(`/${SPACE_A}?mode=purge`, { method: 'DELETE' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'bad_request', message: 'mode must be unfile or delete' },
    })
    expect(sqlite.prepare('SELECT id FROM memos_spaces').all()).toEqual([{ id: SPACE_A }])
  })
})
