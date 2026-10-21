// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import type { ExecutionContext } from 'hono'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Memo, MemoListResponse, MemoRelation } from '../src/shared/memos/types'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/env'
import { hashToken } from '../src/worker/lib/session-store'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const OWNER_TOKEN = 'a'.repeat(64)
const OTHER_TOKEN = 'b'.repeat(64)

const app = createApp()
const pending: Promise<unknown>[] = []
const ctx: ExecutionContext = {
  waitUntil(promise) {
    pending.push(promise)
  },
  passThroughOnException() {},
  props: {},
}

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

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

interface CallOptions {
  session?: string | null
  body?: unknown
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const token = options.session === undefined ? OWNER_TOKEN : options.session
  const headers: Record<string, string> = {}
  if (token) headers.Cookie = `inkstone_session=${token}`
  if (method !== 'GET') headers['X-Inkstone-Client'] = '1'
  let body: string | undefined
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
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

async function listMemos(query = '', session?: string | null): Promise<MemoListResponse> {
  const response = await call('GET', `/api/memos${query}`, { session })
  expect(response.status, await response.clone().text()).toBe(200)
  return json<MemoListResponse>(response)
}

function insertAttachmentRow(options: {
  id: string
  userId: string
  memoId?: string | null
  storageKey: string
  thumbnailKey?: string | null
}): void {
  const now = Math.floor(Date.now() / 1000)
  sqlite.prepare(
    `INSERT INTO memos_attachments (
       id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
       thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at
     ) VALUES (?, ?, ?, 'file.png', 'image/png', 4, 'r2', ?, 1, 1, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    options.id,
    options.userId,
    options.memoId ?? null,
    options.storageKey,
    options.thumbnailKey ?? null,
    now,
    now,
  )
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
  sqlite.exec('DELETE FROM memos_reactions')
  sqlite.exec('DELETE FROM memos_attachments')
  sqlite.exec('DELETE FROM memos_shares')
  sqlite.exec('DELETE FROM memos_changes')
  sqlite.exec('DELETE FROM memos_spaces')
  sqlite.exec('DELETE FROM sessions')
  sqlite.exec('DELETE FROM users')
  insertUser(OWNER_ID, 'owner')
  insertUser(OTHER_ID, 'other')
  await insertSession(OWNER_TOKEN, OWNER_ID)
  await insertSession(OTHER_TOKEN, OTHER_ID)
  pending.length = 0
  bucket = testR2Bucket()
  env = testBindings(env.DB, { FILES: bucket })
})

describe('memo authorization', () => {
  it('refuses every memo endpoint without a session', async () => {
    const id = 'a'.repeat(26)
    const paths: Array<[string, string]> = [
      ['GET', '/api/memos'],
      ['POST', '/api/memos'],
      ['GET', `/api/memos/${id}`],
      ['PATCH', `/api/memos/${id}`],
      ['DELETE', `/api/memos/${id}`],
      ['POST', `/api/memos/${id}/restore`],
      ['GET', `/api/memos/${id}/comments`],
      ['POST', `/api/memos/${id}/comments`],
      ['GET', `/api/memos/${id}/relations`],
      ['PUT', `/api/memos/${id}/relations`],
    ]
    for (const [method, path] of paths) {
      const response = await call(method, path, { session: null, body: {} })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })

  it('hides another account memo from reads, writes, comments, and relations', async () => {
    const memo = await createMemo({ content: 'private memo' })
    expect((await listMemos()).items).toHaveLength(1)
    expect((await listMemos('', OTHER_TOKEN)).items).toHaveLength(0)

    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/api/memos/${memo.id}`],
      ['PATCH', `/api/memos/${memo.id}`, { rev: memo.rev, content: 'stolen' }],
      ['DELETE', `/api/memos/${memo.id}`],
      ['POST', `/api/memos/${memo.id}/restore`],
      ['GET', `/api/memos/${memo.id}/comments`],
      ['POST', `/api/memos/${memo.id}/comments`, { content: 'hello' }],
      ['GET', `/api/memos/${memo.id}/relations`],
      ['PUT', `/api/memos/${memo.id}/relations`, { relatedMemoIds: [] }],
    ]
    for (const [method, path, body] of attempts) {
      const response = await call(method, path, { session: OTHER_TOKEN, body })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
  })
})

