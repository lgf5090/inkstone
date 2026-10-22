// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Memo, MemoListResponse, MemoShare } from '../src/shared/memos/types'
import { initializeDatabase } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { MEMO_PUBLIC_MAX_PAGE_SIZE } from '../src/worker/memos/public'
import { createShare } from '../src/worker/memos/shares'
import { hashOpaqueToken } from '../src/worker/memos/tokens'
import { memoPublicDataRoutes } from '../src/worker/routes/memos/public'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const ALICE_USERNAME = 'alice'
const BOB_USERNAME = 'bob'
const ALICE_PUBLIC = 'a'.repeat(26)
const ALICE_PROTECTED = 'b'.repeat(26)
const ALICE_PRIVATE = 'c'.repeat(26)
const ALICE_ARCHIVED = 'd'.repeat(26)
const ALICE_COMMENT = 'e'.repeat(26)
const BOB_PUBLIC = 'f'.repeat(26)
const SHARE = 'g'.repeat(26)
const SHARE_URL_PREFIX = '/memos/s/'
const SECRET_CONTENT = 'private draft nobody may read'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  db = makeD1(sqlite)
  env = testBindings(db)
  await initializeDatabase(env)
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) c.set('userId', userId)
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/memos/public', memoPublicDataRoutes)
})

afterEach(() => sqlite.close())

function insertUser(id: string, username: string, name = username, role = 'member'): void {
  sqlite.prepare(
    `INSERT INTO users (
       id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at
     ) VALUES (?, ?, '', ?, ?, ?, ?, '{}', 100, 100)`,
  ).run(id, username, username, name, `https://example.test/${username}.png`, role)
}

interface MemoSeed {
  userId?: string
  visibility?: 'private' | 'protected' | 'public'
  state?: 'normal' | 'archived'
  parentId?: string | null
  createdAt?: number
  content?: string
  spaceId?: string | null
  pinned?: boolean
  hasLink?: boolean
  location?: { placeholder: string; latitude: number; longitude: number } | null
}

function insertMemo(id: string, options: MemoSeed = {}): void {
  const content = options.content ?? `content ${id}`
  sqlite.prepare(
    `INSERT INTO memos_items (
       id, user_id, space_id, parent_id, content, content_search, title, snippet,
       visibility, state, pinned, has_link, has_code, has_task_list, has_incomplete_tasks,
       has_location, location_placeholder, latitude, longitude, rev, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    options.userId ?? ALICE,
    options.spaceId ?? null,
    options.parentId ?? null,
    content,
    content.toLowerCase(),
    '',
    content,
    options.visibility ?? 'public',
    options.state ?? 'normal',
    options.pinned ? 1 : 0,
    options.hasLink ? 1 : 0,
    options.location ? 1 : 0,
    options.location?.placeholder ?? null,
    options.location?.latitude ?? null,
    options.location?.longitude ?? null,
    options.createdAt ?? 100,
    options.createdAt ?? 100,
  )
}

function insertTag(memoId: string, tag: string): void {
  sqlite.prepare('INSERT INTO memos_tags (memo_id, tag) VALUES (?, ?)').run(memoId, tag)
}

function insertAttachment(id: string, userId: string, memoId: string): void {
  sqlite.prepare(
    `INSERT INTO memos_attachments (
       id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
       thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at
     ) VALUES (?, ?, ?, 'note.png', 'image/png', 4, 'r2', ?, NULL, NULL, NULL, NULL, NULL, NULL, 100, 100)`,
  ).run(id, userId, memoId, `key-${id}`)
}

function insertReaction(id: string, userId: string, memoId: string, type = 'like'): void {
  sqlite.prepare(
    'INSERT INTO memos_reactions (id, user_id, memo_id, type, created_at) VALUES (?, ?, ?, ?, 100)',
  ).run(id, userId, memoId, type)
}

async function insertShare(
  id: string,
  userId: string,
  memoId: string,
  token: string,
  options: { expiresAt?: number | null; revokedAt?: number | null } = {},
): Promise<void> {
  sqlite.prepare(
    `INSERT INTO memos_shares (id, user_id, memo_id, token_hash, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 100, ?)`,
  ).run(id, userId, memoId, await hashOpaqueToken(token), options.expiresAt ?? null, options.revokedAt ?? null)
}

function seedMemos(): void {
  insertUser(ALICE, ALICE_USERNAME, 'Alice')
  insertUser(BOB, BOB_USERNAME, 'Bob')
  insertMemo(ALICE_PUBLIC, { createdAt: 100 })
  insertMemo(ALICE_PROTECTED, { visibility: 'protected', createdAt: 110 })
  insertMemo(ALICE_PRIVATE, { visibility: 'private', createdAt: 120, content: SECRET_CONTENT })
  insertMemo(ALICE_ARCHIVED, { state: 'archived', createdAt: 130 })
  insertMemo(ALICE_COMMENT, { parentId: ALICE_PUBLIC, createdAt: 140 })
  insertMemo(BOB_PUBLIC, { userId: BOB, createdAt: 150 })
}

async function request(path: string, viewer: string | null = null): Promise<Response> {
  const headers: Record<string, string> = viewer ? { 'x-test-user': viewer } : {}
  return await app.request(`http://localhost/api/memos/public${path}`, { headers }, env, ctx)
}

async function listPage(path: string, viewer: string | null = null): Promise<MemoListResponse> {
  const response = await request(path, viewer)
  expect(response.status).toBe(200)
  return await response.json() as MemoListResponse
}

async function memoBody(path: string, viewer: string | null = null): Promise<Memo> {
  const response = await request(path, viewer)
  expect(response.status).toBe(200)
  return await response.json() as Memo
}

async function expectNotFound(
  path: string,
  message: string,
  viewer: string | null = null,
): Promise<void> {
  const response = await request(path, viewer)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: { code: 'not_found', message },
  })
}

