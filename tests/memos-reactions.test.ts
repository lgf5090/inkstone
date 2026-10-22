// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import {
  MEMO_REACTION_TYPE_MAX_LENGTH,
  deleteMemoReaction,
  listMemoReactions,
  upsertMemoReaction,
} from '../src/worker/memos/reactions'
import { memoReactionRoutes } from '../src/worker/routes/memos/reactions'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const OWNER_NAME = 'Owner'
const OWNER_AVATAR = '/avatars/owner.png'
const OWNER_USER = { id: OWNER, name: OWNER_NAME, avatarUrl: OWNER_AVATAR }
const MEMO = 'a'.repeat(26)
const OTHER_MEMO = 'b'.repeat(26)
const MISSING_MEMO = 'c'.repeat(26)
const SECOND_MEMO = 'd'.repeat(26)

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  db = makeD1(sqlite)
  env = testBindings(db)
  await initializeDatabase(env)
  insertUser(OWNER, OWNER_NAME, OWNER_AVATAR)
  insertUser(OTHER, 'Other', '/avatars/other.png')
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) c.set('userId', userId)
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/memos', memoReactionRoutes)
})

afterEach(() => sqlite.close())

function insertUser(id: string, name: string, avatarUrl: string): void {
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, ?, 'owner', '{}', 1, 1)`,
  ).run(id, `${id}-name`, `${id}-login`, name, avatarUrl)
}

function insertMemo(id: string, userId = OWNER, state: 'normal' | 'archived' = 'normal'): void {
  sqlite.prepare(
    `INSERT INTO memos_items (id, user_id, content, visibility, state, rev, created_at, updated_at)
     VALUES (?, ?, '', 'private', ?, 1, 1, 1)`,
  ).run(id, userId, state)
}

function insertReaction(id: string, userId: string, memoId: string, type: string, createdAt = 1): void {
  sqlite.prepare(
    'INSERT INTO memos_reactions (id, user_id, memo_id, type, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, memoId, type, createdAt)
}

function reactionRows(): Array<{ user_id: string; type: string }> {
  return sqlite
    .prepare('SELECT user_id, type FROM memos_reactions ORDER BY id')
    .all() as Array<{ user_id: string; type: string }>
}

function changeRows(): Array<{ kind: string; memo_id: string | null }> {
  return sqlite
    .prepare('SELECT kind, memo_id FROM memos_changes ORDER BY seq')
    .all() as Array<{ kind: string; memo_id: string | null }>
}

async function expectApiError(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, message })
}

async function request(path: string, init: RequestInit = {}, userId = OWNER): Promise<Response> {
  const headers = new Headers(init.headers)
  if (userId) headers.set('x-test-user', userId)
  return await app.request(`http://localhost/api/memos${path}`, { ...init, headers }, env)
}

function jsonRequest(method: string, path: string, body: unknown, userId = OWNER): Promise<Response> {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, userId)
}

