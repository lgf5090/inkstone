// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import type { ExecutionContext } from 'hono'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Memo, MemoListResponse } from '../src/shared/memos/types'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/env'
import { hashToken } from '../src/worker/lib/session-store'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const OWNER_TOKEN = 'a'.repeat(64)
const OTHER_TOKEN = 'b'.repeat(64)

const app = createApp()
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

let sqlite: DatabaseSync
let env: Env

function insertUser(id: string, username: string): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'owner', '{}', ?, ?)`,
  ).run(id, username, username, username, now, now)
}

async function insertSession(token: string, userId: string): Promise<void> {
  const now = Date.now()
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(token), userId, now + 3_600_000, now)
}

async function call(
  method: string,
  path: string,
  options: { session?: string | null; body?: unknown } = {},
): Promise<Response> {
  const token = options.session === undefined ? OWNER_TOKEN : options.session
  const headers: Record<string, string> = {}
  if (token) headers.Cookie = `inkstone_session=${token}`
  if (method !== 'GET') headers['X-Inkstone-Client'] = '1'
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env, ctx)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function createMemo(body: Record<string, unknown>, session?: string | null): Promise<Memo> {
  const response = await call('POST', '/api/memos', { body, session })
  expect(response.status).toBe(201)
  return json<Memo>(response)
}

async function createComment(parentId: string, content: string, createdAt?: number): Promise<Memo> {
  const response = await call('POST', `/api/memos/${parentId}/comments`, {
    body: { content, createdAt },
  })
  expect(response.status).toBe(201)
  return json<Memo>(response)
}

async function listComments(parentId: string, query = ''): Promise<MemoListResponse> {
  const response = await call('GET', `/api/memos/${parentId}/comments${query}`)
  expect(response.status).toBe(200)
  return json<MemoListResponse>(response)
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env, ctx)
})

beforeEach(async () => {
  sqlite.exec('DELETE FROM memos_items')
  sqlite.exec('DELETE FROM memos_tags')
  sqlite.exec('DELETE FROM memos_relations')
  sqlite.exec('DELETE FROM memos_attachments')
  sqlite.exec('DELETE FROM memos_changes')
  sqlite.exec('DELETE FROM memos_spaces')
  sqlite.exec('DELETE FROM sessions')
  sqlite.exec('DELETE FROM users')
  insertUser(OWNER_ID, 'owner')
  insertUser(OTHER_ID, 'other')
  await insertSession(OWNER_TOKEN, OWNER_ID)
  await insertSession(OTHER_TOKEN, OTHER_ID)
  env = testBindings(env.DB)
})

describe('memo comments', () => {
  it('creates a comment that inherits the parent space and visibility', async () => {
    const space = await json<{ id: string }>(
      await call('POST', '/api/memos/spaces', { body: { title: 'Work' } }),
    )
    const parent = await createMemo({
      content: '# Parent\n\nparent body',
      spaceId: space.id,
      visibility: 'public',
    })
    const comment = await createComment(parent.id, 'first #reply')

    expect(comment.parentId).toBe(parent.id)
    expect(comment.spaceId).toBe(space.id)
    expect(comment.visibility).toBe('public')
    expect(comment.tags).toEqual(['reply'])
    expect(comment.title).toBe('first #reply')
    expect(comment.rev).toBe(1)

    const page = await listComments(parent.id)
    expect(page.items.map((memo) => memo.id)).toEqual([comment.id])
    expect(page.nextCursor).toBeNull()

    const hydratedParent = await json<Memo>(await call('GET', `/api/memos/${parent.id}`))
    expect(hydratedParent.commentCount).toBe(1)
    const feed = await json<MemoListResponse>(await call('GET', '/api/memos'))
    expect(feed.items.map((memo) => memo.id)).toEqual([parent.id])
  })

  it('pages comments oldest first with sixteen per page', async () => {
    const parent = await createMemo({ content: 'parent' })
    for (let index = 0; index < 17; index++) {
      await createComment(parent.id, `comment ${index}`, 1_000 + index)
    }
    const first = await listComments(parent.id)
    expect(first.items).toHaveLength(16)
    expect(first.items[0]?.createdAt).toBe(1_000)
    expect(first.items[15]?.createdAt).toBe(1_015)
    expect(first.nextCursor).not.toBeNull()

    const second = await listComments(parent.id, `?cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.createdAt).toBe(1_016)
    expect(second.nextCursor).toBeNull()
  })

  it('allows commenting on your own memo but not on archived or nested memos', async () => {
    const parent = await createMemo({ content: 'parent' })
    const comment = await createComment(parent.id, 'self comment')
    const nested = await call('POST', `/api/memos/${comment.id}/comments`, { body: { content: 'nested' } })
    expect(nested.status).toBe(400)

    const archived = await call('PATCH', `/api/memos/${parent.id}`, {
      body: { rev: 1, state: 'archived' },
    })
    expect(archived.status).toBe(200)
    const rejected = await call('POST', `/api/memos/${parent.id}/comments`, { body: { content: 'late' } })
    expect(rejected.status).toBe(400)
  })

  it('deletes one comment without touching its siblings', async () => {
    const parent = await createMemo({ content: 'parent' })
    const first = await createComment(parent.id, 'first')
    const second = await createComment(parent.id, 'second')

    const removed = await call('DELETE', `/api/memos/${first.id}`)
    expect(removed.status).toBe(200)
    const page = await listComments(parent.id)
    expect(page.items.map((memo) => memo.id)).toEqual([second.id])
    expect((await json<Memo>(await call('GET', `/api/memos/${parent.id}`))).commentCount).toBe(1)
  })

  it('cascades comments when the parent memo is deleted', async () => {
    const parent = await createMemo({ content: 'parent' })
    const first = await createComment(parent.id, 'first')
    const second = await createComment(parent.id, 'second')

    expect((await call('DELETE', `/api/memos/${parent.id}`)).status).toBe(200)
    expect((await call('GET', `/api/memos/${first.id}`)).status).toBe(404)
    expect((await call('GET', `/api/memos/${second.id}`)).status).toBe(404)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memos_items').get()).toEqual({ count: 0 })
  })

  it('hides parent comments from other accounts and missing parents', async () => {
    const parent = await createMemo({ content: 'parent' })
    await createComment(parent.id, 'comment')

    const otherList = await call('GET', `/api/memos/${parent.id}/comments`, { session: OTHER_TOKEN })
    expect(otherList.status).toBe(404)
    const otherCreate = await call('POST', `/api/memos/${parent.id}/comments`, {
      body: { content: 'intruder' },
      session: OTHER_TOKEN,
    })
    expect(otherCreate.status).toBe(404)

    const missing = await call('GET', `/api/memos/${'z'.repeat(26)}/comments`)
    expect(missing.status).toBe(404)
    const invalid = await call('GET', '/api/memos/not-an-id/comments')
    expect(invalid.status).toBe(404)
  })
})