function ids(page: MemoListResponse): string[] {
  return page.items.map((memo) => memo.id)
}

function tokenFrom(share: MemoShare): string {
  if (!share.url) throw new TypeError('the created share has no url')
  return share.url.slice(SHARE_URL_PREFIX.length)
}

describe('public explore', () => {
  beforeEach(() => {
    seedMemos()
  })

  it('shows anonymous readers only public normal root memos across accounts', async () => {
    const page = await listPage('/explore')

    expect(ids(page)).toEqual([BOB_PUBLIC, ALICE_PUBLIC])
    expect(page.nextCursor).toBeNull()
    expect(page.items.map((memo) => memo.creator?.username)).toEqual([BOB_USERNAME, ALICE_USERNAME])
  })

  it('adds protected memos for a signed-in reader', async () => {
    const page = await listPage('/explore', BOB)

    expect(ids(page)).toEqual([BOB_PUBLIC, ALICE_PROTECTED, ALICE_PUBLIC])
  })

  it('never lists private, archived or comment memos', async () => {
    for (const viewer of [null, ALICE]) {
      const page = await listPage('/explore', viewer)
      expect(ids(page)).not.toContain(ALICE_PRIVATE)
      expect(ids(page)).not.toContain(ALICE_ARCHIVED)
      expect(ids(page)).not.toContain(ALICE_COMMENT)
      expect(JSON.stringify(page)).not.toContain(SECRET_CONTENT)
    }
  })

  it('hydrates tags, attachments and the creator for another account memo', async () => {
    insertTag(BOB_PUBLIC, 'shared')
    insertAttachment('i'.repeat(26), BOB, BOB_PUBLIC)
    insertReaction('j'.repeat(26), BOB, BOB_PUBLIC)
    sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(BOB)

    const page = await listPage('/explore')
    const memo = page.items.find((item) => item.id === BOB_PUBLIC)!

    expect(memo.tags).toEqual(['shared'])
    expect(memo.attachments).toEqual([{
      id: 'i'.repeat(26),
      filename: 'note.png',
      mime: 'image/png',
      size: 4,
      width: null,
      height: null,
      url: `/api/memos/files/${'i'.repeat(26)}`,
      thumbnailUrl: null,
      motion: null,
      mediaMetadata: null,
      createdAt: 100,
    }])
    expect(memo.creator).toEqual({
      id: '',
      login: BOB_USERNAME,
      name: 'Bob',
      avatarUrl: 'https://example.test/bob.png',
      role: 'member',
      createdAt: 0,
      username: BOB_USERNAME,
    })
    expect(JSON.stringify(memo)).not.toContain(BOB)
    expect(memo.reactions).toEqual([])
  })

  it('publishes a whitelisted shape without storage identifiers or derived properties', async () => {
    const publicId = 'q'.repeat(26)
    insertMemo(publicId, {
      spaceId: 'space-secret',
      hasLink: true,
      location: { placeholder: 'Somewhere', latitude: 12.5, longitude: 34.5 },
    })

    const memo = await memoBody(`/users/${ALICE_USERNAME}/memos/${publicId}`)

    expect(memo.spaceId).toBeNull()
    expect(memo.parentId).toBeNull()
    expect(memo.rev).toBe(0)
    expect(memo.location).toBeNull()
    expect(memo.properties).toEqual({
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
    })
    expect(memo.creator?.id).toBe('')
    expect(memo.creator?.role).toBe('member')
    expect(memo.creator?.createdAt).toBe(0)
    expect(JSON.stringify(memo)).not.toContain('space-secret')
  })

  it('keeps the comment count without exposing comments, reactions or relations', async () => {
    insertReaction('k'.repeat(26), ALICE, ALICE_PUBLIC)

    const page = await listPage('/explore')
    const memo = page.items.find((item) => item.id === ALICE_PUBLIC)!

    expect(memo.commentCount).toBe(1)
    expect(memo.reactions).toEqual([])
    expect(memo.relations).toEqual([])
    expect(page.items.some((item) => item.id === ALICE_COMMENT)).toBe(false)
  })
})