describe('memo reaction store', () => {
  it('groups the caller reactions by type in the order they were added', async () => {
    insertMemo(MEMO)
    insertReaction('r1', OWNER, MEMO, '🎉', 10)
    insertReaction('r2', OWNER, MEMO, '👍', 20)
    insertReaction('r3', OTHER, MEMO, '❤️', 30)

    await expect(listMemoReactions(db, OWNER, MEMO)).resolves.toEqual([
      { type: '🎉', count: 1, reacted: true, users: [OWNER_USER] },
      { type: '👍', count: 1, reacted: true, users: [OWNER_USER] },
    ])
  })

  it('reports a missing memo or another account memo as not found', async () => {
    insertMemo(OTHER_MEMO, OTHER)

    await expectApiError(listMemoReactions(db, OWNER, MISSING_MEMO), 404, 'Memo not found')
    await expectApiError(listMemoReactions(db, OWNER, OTHER_MEMO), 404, 'Memo not found')
  })

  it('upserts idempotently and answers the summary', async () => {
    insertMemo(MEMO)

    const first = await upsertMemoReaction(db, OWNER, MEMO, '👍')
    const second = await upsertMemoReaction(db, OWNER, MEMO, '  👍  ')

    expect(first).toEqual([{ type: '👍', count: 1, reacted: true, users: [OWNER_USER] }])
    expect(second).toEqual(first)
    expect(reactionRows()).toEqual([{ user_id: OWNER, type: '👍' }])

    const both = await upsertMemoReaction(db, OWNER, MEMO, '❤️')
    expect(both.map((reaction) => reaction.type)).toEqual(['👍', '❤️'])
    expect(reactionRows()).toHaveLength(2)
  })

  it('refuses blank, oversized and non-string types', async () => {
    insertMemo(MEMO)

    await expectApiError(upsertMemoReaction(db, OWNER, MEMO, undefined), 400, 'Reaction type is required')
    await expectApiError(upsertMemoReaction(db, OWNER, MEMO, 42), 400, 'Reaction type must be a string')
    await expectApiError(upsertMemoReaction(db, OWNER, MEMO, '   '), 400, 'Reaction type cannot be empty')
    await expectApiError(
      upsertMemoReaction(db, OWNER, MEMO, 'x'.repeat(MEMO_REACTION_TYPE_MAX_LENGTH + 1)),
      400,
      `Reaction type cannot exceed ${MEMO_REACTION_TYPE_MAX_LENGTH} characters`,
    )
    expect(reactionRows()).toEqual([])

    const longest = await upsertMemoReaction(db, OWNER, MEMO, 'x'.repeat(MEMO_REACTION_TYPE_MAX_LENGTH))
    expect(longest[0]?.type).toHaveLength(MEMO_REACTION_TYPE_MAX_LENGTH)
  })

  it('rejects new reactions on an archived memo but still reports existing ones', async () => {
    insertMemo(MEMO, OWNER, 'archived')
    insertReaction('r1', OWNER, MEMO, '🎉', 10)

    await expectApiError(
      upsertMemoReaction(db, OWNER, MEMO, '👍'),
      409,
      'Archived memos cannot be reacted to',
    )
    expect(reactionRows()).toEqual([{ user_id: OWNER, type: '🎉' }])
    await expect(listMemoReactions(db, OWNER, MEMO)).resolves.toEqual([
      { type: '🎉', count: 1, reacted: true, users: [OWNER_USER] },
    ])
  })

  it('rejects deleting a reaction on an archived memo', async () => {
    insertMemo(MEMO, OWNER, 'archived')
    insertReaction('r1', OWNER, MEMO, '🎉', 10)

    await expectApiError(
      deleteMemoReaction(db, OWNER, MEMO, '🎉'),
      409,
      'Archived memos cannot be reacted to',
    )
    expect(reactionRows()).toEqual([{ user_id: OWNER, type: '🎉' }])
  })

  it('deletes only the caller reaction and is idempotent', async () => {
    insertMemo(MEMO)
    insertReaction('r1', OWNER, MEMO, '👍', 10)
    insertReaction('r2', OTHER, MEMO, '👍', 10)

    await expect(deleteMemoReaction(db, OWNER, MEMO, '  👍  ')).resolves.toEqual([])
    expect(reactionRows()).toEqual([{ user_id: OTHER, type: '👍' }])

    await expect(deleteMemoReaction(db, OWNER, MEMO, '👍')).resolves.toEqual([])
  })

  it('records reaction changes for sync', async () => {
    insertMemo(MEMO)

    await upsertMemoReaction(db, OWNER, MEMO, '👍')
    expect(changeRows()).toEqual([{ kind: 'reaction', memo_id: MEMO }])

    await deleteMemoReaction(db, OWNER, MEMO, '👍')
    expect(changeRows()).toEqual([
      { kind: 'reaction', memo_id: MEMO },
      { kind: 'reaction', memo_id: MEMO },
    ])
  })

  it('refuses writes to another account memo or a missing memo', async () => {
    insertMemo(OTHER_MEMO, OTHER)

    await expectApiError(upsertMemoReaction(db, OWNER, OTHER_MEMO, '👍'), 404, 'Memo not found')
    await expectApiError(upsertMemoReaction(db, OWNER, MISSING_MEMO, '👍'), 404, 'Memo not found')
    await expectApiError(deleteMemoReaction(db, OWNER, OTHER_MEMO, '👍'), 404, 'Memo not found')
    await expectApiError(deleteMemoReaction(db, OWNER, MISSING_MEMO, '👍'), 404, 'Memo not found')
    expect(reactionRows()).toEqual([])
  })
})

