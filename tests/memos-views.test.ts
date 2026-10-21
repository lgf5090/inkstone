// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMO_FILTER_MAX_BYTES } from '../src/shared/memos/constants'
import { MEMOS_SCHEMA_STATEMENTS } from '../src/worker/memos/schema'
import {
  MEMO_VIEW_ICON_MAX_LENGTH,
  MEMO_VIEW_TITLE_MAX_LENGTH,
  createView,
  deleteView,
  listViews,
  patchView,
  validateViewFilter,
} from '../src/worker/memos/views'
import { memoViewRoutes } from '../src/worker/routes/memos/views'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const VIEW_A = 'a'.repeat(26)
const VIEW_B = 'b'.repeat(26)
const VIEW_OTHER = 'c'.repeat(26)
const ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{26}$/
const VALID_FILTER = 'visibility == "public"'
const TRUNCATED_FILTER = 'content =='
const TRUNCATED_POSITION = 10
const UNKNOWN_FIELD_FILTER = 'unknown_field == "x"'
const OVERSIZED_FILTER = 'a'.repeat(MEMO_FILTER_MAX_BYTES + 1)
const OVERSIZED_MESSAGE = `expression is longer than ${MEMO_FILTER_MAX_BYTES} bytes`
const ID_CONFLICT_MESSAGE = 'Could not allocate a view id. Try again'

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
app.route('/api/memos/views', memoViewRoutes)

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