describe('memo CRUD', () => {
  it('creates, reads, updates, archives, restores, and deletes a memo', async () => {
    const createdAt = Math.floor(Date.now() / 1000) - 60
    const created = await createMemo({
      content: '# First\n\nBody #work',
      createdAt,
      location: { placeholder: 'Office', latitude: 31.23, longitude: 121.47 },
    })
    expect(created.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(created).toMatchObject({
      content: '# First\n\nBody #work',
      title: 'First',
      snippet: 'Body #work',
      tags: ['work'],
      visibility: 'private',
      state: 'normal',
      pinned: false,
      spaceId: null,
      parentId: null,
      rev: 1,
      createdAt,
      updatedAt: createdAt,
      location: { placeholder: 'Office', latitude: 31.23, longitude: 121.47 },
    })
    expect(created.properties.hasLocation).toBe(true)
    expect(created.properties.hasTaskList).toBe(false)

    const fetched = await call('GET', `/api/memos/${created.id}`)
    expect(fetched.status).toBe(200)
    expect(await json<Memo>(fetched)).toEqual(created)

    const patched = await call('PATCH', `/api/memos/${created.id}`, {
      body: { rev: 1, content: '## Second\n\n- [ ] task #home/kitchen' },
    })
    expect(patched.status).toBe(200)
    const updated = await json<Memo>(patched)
    expect(updated.rev).toBe(2)
    expect(updated.title).toBe('Second')
    expect(updated.tags).toEqual(['home', 'home/kitchen'])
    expect(updated.properties.hasTaskList).toBe(true)
    expect(updated.properties.hasIncompleteTasks).toBe(true)
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt)

    const conflict = await call('PATCH', `/api/memos/${created.id}`, {
      body: { rev: 1, content: 'stale' },
    })
    expect(conflict.status).toBe(409)
    const current = await json<Memo>(conflict)
    expect(current.rev).toBe(2)
    expect(current.content).toContain('Second')

    const pinned = await call('PATCH', `/api/memos/${created.id}`, {
      body: { rev: 2, pinned: true },
    })
    expect(pinned.status).toBe(200)
    expect((await json<Memo>(pinned)).pinned).toBe(true)

    const archived = await call('PATCH', `/api/memos/${created.id}`, {
      body: { rev: 3, state: 'archived' },
    })
    expect((await json<Memo>(archived)).state).toBe('archived')
    expect((await listMemos()).items).toHaveLength(0)
    expect((await listMemos('?state=archived')).items[0]?.id).toBe(created.id)

    const restored = await call('POST', `/api/memos/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const live = await json<Memo>(restored)
    expect(live.state).toBe('normal')
    expect(live.rev).toBe(5)
    expect((await listMemos()).items).toHaveLength(1)

    const removed = await call('DELETE', `/api/memos/${created.id}`)
    expect(removed.status).toBe(200)
    expect(await json(removed)).toEqual({ ok: true })
    expect((await call('GET', `/api/memos/${created.id}`)).status).toBe(404)
    expect((await listMemos()).items).toHaveLength(0)
  })

  it('rejects unknown visibility, invalid ids, and oversized content', async () => {
    expect((await call('POST', '/api/memos', { body: { content: 'x', visibility: 'space' } })).status).toBe(400)
    expect((await call('POST', '/api/memos', { body: { content: 'x', id: 'nope' } })).status).toBe(400)
    expect((await call('POST', '/api/memos', { body: { content: 'x', spaceId: 'nope' } })).status).toBe(400)
    expect((await call('POST', '/api/memos', { body: { content: 42 } })).status).toBe(400)
    const huge = 'x'.repeat(1_900_001)
    expect((await call('POST', '/api/memos', { body: { content: huge } })).status).toBe(413)
  })

  it('keeps a client supplied id unique across accounts', async () => {
    const id = 'z'.repeat(26)
    await createMemo({ id, content: 'mine' })
    const duplicate = await call('POST', '/api/memos', { body: { id, content: 'again' } })
    expect(duplicate.status).toBe(409)
    const other = await call('POST', '/api/memos', { body: { id, content: 'theirs' }, session: OTHER_TOKEN })
    expect(other.status).toBe(409)
  })

  it('pages with an offset cursor and honours ordering', async () => {
    for (let index = 0; index < 17; index++) {
      await createMemo({
        content: `memo ${index}`,
        createdAt: 1_000 + index,
        updatedAt: 1_000 + index,
      })
    }
    const first = await listMemos()
    expect(first.items).toHaveLength(16)
    expect(first.items[0]?.createdAt).toBe(1_016)
    expect(first.items[15]?.createdAt).toBe(1_001)
    expect(first.nextCursor).not.toBeNull()

    const second = await listMemos(`?cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.createdAt).toBe(1_000)
    expect(second.nextCursor).toBeNull()

    const ascending = await listMemos('?order=asc&limit=2')
    expect(ascending.items.map((memo) => memo.createdAt)).toEqual([1_000, 1_001])

    const updated = await listMemos('?orderBy=updated&order=desc&limit=1')
    expect(updated.items[0]?.createdAt).toBe(1_016)

    const invalidCursor = await call('GET', '/api/memos?cursor=not-base64')
    expect(invalidCursor.status).toBe(400)
  })

  it('keeps pinned memos first until the archive view', async () => {
    const older = await createMemo({ content: 'older', createdAt: 1_000 })
    const newer = await createMemo({ content: 'newer', createdAt: 2_000 })
    await call('PATCH', `/api/memos/${older.id}`, { body: { rev: 1, pinned: true } })
    expect((await listMemos()).items.map((memo) => memo.id)).toEqual([older.id, newer.id])

    await call('PATCH', `/api/memos/${older.id}`, { body: { rev: 2, state: 'archived' } })
    const archived = await listMemos('?state=archived')
    expect(archived.items.map((memo) => memo.id)).toEqual([older.id])
  })

  it('clears a location and applies explicit timestamps', async () => {
    const memo = await createMemo({
      content: 'located',
      createdAt: 1_000,
      location: { placeholder: 'Here', latitude: 1, longitude: 2 },
    })
    const cleared = await call('PATCH', `/api/memos/${memo.id}`, {
      body: { rev: 1, location: null },
    })
    const clearedMemo = await json<Memo>(cleared)
    expect(clearedMemo.location).toBeNull()
    expect(clearedMemo.properties.hasLocation).toBe(false)
    expect(clearedMemo.updatedAt).toBeGreaterThan(memo.updatedAt)

    const stamped = await call('PATCH', `/api/memos/${memo.id}`, {
      body: { rev: 2, createdAt: 500, updatedAt: 750 },
    })
    const stampedMemo = await json<Memo>(stamped)
    expect(stampedMemo.createdAt).toBe(500)
    expect(stampedMemo.updatedAt).toBe(750)
  })

  it('cascades tags, reactions, and shares when a memo is deleted', async () => {
    const memo = await createMemo({ content: '#keep reaction' })
    sqlite.prepare('INSERT INTO memos_reactions (id, user_id, memo_id, type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('r'.repeat(26), OWNER_ID, memo.id, '👍', 1_000)
    sqlite.prepare(
      'INSERT INTO memos_shares (id, user_id, memo_id, token_hash, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)',
    ).run('s'.repeat(26), OWNER_ID, memo.id, 'token-hash', 1_000)

    expect((await call('DELETE', `/api/memos/${memo.id}`)).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memos_tags').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memos_reactions').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memos_shares').get()).toEqual({ count: 0 })
  })
})

describe('memo derivation', () => {
  it('persists tags, properties, and the title from the content', async () => {
    const content = [
      '# Release notes',
      '',
      'Read [the docs](https://example.com/#frag) and #产品/路线图.',
      '',
      '- [x] shipped',
      '- [ ] pending',
      '',
      '`inline #ignored`',
      '',
      '```js',
      '#also-ignored',
      '```',
    ].join('\n')
    const memo = await createMemo({ content })
    expect(memo.title).toBe('Release notes')
    expect(memo.tags).toEqual(['产品', '产品/路线图'])
    expect(memo.properties).toEqual({
      hasLink: true,
      hasCode: true,
      hasTaskList: true,
      hasIncompleteTasks: true,
      hasLocation: false,
    })
  })
})

describe('memo filters', () => {
  it('applies tag, pinned, content, and date expressions', async () => {
    const work = await createMemo({ content: 'TODO review #work', createdAt: 2_000 })
    const personal = await createMemo({ content: 'groceries #personal', createdAt: 3_000 })
    await call('PATCH', `/api/memos/${work.id}`, { body: { rev: 1, pinned: true } })

    const byTag = await listMemos(`?filter=${encodeURIComponent('tag in ["work"]')}`)
    expect(byTag.items.map((memo) => memo.id)).toEqual([work.id])

    const byPinned = await listMemos(`?filter=${encodeURIComponent('pinned == true')}`)
    expect(byPinned.items.map((memo) => memo.id)).toEqual([work.id])

    const byContent = await listMemos(`?filter=${encodeURIComponent('content.contains("TODO")')}`)
    expect(byContent.items.map((memo) => memo.id)).toEqual([work.id])

    const byDate = await listMemos(`?filter=${encodeURIComponent('created_ts >= timestamp("1970-01-01T00:41:40Z")')}`)
    expect(byDate.items.map((memo) => memo.id)).toEqual([personal.id])

    const byVisibility = await listMemos(`?filter=${encodeURIComponent('visibility == "PRIVATE"')}`)
    expect(byVisibility.items).toHaveLength(2)

    const byHour = await listMemos(
      `?tz=Asia/Shanghai&filter=${encodeURIComponent('created_ts.getHours() == 8')}`,
    )
    expect(byHour.items).toHaveLength(2)
  })

  it('rejects invalid expressions with the parser position', async () => {
    const response = await call('GET', `/api/memos?filter=${encodeURIComponent('tag in [')}`)
    expect(response.status).toBe(400)
    expect((await json<{ error: { message: string } }>(response)).error.message).toMatch(/Invalid filter/)
  })

  it('paginates filtered results', async () => {
    for (let index = 0; index < 3; index++) {
      await createMemo({ content: `entry ${index} #shared`, createdAt: 1_000 + index })
    }
    const first = await listMemos(`?limit=2&filter=${encodeURIComponent('tag in ["shared"]')}`)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await listMemos(
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}&filter=${encodeURIComponent('tag in ["shared"]')}`,
    )
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
  })

  it('refuses a filter that would scan past the limit', async () => {
    sqlite.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20001)
       INSERT INTO memos_items (id, user_id, content, created_at, updated_at)
       SELECT 'x' || printf('%025d', n), ?, '', 1000, 1000 FROM seq`,
    ).run(OWNER_ID)
    const response = await call('GET', `/api/memos?filter=${encodeURIComponent('pinned == false')}`)
    expect(response.status).toBe(400)
    expect((await json<{ error: { message: string } }>(response)).error.message).toMatch(/too large/)
  })
})