describe('memo reaction routes', () => {
  it('refuses every reaction request without a session', async () => {
    const list = await request(`/${MEMO}/reactions`, {}, '')
    expect(list.status).toBe(401)
    expect(await list.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Please sign in first' },
    })

    const upsert = await jsonRequest('PUT', `/${MEMO}/reactions`, { type: '👍' }, '')
    expect(upsert.status).toBe(401)

    const remove = await request(`/${MEMO}/reactions/${encodeURIComponent('👍')}`, { method: 'DELETE' }, '')
    expect(remove.status).toBe(401)
  })

  it('returns the grouped summary', async () => {
    insertMemo(MEMO)
    insertReaction('r1', OWNER, MEMO, '🎉', 10)

    const response = await request(`/${MEMO}/reactions`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      reactions: [{ type: '🎉', count: 1, reacted: true, users: [OWNER_USER] }],
    })
  })

  it('hides another account memo and an unknown memo behind 404', async () => {
    insertMemo(OTHER_MEMO, OTHER)

    const foreign = await request(`/${OTHER_MEMO}/reactions`)
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({
      error: { code: 'not_found', message: 'Memo not found' },
    })

    const missing = await jsonRequest('PUT', `/${MISSING_MEMO}/reactions`, { type: '👍' })
    expect(missing.status).toBe(404)

    const foreignDelete = await request(`/${OTHER_MEMO}/reactions/${encodeURIComponent('👍')}`, {
      method: 'DELETE',
    })
    expect(foreignDelete.status).toBe(404)
  })

  it('upserts idempotently and deletes by the encoded type', async () => {
    insertMemo(MEMO)

    const first = await jsonRequest('PUT', `/${MEMO}/reactions`, { type: '👍' })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      reactions: [{ type: '👍', count: 1, reacted: true, users: [OWNER_USER] }],
    })

    const again = await jsonRequest('PUT', `/${MEMO}/reactions`, { type: '  👍  ' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({
      reactions: [{ type: '👍', count: 1, reacted: true, users: [OWNER_USER] }],
    })
    expect(reactionRows()).toHaveLength(1)

    const removed = await request(`/${MEMO}/reactions/${encodeURIComponent('👍')}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ reactions: [] })
    expect(reactionRows()).toEqual([])
  })

  it('rejects reactions on an archived memo with 409', async () => {
    insertMemo(MEMO, OWNER, 'archived')

    const response = await jsonRequest('PUT', `/${MEMO}/reactions`, { type: '👍' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: 'conflict', message: 'Archived memos cannot be reacted to' },
    })
    expect(reactionRows()).toEqual([])
  })

  it('rejects a missing, blank or oversized type with 400', async () => {
    insertMemo(MEMO)

    const missing = await jsonRequest('PUT', `/${MEMO}/reactions`, {})
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({
      error: { code: 'bad_request', message: 'Reaction type is required' },
    })

    const wrong = await jsonRequest('PUT', `/${MEMO}/reactions`, { type: 42 })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({
      error: { code: 'bad_request', message: 'Reaction type must be a string' },
    })

    const blank = await jsonRequest('PUT', `/${MEMO}/reactions`, { type: '   ' })
    expect(blank.status).toBe(400)
    expect(await blank.json()).toEqual({
      error: { code: 'bad_request', message: 'Reaction type cannot be empty' },
    })

    const oversized = await jsonRequest('PUT', `/${MEMO}/reactions`, {
      type: 'x'.repeat(MEMO_REACTION_TYPE_MAX_LENGTH + 1),
    })
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toEqual({
      error: {
        code: 'bad_request',
        message: `Reaction type cannot exceed ${MEMO_REACTION_TYPE_MAX_LENGTH} characters`,
      },
    })
    expect(reactionRows()).toEqual([])
  })

  it('answers 404 for a malformed memo id', async () => {
    const response = await request('/not-an-id/reactions')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: 'Memo not found' },
    })
  })

  it('keeps the summary of an archived memo readable', async () => {
    insertMemo(SECOND_MEMO, OWNER, 'archived')
    insertReaction('r1', OWNER, SECOND_MEMO, '🎉', 10)

    const response = await request(`/${SECOND_MEMO}/reactions`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      reactions: [{ type: '🎉', count: 1, reacted: true, users: [OWNER_USER] }],
    })
  })
})