function insertView(
  id: string,
  userId: string,
  title: string,
  filter: string,
  icon = '',
  createdAt = 100,
): void {
  sqlite.prepare(
    `INSERT INTO memos_views (id, user_id, title, filter, icon, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, title, filter, icon, createdAt, createdAt)
}

function countViews(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM memos_views').get() as { count: number }).count
}

async function expectApiError(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, message })
}

async function request(suffix = '', init: RequestInit = {}, userId = OWNER): Promise<Response> {
  mocks.userId = userId
  return await app.request(
    `/api/memos/views${suffix}`,
    init,
    testBindings(db),
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

describe('view store', () => {
  it('lists only the caller views, oldest first', async () => {
    insertView(VIEW_A, OWNER, 'Reading', VALID_FILTER, 'book', 200)
    insertView(VIEW_B, OWNER, 'Tasks', 'pinned == true', '', 100)
    insertView(VIEW_OTHER, OTHER, 'Theirs', VALID_FILTER, '', 50)

    await expect(listViews(db, OWNER)).resolves.toEqual([
      { id: VIEW_B, title: 'Tasks', filter: 'pinned == true', icon: '', createdAt: 100, updatedAt: 100 },
      { id: VIEW_A, title: 'Reading', filter: VALID_FILTER, icon: 'book', createdAt: 200, updatedAt: 200 },
    ])
  })

  it('creates a view with a trimmed title and icon, a fresh 26-character id and second timestamps', async () => {
    const before = Math.floor(Date.now() / 1000)
    const view = await createView(db, OWNER, {
      title: '  Reading  ',
      filter: ` ${VALID_FILTER} `,
      icon: ' book ',
    })

    expect(view.id).toMatch(ID_SHAPE)
    expect(view).toMatchObject({ title: 'Reading', filter: ` ${VALID_FILTER} `, icon: 'book' })
    expect(view.createdAt).toBe(view.updatedAt)
    expect(view.createdAt).toBeGreaterThanOrEqual(before)
    expect(view.createdAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect(sqlite.prepare('SELECT user_id, title, filter, icon FROM memos_views WHERE id = ?').get(view.id))
      .toEqual({ user_id: OWNER, title: 'Reading', filter: ` ${VALID_FILTER} `, icon: 'book' })
  })

  it('defaults an omitted icon to an empty string', async () => {
    const view = await createView(db, OWNER, { title: 'Reading', filter: VALID_FILTER })
    expect(view.icon).toBe('')
  })

  it('refuses a missing, blank or oversized title', async () => {
    await expectApiError(createView(db, OWNER, { filter: VALID_FILTER }), 400, 'View title is required')
    await expectApiError(createView(db, OWNER, { title: null, filter: VALID_FILTER }), 400, 'View title is required')
    await expectApiError(createView(db, OWNER, { title: '   ', filter: VALID_FILTER }), 400, 'View title cannot be empty')
    await expectApiError(createView(db, OWNER, { title: 42, filter: VALID_FILTER }), 400, 'View title must be a string')
    await expectApiError(
      createView(db, OWNER, { title: 'x'.repeat(MEMO_VIEW_TITLE_MAX_LENGTH + 1), filter: VALID_FILTER }),
      400,
      `View title cannot exceed ${MEMO_VIEW_TITLE_MAX_LENGTH} characters`,
    )
    expect(countViews()).toBe(0)
  })

  it('requires the filter and refuses a non-string or blank one', async () => {
    await expectApiError(createView(db, OWNER, { title: 'Reading' }), 400, 'View filter is required')
    await expectApiError(createView(db, OWNER, { title: 'Reading', filter: null }), 400, 'View filter is required')
    await expectApiError(createView(db, OWNER, { title: 'Reading', filter: '   ' }), 400, 'View filter is required')
    await expectApiError(createView(db, OWNER, { title: 'Reading', filter: 42 }), 400, 'View filter must be a string')
    expect(countViews()).toBe(0)
  })

  it('answers the validator message and position for an invalid filter', async () => {
    await expect(createView(db, OWNER, { title: 'Reading', filter: TRUNCATED_FILTER })).rejects.toMatchObject({
      status: 400,
      message: 'unexpected end of expression',
      details: { position: TRUNCATED_POSITION },
    })
    await expect(createView(db, OWNER, { title: 'Reading', filter: UNKNOWN_FIELD_FILTER })).rejects.toMatchObject({
      status: 400,
      message: 'unknown field "unknown_field"',
      details: { position: 0 },
    })
    await expect(createView(db, OWNER, { title: 'Reading', filter: OVERSIZED_FILTER })).rejects.toMatchObject({
      status: 400,
      message: OVERSIZED_MESSAGE,
      details: { position: 0 },
    })
    expect(countViews()).toBe(0)
  })

  it('bounds the icon', async () => {
    await expectApiError(createView(db, OWNER, { title: 'Reading', filter: VALID_FILTER, icon: 7 }), 400, 'View icon must be a string')
    await expectApiError(
      createView(db, OWNER, {
        title: 'Reading',
        filter: VALID_FILTER,
        icon: 'i'.repeat(MEMO_VIEW_ICON_MAX_LENGTH + 1),
      }),
      400,
      `View icon cannot exceed ${MEMO_VIEW_ICON_MAX_LENGTH} characters`,
    )
    expect(countViews()).toBe(0)
  })

  it('accepts values exactly at each bound', async () => {
    const view = await createView(db, OWNER, {
      title: 't'.repeat(MEMO_VIEW_TITLE_MAX_LENGTH),
      filter: VALID_FILTER,
      icon: 'i'.repeat(MEMO_VIEW_ICON_MAX_LENGTH),
    })
    expect(view.title).toHaveLength(MEMO_VIEW_TITLE_MAX_LENGTH)
    expect(view.icon).toHaveLength(MEMO_VIEW_ICON_MAX_LENGTH)
  })

  it('patches the three editable fields of an owned view', async () => {
    insertView(VIEW_A, OWNER, 'Work', VALID_FILTER, '', 100)

    const view = await patchView(db, OWNER, VIEW_A, {
      title: ' Job ',
      filter: 'pinned == true',
      icon: 'briefcase',
    })

    expect(view).toMatchObject({
      id: VIEW_A,
      title: 'Job',
      filter: 'pinned == true',
      icon: 'briefcase',
      createdAt: 100,
    })
    expect(view!.updatedAt).toBeGreaterThan(100)
    expect(sqlite.prepare('SELECT title, filter, icon, updated_at FROM memos_views WHERE id = ?').get(VIEW_A))
      .toEqual({ title: 'Job', filter: 'pinned == true', icon: 'briefcase', updated_at: view!.updatedAt })
  })

  it('leaves the view untouched when the patch names no editable field', async () => {
    insertView(VIEW_A, OWNER, 'Work', VALID_FILTER, 'book', 100)
    await expect(patchView(db, OWNER, VIEW_A, {})).resolves.toMatchObject({
      id: VIEW_A,
      title: 'Work',
      filter: VALID_FILTER,
      icon: 'book',
      createdAt: 100,
      updatedAt: 100,
    })
  })

  it('re-validates a patched filter and refuses an empty title or oversized icon', async () => {
    insertView(VIEW_A, OWNER, 'Work', VALID_FILTER, '', 100)

    await expect(patchView(db, OWNER, VIEW_A, { filter: TRUNCATED_FILTER })).rejects.toMatchObject({
      status: 400,
      message: 'unexpected end of expression',
      details: { position: TRUNCATED_POSITION },
    })
    await expectApiError(patchView(db, OWNER, VIEW_A, { title: ' ' }), 400, 'View title cannot be empty')
    await expectApiError(
      patchView(db, OWNER, VIEW_A, { icon: 'i'.repeat(MEMO_VIEW_ICON_MAX_LENGTH + 1) }),
      400,
      `View icon cannot exceed ${MEMO_VIEW_ICON_MAX_LENGTH} characters`,
    )
    expect(sqlite.prepare('SELECT title, filter, icon FROM memos_views WHERE id = ?').get(VIEW_A))
      .toEqual({ title: 'Work', filter: VALID_FILTER, icon: '' })
  })

  it('cannot patch another account view', async () => {
    insertView(VIEW_OTHER, OTHER, 'Theirs', VALID_FILTER, '', 100)
    await expect(patchView(db, OWNER, VIEW_OTHER, { title: 'Mine' })).resolves.toBeNull()
    expect(sqlite.prepare('SELECT title FROM memos_views WHERE id = ?').get(VIEW_OTHER)).toEqual({ title: 'Theirs' })
  })

  it('deletes only an owned view', async () => {
    insertView(VIEW_A, OWNER, 'Work', VALID_FILTER, '', 100)
    insertView(VIEW_OTHER, OTHER, 'Theirs', VALID_FILTER, '', 100)

    await expect(deleteView(db, OWNER, VIEW_A)).resolves.toBe(true)
    await expect(deleteView(db, OWNER, VIEW_A)).resolves.toBe(false)
    await expect(deleteView(db, OWNER, VIEW_OTHER)).resolves.toBe(false)

    expect(sqlite.prepare('SELECT id FROM memos_views ORDER BY id').all()).toEqual([{ id: VIEW_OTHER }])
  })

  it('retries when the generated id is taken by another account', async () => {
    insertView(VIEW_A, OTHER, 'Theirs', VALID_FILTER, '', 100)
    ids.plan.push(VIEW_A, VIEW_B)

    const view = await createView(db, OWNER, { title: 'Mine', filter: VALID_FILTER })

    expect(view.id).toBe(VIEW_B)
    expect(countViews()).toBe(2)
  })

  it('gives up with a conflict when every generated id is taken', async () => {
    insertView(VIEW_A, OTHER, 'Theirs', VALID_FILTER, '', 100)
    ids.plan.push(...Array.from({ length: 10 }, () => VIEW_A))

    await expectApiError(
      createView(db, OWNER, { title: 'Mine', filter: VALID_FILTER }),
      409,
      ID_CONFLICT_MESSAGE,
    )

    expect(countViews()).toBe(1)
  })
})

describe('view filter validation', () => {
  it('accepts a valid expression', () => {
    expect(validateViewFilter(VALID_FILTER)).toEqual({ ok: true })
  })

  it('answers the position of an unknown field', () => {
    expect(validateViewFilter(UNKNOWN_FIELD_FILTER)).toEqual({
      ok: false,
      error: { message: 'unknown field "unknown_field"', position: 0 },
    })
  })

  it('answers the end position of a truncated expression', () => {
    expect(validateViewFilter(TRUNCATED_FILTER)).toEqual({
      ok: false,
      error: { message: 'unexpected end of expression', position: TRUNCATED_POSITION },
    })
  })

  it('refuses a non-boolean expression', () => {
    expect(validateViewFilter('content')).toEqual({
      ok: false,
      error: { message: 'expression must evaluate to a boolean', position: 0 },
    })
  })

  it('refuses an expression longer than the byte ceiling', () => {
    expect(validateViewFilter(OVERSIZED_FILTER)).toEqual({
      ok: false,
      error: { message: OVERSIZED_MESSAGE, position: 0 },
    })
  })

  it('requires a non-empty string', () => {
    expect(validateViewFilter(undefined)).toEqual({
      ok: false,
      error: { message: 'View filter is required', position: null },
    })
    expect(validateViewFilter('   ')).toEqual({
      ok: false,
      error: { message: 'View filter is required', position: null },
    })
    expect(validateViewFilter(42)).toEqual({
      ok: false,
      error: { message: 'View filter must be a string', position: null },
    })
  })
})

describe('view routes', () => {
  it('refuses every view request without a session', async () => {
    const list = await request('', {}, '')
    expect(list.status).toBe(401)
    expect(await list.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })

    for (const [method, suffix] of [
      ['POST', ''],
      ['POST', '/validate'],
      ['PATCH', `/${VIEW_A}`],
      ['DELETE', `/${VIEW_A}`],
    ] as const) {
      const response = await jsonRequest(method, suffix, { filter: VALID_FILTER }, '')
      expect(response.status).toBe(401)
    }
  })

  it('returns the caller views with their filters', async () => {
    insertView(VIEW_A, OWNER, 'Reading', VALID_FILTER, 'book', 100)
    insertView(VIEW_OTHER, OTHER, 'Theirs', 'pinned == true', '', 50)

    const response = await request()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      views: [
        { id: VIEW_A, title: 'Reading', filter: VALID_FILTER, icon: 'book', createdAt: 100, updatedAt: 100 },
      ],
    })
  })

  it('creates a view and answers 201', async () => {
    const response = await jsonRequest('POST', '', {
      title: 'Reading',
      filter: VALID_FILTER,
      icon: 'book',
    })

    expect(response.status).toBe(201)
    const body = await response.json() as { id: string; title: string; filter: string; icon: string }
    expect(body.id).toMatch(ID_SHAPE)
    expect(body).toMatchObject({ title: 'Reading', filter: VALID_FILTER, icon: 'book' })
    expect(countViews()).toBe(1)
  })

  it('refuses a blank title, an invalid filter and an oversized icon with 400', async () => {
    const blank = await jsonRequest('POST', '', { title: '  ', filter: VALID_FILTER })
    expect(blank.status).toBe(400)
    expect(await blank.json()).toEqual({
      error: { code: 'bad_request', message: 'View title cannot be empty' },
    })

    const invalid = await jsonRequest('POST', '', { title: 'Reading', filter: TRUNCATED_FILTER })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      error: {
        code: 'bad_request',
        message: 'unexpected end of expression',
        details: { position: TRUNCATED_POSITION },
      },
    })

    const oversized = await jsonRequest('POST', '', {
      title: 'Reading',
      filter: VALID_FILTER,
      icon: 'i'.repeat(MEMO_VIEW_ICON_MAX_LENGTH + 1),
    })
    expect(oversized.status).toBe(400)
    expect((await oversized.json() as { error: { code: string } }).error.code).toBe('bad_request')
    expect(countViews()).toBe(0)
  })

  it('patches an owned view and hides another account view', async () => {
    insertView(VIEW_A, OWNER, 'Reading', VALID_FILTER, '', 100)
    insertView(VIEW_OTHER, OTHER, 'Theirs', VALID_FILTER, '', 100)

    const updated = await jsonRequest('PATCH', `/${VIEW_A}`, {
      title: 'Renamed',
      filter: 'pinned == true',
      icon: 'book',
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      id: VIEW_A,
      title: 'Renamed',
      filter: 'pinned == true',
      icon: 'book',
      createdAt: 100,
    })

    const hidden = await jsonRequest('PATCH', `/${VIEW_OTHER}`, { title: 'Mine' })
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ error: { code: 'not_found', message: 'View not found' } })
    expect(sqlite.prepare('SELECT title FROM memos_views WHERE id = ?').get(VIEW_OTHER))
      .toEqual({ title: 'Theirs' })

    const unknown = await jsonRequest('PATCH', `/${VIEW_B}`, { title: 'Mine' })
    expect(unknown.status).toBe(404)
  })

  it('deletes an owned view and reports another account view as missing', async () => {
    insertView(VIEW_A, OWNER, 'Reading', VALID_FILTER, '', 100)
    insertView(VIEW_OTHER, OTHER, 'Theirs', VALID_FILTER, '', 100)

    const deleted = await request(`/${VIEW_A}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    expect(sqlite.prepare('SELECT id FROM memos_views WHERE id = ?').get(VIEW_A)).toBeUndefined()

    const hidden = await request(`/${VIEW_OTHER}`, { method: 'DELETE' })
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ error: { code: 'not_found', message: 'View not found' } })
    expect(sqlite.prepare('SELECT id FROM memos_views').all()).toEqual([{ id: VIEW_OTHER }])

    const missing = await request(`/${VIEW_B}`, { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })

  it('validates a filter without writing a view', async () => {
    const valid = await jsonRequest('POST', '/validate', { filter: VALID_FILTER })
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ ok: true })

    const invalid = await jsonRequest('POST', '/validate', { filter: UNKNOWN_FIELD_FILTER })
    expect(invalid.status).toBe(200)
    expect(await invalid.json()).toEqual({
      ok: false,
      error: { message: 'unknown field "unknown_field"', position: 0 },
    })

    const missing = await jsonRequest('POST', '/validate', {})
    expect(missing.status).toBe(200)
    expect(await missing.json()).toEqual({
      ok: false,
      error: { message: 'View filter is required', position: null },
    })

    expect(countViews()).toBe(0)
  })

  it('reports an oversized filter through the validate route', async () => {
    const response = await jsonRequest('POST', '/validate', { filter: OVERSIZED_FILTER })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: false,
      error: { message: OVERSIZED_MESSAGE, position: 0 },
    })
  })

  it('refuses a non-object validate body with 400', async () => {
    const response = await jsonRequest('POST', '/validate', [VALID_FILTER])

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'bad_request', message: 'The request body must be a JSON object' },
    })
  })
})