describe('memo attachments', () => {
  it('binds explicit and content referenced attachments', async () => {
    const referenced = 'a'.repeat(26)
    const explicit = 'b'.repeat(26)
    insertAttachmentRow({ id: referenced, userId: OWNER_ID, storageKey: 'memos/referenced' })
    insertAttachmentRow({ id: explicit, userId: OWNER_ID, storageKey: 'memos/explicit' })

    const memo = await createMemo({
      content: `![image](/api/memos/files/${referenced})`,
      attachmentIds: [explicit],
    })
    expect(memo.attachments.map((attachment) => attachment.id).sort()).toEqual([referenced, explicit].sort())
    expect(memo.attachments[0]?.url).toBe(`/api/memos/files/${memo.attachments[0]?.id}`)
    const bound = sqlite.prepare('SELECT memo_id FROM memos_attachments WHERE id = ?').get(explicit) as {
      memo_id: string | null
    }
    expect(bound.memo_id).toBe(memo.id)
  })

  it('refuses attachments owned by another account or by another memo', async () => {
    const foreign = 'c'.repeat(26)
    const source = await createMemo({ content: 'source' })
    const taken = 'd'.repeat(26)
    insertAttachmentRow({ id: foreign, userId: OTHER_ID, storageKey: 'memos/foreign' })
    insertAttachmentRow({ id: taken, userId: OWNER_ID, memoId: source.id, storageKey: 'memos/taken' })

    const foreignResponse = await call('POST', '/api/memos', { body: { content: 'x', attachmentIds: [foreign] } })
    expect(foreignResponse.status).toBe(400)
    const takenResponse = await call('POST', '/api/memos', { body: { content: 'x', attachmentIds: [taken] } })
    expect(takenResponse.status).toBe(400)
    const unknownReference = await call('POST', '/api/memos', {
      body: { content: `![x](/api/memos/files/${'e'.repeat(26)})` },
    })
    expect(unknownReference.status).toBe(400)
  })

  it('replaces bindings on patch and removes objects with the memo', async () => {
    const first = 'f'.repeat(26)
    const second = 'g'.repeat(26)
    insertAttachmentRow({ id: first, userId: OWNER_ID, storageKey: 'memos/first' })
    insertAttachmentRow({ id: second, userId: OWNER_ID, storageKey: 'memos/second' })
    bucket.objects.set('memos/first', new Uint8Array([1]))
    bucket.objects.set('memos/second', new Uint8Array([2]))

    const memo = await createMemo({ content: 'attachments', attachmentIds: [first] })
    expect(memo.attachments.map((attachment) => attachment.id)).toEqual([first])

    const replaced = await call('PATCH', `/api/memos/${memo.id}`, {
      body: { rev: 1, attachmentIds: [second] },
    })
    expect(replaced.status).toBe(200)
    expect((await json<Memo>(replaced)).attachments.map((attachment) => attachment.id)).toEqual([second])

    const unbound = await call('PATCH', `/api/memos/${memo.id}`, {
      body: { rev: 2, attachmentIds: [] },
    })
    expect((await json<Memo>(unbound)).attachments).toEqual([])
    await call('PATCH', `/api/memos/${memo.id}`, { body: { rev: 3, attachmentIds: [first] } })

    const removed = await call('DELETE', `/api/memos/${memo.id}`)
    expect(removed.status).toBe(200)
    await Promise.all(pending)
    expect(bucket.objects.has('memos/first')).toBe(false)
    expect(bucket.objects.has('memos/second')).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memos_attachments WHERE memo_id IS NOT NULL').get())
      .toEqual({ count: 0 })
  })
})