describe('public profile', () => {
  beforeEach(() => {
    seedMemos()
  })

  it('lists only the requested account memos with the same visibility rules', async () => {
    const anonymous = await listPage(`/users/${ALICE_USERNAME}/memos`)
    expect(ids(anonymous)).toEqual([ALICE_PUBLIC])

    const signedIn = await listPage(`/users/${ALICE_USERNAME}/memos`, BOB)
    expect(ids(signedIn)).toEqual([ALICE_PROTECTED, ALICE_PUBLIC])
  })

  it('answers 404 for an unknown username', async () => {
    await expectNotFound('/users/nobody/memos', 'User not found')
  })

  it('pages by created time with an offset cursor', async () => {
    const created = [160, 161, 162, 163, 164]
    const extra = created.map((createdAt, index) => {
      const memoId = `k${String(index).padStart(25, '0')}`
      insertMemo(memoId, { createdAt, content: `paged ${index}` })
      return memoId
    })

    const first = await listPage(`/users/${ALICE_USERNAME}/memos?limit=2`)
    expect(ids(first)).toEqual([extra[4], extra[3]])
    expect(first.nextCursor).not.toBeNull()

    const second = await listPage(
      `/users/${ALICE_USERNAME}/memos?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    )
    expect(ids(second)).toEqual([extra[2], extra[1]])
    expect(second.nextCursor).not.toBeNull()

    const third = await listPage(
      `/users/${ALICE_USERNAME}/memos?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`,
    )
    expect(ids(third)).toEqual([extra[0], ALICE_PUBLIC])
    expect(third.nextCursor).toBeNull()
  })

  it('accepts a time zone and rejects a malformed cursor', async () => {
    const page = await listPage(`/users/${ALICE_USERNAME}/memos?tz=Asia%2FShanghai`)
    expect(ids(page)).toEqual([ALICE_PUBLIC])

    const response = await request(`/users/${ALICE_USERNAME}/memos?cursor=not-a-cursor`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'bad_request', message: 'Invalid cursor' },
    })
  })

  it('caps the page size at the public maximum', async () => {
    for (let index = 0; index < MEMO_PUBLIC_MAX_PAGE_SIZE + 1; index++) {
      insertMemo(`p${String(index).padStart(25, '0')}`, { createdAt: 200 + index })
    }

    const response = await request(`/users/${ALICE_USERNAME}/memos?limit=1000`)
    expect(response.status).toBe(200)
    const page = await response.json() as MemoListResponse
    expect(page.items).toHaveLength(MEMO_PUBLIC_MAX_PAGE_SIZE)
    expect(page.nextCursor).not.toBeNull()
  })
})

describe('public memo detail', () => {
  beforeEach(() => {
    seedMemos()
    insertTag(ALICE_PUBLIC, 'note')
    insertAttachment('l'.repeat(26), ALICE, ALICE_PUBLIC)
    insertReaction('m'.repeat(26), ALICE, ALICE_PUBLIC)
  })

  it('returns a public memo to anonymous readers with tags, attachments and creator', async () => {
    const memo = await memoBody(`/users/${ALICE_USERNAME}/memos/${ALICE_PUBLIC}`)

    expect(memo.id).toBe(ALICE_PUBLIC)
    expect(memo.content).toBe(`content ${ALICE_PUBLIC}`)
    expect(memo.visibility).toBe('public')
    expect(memo.tags).toEqual(['note'])
    expect(memo.attachments.map((attachment) => attachment.id)).toEqual(['l'.repeat(26)])
    expect(memo.creator?.username).toBe(ALICE_USERNAME)
    expect(memo.parentId).toBeNull()
    expect(memo.commentCount).toBe(1)
    expect(memo.reactions).toEqual([])
    expect(memo.relations).toEqual([])
  })

  it('hides protected, private, archived and comment memos from anonymous readers', async () => {
    await expectNotFound(`/users/${ALICE_USERNAME}/memos/${ALICE_PROTECTED}`, 'Memo not found')
    await expectNotFound(`/users/${ALICE_USERNAME}/memos/${ALICE_PRIVATE}`, 'Memo not found')
    await expectNotFound(`/users/${ALICE_USERNAME}/memos/${ALICE_ARCHIVED}`, 'Memo not found')
    await expectNotFound(`/users/${ALICE_USERNAME}/memos/${ALICE_COMMENT}`, 'Memo not found')
  })

  it('shows a protected memo to a signed-in reader but never a private one', async () => {
    const memo = await memoBody(`/users/${ALICE_USERNAME}/memos/${ALICE_PROTECTED}`, BOB)
    expect(memo.id).toBe(ALICE_PROTECTED)

    await expectNotFound(`/users/${ALICE_USERNAME}/memos/${ALICE_PRIVATE}`, 'Memo not found', BOB)
  })

  it('answers 404 for a memo under another username, an unknown user or a malformed id', async () => {
    await expectNotFound(`/users/${BOB_USERNAME}/memos/${ALICE_PUBLIC}`, 'Memo not found')
    await expectNotFound(`/users/nobody/memos/${ALICE_PUBLIC}`, 'Memo not found')
    await expectNotFound(`/users/${ALICE_USERNAME}/memos/not-an-id`, 'Memo not found')
  })
})

describe('public share page', () => {
  beforeEach(() => {
    insertUser(ALICE, ALICE_USERNAME, 'Alice')
    insertMemo(ALICE_PRIVATE, {
      visibility: 'private',
      content: 'shared private memo',
      createdAt: 120,
    })
    insertTag(ALICE_PRIVATE, 'share')
    insertAttachment('n'.repeat(26), ALICE, ALICE_PRIVATE)
  })

  it('serves a private memo through a valid share token without a session', async () => {
    const share = await createShare(db, ALICE, ALICE_PRIVATE)

    const memo = await memoBody(`/shares/${tokenFrom(share)}`)

    expect(memo.id).toBe(ALICE_PRIVATE)
    expect(memo.content).toBe('shared private memo')
    expect(memo.visibility).toBe('private')
    expect(memo.tags).toEqual(['share'])
    expect(memo.attachments.map((attachment) => attachment.id)).toEqual(['n'.repeat(26)])
    expect(memo.creator?.username).toBe(ALICE_USERNAME)
    expect(memo.parentId).toBeNull()
    expect(memo.commentCount).toBe(0)
    expect(memo.reactions).toEqual([])
    expect(memo.relations).toEqual([])
  })

  it('refuses expired, revoked and unknown tokens', async () => {
    await insertShare(SHARE, ALICE, ALICE_PRIVATE, 'x'.repeat(43), { expiresAt: 1 })
    await insertShare('o'.repeat(26), ALICE, ALICE_PRIVATE, 'y'.repeat(43), { revokedAt: 60 })

    await expectNotFound(`/shares/${'x'.repeat(43)}`, 'Share not found')
    await expectNotFound(`/shares/${'y'.repeat(43)}`, 'Share not found')
    await expectNotFound(`/shares/${'z'.repeat(43)}`, 'Share not found')
    await expectNotFound('/shares/not-a-token', 'Share not found')
  })

  it('stops serving a share once its memo is archived', async () => {
    const share = await createShare(db, ALICE, ALICE_PRIVATE)
    sqlite.prepare(`UPDATE memos_items SET state = 'archived' WHERE id = ?`).run(ALICE_PRIVATE)

    await expectNotFound(`/shares/${tokenFrom(share)}`, 'Share not found')
  })

  it('does not expose comments or reactions of the shared memo', async () => {
    insertMemo('p'.repeat(26), { parentId: ALICE_PRIVATE, content: 'comment body', createdAt: 140 })
    insertReaction('q'.repeat(26), ALICE, ALICE_PRIVATE)
    const share = await createShare(db, ALICE, ALICE_PRIVATE)

    const response = await request(`/shares/${tokenFrom(share)}`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain('comment body')
    expect(await JSON.parse(body) as Memo).toMatchObject({
      id: ALICE_PRIVATE,
      parentId: null,
      commentCount: 0,
      reactions: [],
      relations: [],
    })
  })
})