describe('memo relations', () => {
  it('replaces outgoing relations and reports incoming snippets', async () => {
    const source = await createMemo({ content: '# Source\n\nsource body' })
    const target = await createMemo({ content: '# Target\n\ntarget body' })

    const replaced = await call('PUT', `/api/memos/${source.id}/relations`, {
      body: { relatedMemoIds: [target.id, target.id, source.id] },
    })
    expect(replaced.status).toBe(200)
    const pair = await json<{ outgoing: MemoRelation[]; incoming: MemoRelation[] }>(replaced)
    expect(pair.outgoing).toHaveLength(1)
    expect(pair.outgoing[0]).toMatchObject({
      memoId: source.id,
      relatedMemoId: target.id,
      relatedSnippet: 'target body',
    })
    expect(pair.incoming).toEqual([])

    const incoming = await call('GET', `/api/memos/${target.id}/relations`)
    const reverse = await json<{ outgoing: MemoRelation[]; incoming: MemoRelation[] }>(incoming)
    expect(reverse.outgoing).toEqual([])
    expect(reverse.incoming).toHaveLength(1)
    expect(reverse.incoming[0]).toMatchObject({
      memoId: source.id,
      relatedMemoId: target.id,
      relatedSnippet: 'source body',
    })

    const hydrated = await json<Memo>(await call('GET', `/api/memos/${source.id}`))
    expect(hydrated.relations).toHaveLength(1)

    await call('DELETE', `/api/memos/${target.id}`)
    const cleared = await call('GET', `/api/memos/${source.id}/relations`)
    expect(await json(cleared)).toEqual({ outgoing: [], incoming: [] })
  })

  it('rejects relations to missing or foreign memos', async () => {
    const memo = await createMemo({ content: 'root' })
    const missing = await call('PUT', `/api/memos/${memo.id}/relations`, {
      body: { relatedMemoIds: ['h'.repeat(26)] },
    })
    expect(missing.status).toBe(400)

    const foreignResponse = await call('POST', '/api/memos', { body: { content: 'theirs' }, session: OTHER_TOKEN })
    const foreign = await json<Memo>(foreignResponse)
    const refused = await call('PUT', `/api/memos/${memo.id}/relations`, {
      body: { relatedMemoIds: [foreign.id] },
    })
    expect(refused.status).toBe(400)
  })

  it('replaces relations through a rev guarded patch', async () => {
    const first = await createMemo({ content: 'first' })
    const second = await createMemo({ content: 'second' })
    const third = await createMemo({ content: 'third' })

    const initial = await call('PATCH', `/api/memos/${first.id}`, {
      body: { rev: 1, relatedMemoIds: [second.id, second.id, first.id] },
    })
    expect((await json<Memo>(initial)).relations.map((relation) => relation.relatedMemoId)).toEqual([second.id])

    const replaced = await call('PATCH', `/api/memos/${first.id}`, {
      body: { rev: 2, relatedMemoIds: [third.id] },
    })
    expect((await json<Memo>(replaced)).relations.map((relation) => relation.relatedMemoId)).toEqual([third.id])
  })
})

describe('memo spaces', () => {
  it('moves, unfiles, and validates space ownership', async () => {
    const first = await json<{ id: string }>(await call('POST', '/api/memos/spaces', { body: { title: 'First' } }))
    const second = await json<{ id: string }>(await call('POST', '/api/memos/spaces', { body: { title: 'Second' } }))
    const foreignSpace = await json<{ id: string }>(
      await call('POST', '/api/memos/spaces', { body: { title: 'Other' }, session: OTHER_TOKEN }),
    )

    const memo = await createMemo({ content: 'filed', spaceId: first.id })
    expect(memo.spaceId).toBe(first.id)

    const moved = await call('PATCH', `/api/memos/${memo.id}`, { body: { rev: 1, spaceId: second.id } })
    expect((await json<Memo>(moved)).spaceId).toBe(second.id)

    const unfiled = await call('PATCH', `/api/memos/${memo.id}`, { body: { rev: 2, spaceId: null } })
    expect((await json<Memo>(unfiled)).spaceId).toBeNull()

    const foreign = await call('POST', '/api/memos', { body: { content: 'x', spaceId: foreignSpace.id } })
    expect(foreign.status).toBe(400)
    const invalidMove = await call('PATCH', `/api/memos/${memo.id}`, {
      body: { rev: 3, spaceId: foreignSpace.id },
    })
    expect(invalidMove.status).toBe(400)
  })
})
