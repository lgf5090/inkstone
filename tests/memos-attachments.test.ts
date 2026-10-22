// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { MEMO_ATTACHMENT_MAX_BYTES } from '../src/shared/memos/constants'
import { initializeDatabase } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import {
  MemoAttachmentError,
  saveMemoAttachment,
  type SaveMemoAttachmentInput,
} from '../src/worker/memos/attachments'
import { memoAttachmentRoutes } from '../src/worker/routes/memos/attachments'
import {
  testBindings,
  testKVNamespace,
  testR2Bucket,
  type TestR2Bucket,
} from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const CAROL = 'user-carol'

let sqlite: DatabaseSync
let db: D1Database
let r2: TestR2Bucket
let env: Env
let app: Hono<AppBindings>

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  db = makeD1(sqlite)
  await initializeDatabase({ DB: db } as Env)
  r2 = testR2Bucket()
  env = testBindings(db, { FILES: r2 })
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) c.set('userId', userId)
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/memos/attachments', memoAttachmentRoutes)
})

afterEach(() => sqlite.close())

function id(n: number): string {
  return String(n).padStart(26, '0')
}

async function request(path: string, init: RequestInit = {}, targetEnv: Env = env): Promise<Response> {
  return await app.request(`http://localhost${path}`, init, targetEnv)
}

function pngBytes(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
}

function mp4Bytes(): Uint8Array {
  const bytes = new Uint8Array(32)
  new DataView(bytes.buffer).setUint32(0, 32)
  bytes.set([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 4)
  return bytes
}

function mp3Bytes(): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
}

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n')
}

interface UploadOptions {
  filename?: string
  mime?: string
  memoId?: string
  metadata?: unknown
  thumbnail?: { bytes: Uint8Array; mime?: string; filename?: string }
  motionGroupId?: string
  motionRole?: string
}

async function upload(
  userId: string,
  bytes: Uint8Array,
  options: UploadOptions = {},
  targetEnv: Env = env,
): Promise<Response> {
  const form = new FormData()
  form.set(
    'file',
    new File([bytes as BlobPart], options.filename ?? 'photo.png', {
      type: options.mime ?? 'image/png',
    }),
  )
  if (options.thumbnail) {
    form.set(
      'thumbnail',
      new File([options.thumbnail.bytes as BlobPart], options.thumbnail.filename ?? 'thumb.jpg', {
        type: options.thumbnail.mime ?? 'image/jpeg',
      }),
    )
  }
  if (options.memoId) form.set('memoId', options.memoId)
  if (options.metadata !== undefined) form.set('metadata', JSON.stringify(options.metadata))
  if (options.motionGroupId) form.set('motionGroupId', options.motionGroupId)
  if (options.motionRole) form.set('motionRole', options.motionRole)
  return request('/api/memos/attachments', {
    method: 'POST',
    headers: { 'x-test-user': userId },
    body: form,
  }, targetEnv)
}

function insertMemo(
  memoId: string,
  userId: string,
  options: { content?: string; title?: string; snippet?: string; spaceId?: string | null } = {},
): void {
  sqlite.prepare(
    `INSERT INTO memos_items
       (id, user_id, space_id, content, title, snippet, visibility, state, rev, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'private', 'normal', 1, 1, 1)`,
  ).run(
    memoId,
    userId,
    options.spaceId ?? null,
    options.content ?? '',
    options.title ?? '',
    options.snippet ?? '',
  )
}

function insertAttachmentRow(
  attachmentId: string,
  userId: string,
  size: number,
  options: { storage?: 'r2' | 'kv'; memoId?: string | null } = {},
): void {
  sqlite.prepare(
    `INSERT INTO memos_attachments
       (id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
        thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at)
     VALUES (?, ?, ?, 'file.bin', 'application/octet-stream', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 1, 1)`,
  ).run(
    attachmentId,
    userId,
    options.memoId ?? null,
    size,
    options.storage ?? 'r2',
    `memos/${userId}/${attachmentId}.bin`,
  )
}

function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return sqlite.prepare(sql).get(...(params as never[])) as T | undefined
}

describe('memo attachment uploads', () => {
  it('stores an image with a thumbnail and its metadata', async () => {
    const response = await upload(ALICE, pngBytes(4, 5), {
      thumbnail: { bytes: jpegBytes() },
      metadata: { photo: { width: 4, height: 5, cameraMake: 'Canon' } },
    })
    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body.mime).toBe('image/png')
    expect(body.width).toBe(4)
    expect(body.height).toBe(5)
    expect(body.thumbnailUrl).toBe(`/api/memos/files/${body.id}?thumb=1`)
    expect((body.mediaMetadata as { photo: { cameraMake: string } }).photo.cameraMake).toBe('Canon')

    const row = one<{ storage: string; storage_key: string; thumbnail_key: string }>(
      'SELECT storage, storage_key, thumbnail_key FROM memos_attachments WHERE id = ?',
      body.id,
    )!
    expect(row.storage).toBe('r2')
    expect(row.storage_key).toMatch(new RegExp(`^memos/${ALICE}/[0-9a-z]{26}\\.png$`))
    expect(row.thumbnail_key).toMatch(/-thumb\.jpg$/)
    expect(r2.objects.has(row.storage_key)).toBe(true)
    expect(r2.objects.has(row.thumbnail_key)).toBe(true)
    expect(r2.types.get(row.storage_key)).toBe('image/png')
    expect(r2.types.get(row.thumbnail_key)).toBe('image/jpeg')
    expect(r2.metadata.get(row.storage_key)?.kind).toBe('memo')
  })

  it('downgrades a file whose magic does not match the image type', async () => {
    const response = await upload(ALICE, new TextEncoder().encode('not an image'), {
      mime: 'image/png',
    })
    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body.mime).toBe('application/octet-stream')
    expect(body.width).toBeNull()
    expect(body.height).toBeNull()
  })

  it('accepts empty media metadata', async () => {
    const response = await upload(ALICE, pngBytes(), { metadata: {} })
    expect(response.status).toBe(201)
    expect((await response.json() as Record<string, unknown>).mediaMetadata).toEqual({})
  })

  it('accepts an mp4 only when the container signature is present', async () => {
    const accepted = await upload(ALICE, mp4Bytes(), { filename: 'clip.mp4', mime: 'video/mp4' })
    expect(accepted.status).toBe(201)
    expect((await accepted.json() as Record<string, unknown>).mime).toBe('video/mp4')

    const rejected = await upload(ALICE, pngBytes(), { filename: 'fake.mp4', mime: 'video/mp4' })
    expect(rejected.status).toBe(201)
    expect((await rejected.json() as Record<string, unknown>).mime).toBe('application/octet-stream')
  })

  it('rejects a thumbnail that is not an image and leaves nothing behind', async () => {
    const response = await upload(ALICE, pngBytes(), {
      thumbnail: { bytes: new TextEncoder().encode('text'), mime: 'image/jpeg' },
    })
    expect(response.status).toBe(400)
    expect(one<{ count: number }>('SELECT COUNT(*) AS count FROM memos_attachments')?.count).toBe(0)
    expect(r2.objects.size).toBe(0)
  })

  it('rejects an oversized file before touching storage', async () => {
    const input: SaveMemoAttachmentInput = {
      id: id(1),
      userId: ALICE,
      memoId: null,
      filename: 'large.bin',
      reportedMime: 'application/octet-stream',
      bytes: new Uint8Array(MEMO_ATTACHMENT_MAX_BYTES + 1),
      thumbnail: null,
      mediaMetadata: null,
      motionGroupId: null,
      motionRole: null,
      createdAt: 1,
    }
    await expect(saveMemoAttachment(env, input)).rejects.toMatchObject({
      name: 'MemoAttachmentError',
      status: 413,
      code: 'memo_attachment_too_large',
    } satisfies Partial<MemoAttachmentError>)
    expect(r2.objects.size).toBe(0)
  })

  it('refuses a memo that belongs to another account', async () => {
    insertMemo(id(10), BOB, { title: 'Bob memo' })
    const response = await upload(ALICE, pngBytes(), { memoId: id(10) })
    expect(response.status).toBe(400)
    expect(one<{ count: number }>('SELECT COUNT(*) AS count FROM memos_attachments')?.count).toBe(0)
  })

  it('counts bytes from both attachment tables against one quota', async () => {
    sqlite.prepare(
      `INSERT INTO attachments (id, user_id, note_id, filename, mime, size, sha256, storage, created_at)
       VALUES (?, ?, NULL, 'note.bin', 'application/octet-stream', ?, 'hash', 'r2', 1)`,
    ).run(id(20), ALICE, Math.floor(LIMITS.attachmentQuotaBytes * 0.6))
    insertAttachmentRow(id(21), ALICE, Math.floor(LIMITS.attachmentQuotaBytes * 0.5))

    const rejected = await upload(ALICE, pngBytes())
    expect(rejected.status).toBe(413)
    expect(await rejected.json()).toEqual({
      error: {
        code: 'memo_attachment_quota',
        message: 'The account attachment quota has been reached',
      },
    })

    sqlite.prepare(
      `INSERT INTO attachments (id, user_id, note_id, filename, mime, size, sha256, storage, created_at)
       VALUES (?, ?, NULL, 'note.bin', 'application/octet-stream', ?, 'hash', 'r2', 1)`,
    ).run(id(22), CAROL, Math.floor(LIMITS.attachmentQuotaBytes * 0.6))
    const accepted = await upload(CAROL, pngBytes())
    expect(accepted.status).toBe(201)
  })

  it('shares the 100 uploads per hour budget with the notes uploader', async () => {
    const now = Date.now()
    sqlite.prepare(
      `INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
       VALUES (?, 100, ?, ?)`,
    ).run(`attachment-upload:${ALICE}`, now, now + 60 * 60 * 1000)

    const response = await upload(ALICE, pngBytes())
    expect(response.status).toBe(429)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('too_many_attempts')
  })
})

describe('memo attachment library', () => {
  it('filters by scope, memo and cursor and hides another account', async () => {
    insertMemo(id(30), ALICE, { title: 'Trip', snippet: 'By the sea' })
    const image = await upload(ALICE, pngBytes(), { filename: 'photo.png', mime: 'image/png' })
    const video = await upload(ALICE, mp4Bytes(), {
      filename: 'clip.mp4',
      mime: 'video/mp4',
      memoId: id(30),
    })
    const audio = await upload(ALICE, mp3Bytes(), { filename: 'voice.mp3', mime: 'audio/mpeg' })
    const pdf = await upload(ALICE, pdfBytes(), { filename: 'doc.pdf', mime: 'application/pdf' })
    for (const response of [image, video, audio, pdf]) expect(response.status).toBe(201)

    const imageId = (await image.json() as { id: string }).id
    const videoId = (await video.json() as { id: string }).id
    const media = await request('/api/memos/attachments?scope=media', {
      headers: { 'x-test-user': ALICE },
    })
    expect(media.status).toBe(200)
    const mediaBody = await media.json() as { items: Array<{ id: string }> }
    expect(mediaBody.items.map((item) => item.id).sort()).toEqual([imageId, videoId].sort())

    const audioPage = await request('/api/memos/attachments?scope=audio', {
      headers: { 'x-test-user': ALICE },
    })
    expect((await audioPage.json() as { items: unknown[] }).items).toHaveLength(1)

    const documents = await request('/api/memos/attachments?scope=documents', {
      headers: { 'x-test-user': ALICE },
    })
    expect((await documents.json() as { items: unknown[] }).items).toHaveLength(1)

    const unused = await request('/api/memos/attachments?scope=unused', {
      headers: { 'x-test-user': ALICE },
    })
    expect((await unused.json() as { items: unknown[] }).items).toHaveLength(3)

    const bound = await request(`/api/memos/attachments?memoId=${id(30)}`, {
      headers: { 'x-test-user': ALICE },
    })
    const boundBody = await bound.json() as {
      items: Array<{ memo: { id: string; title: string; snippet: string } | null }>
    }
    expect(boundBody.items).toHaveLength(1)
    expect(boundBody.items[0]!.memo).toEqual({ id: id(30), title: 'Trip', snippet: 'By the sea' })

    const first = await request('/api/memos/attachments?limit=2', {
      headers: { 'x-test-user': ALICE },
    })
    const firstBody = await first.json() as { items: unknown[]; nextCursor: string }
    expect(firstBody.items).toHaveLength(2)
    expect(firstBody.nextCursor).toEqual(expect.any(String))
    const second = await request(
      `/api/memos/attachments?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: { 'x-test-user': ALICE } },
    )
    const secondBody = await second.json() as { items: unknown[]; nextCursor: string | null }
    expect(secondBody.items).toHaveLength(2)
    expect(secondBody.nextCursor).toBeNull()

    const foreign = await request('/api/memos/attachments', { headers: { 'x-test-user': BOB } })
    expect((await foreign.json() as { items: unknown[] }).items).toHaveLength(0)
  })

  it('scopes the library to a single space and validates the space id', async () => {
    const spaceA = id(80)
    const spaceB = id(81)
    insertMemo(id(82), ALICE, { spaceId: spaceA, title: 'Alpha' })
    insertMemo(id(83), ALICE, { spaceId: spaceB, title: 'Beta' })

    const uploads = [
      await upload(ALICE, pngBytes(), { filename: 'alpha.png', mime: 'image/png', memoId: id(82) }),
      await upload(ALICE, pdfBytes(), { filename: 'alpha.pdf', mime: 'application/pdf', memoId: id(82) }),
      await upload(ALICE, mp4Bytes(), { filename: 'beta.mp4', mime: 'video/mp4', memoId: id(83) }),
      await upload(ALICE, mp3Bytes(), { filename: 'beta.mp3', mime: 'audio/mpeg', memoId: id(83) }),
      await upload(ALICE, pngBytes(), { filename: 'free.png', mime: 'image/png' }),
    ]
    for (const response of uploads) expect(response.status).toBe(201)

    const filenames = async (query: string, userId = ALICE): Promise<string[]> => {
      const response = await request(`/api/memos/attachments${query}`, {
        headers: { 'x-test-user': userId },
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { items: Array<{ filename: string }> }
      return body.items.map((item) => item.filename).sort()
    }

    expect(await filenames(`?spaceId=${spaceA}`)).toEqual(['alpha.pdf', 'alpha.png'])
    expect(await filenames(`?spaceId=${spaceA}&scope=media`)).toEqual(['alpha.png'])
    expect(await filenames(`?spaceId=${spaceA}&scope=audio`)).toEqual([])
    expect(await filenames(`?spaceId=${spaceA}&scope=documents`)).toEqual(['alpha.pdf'])
    expect(await filenames(`?spaceId=${spaceA}&scope=unused`)).toEqual([])

    expect(await filenames(`?spaceId=${spaceB}`)).toEqual(['beta.mp3', 'beta.mp4'])
    expect(await filenames(`?spaceId=${spaceB}&scope=media`)).toEqual(['beta.mp4'])
    expect(await filenames(`?spaceId=${spaceB}&scope=audio`)).toEqual(['beta.mp3'])
    expect(await filenames(`?spaceId=${spaceB}&scope=documents`)).toEqual([])
    expect(await filenames(`?spaceId=${spaceB}&scope=unused`)).toEqual([])

    expect(await filenames(`?spaceId=${spaceA}&memoId=${id(82)}`)).toEqual(['alpha.pdf', 'alpha.png'])
    expect(await filenames(`?spaceId=${spaceB}&memoId=${id(82)}`)).toEqual([])

    expect(await filenames('')).toEqual(['alpha.pdf', 'alpha.png', 'beta.mp3', 'beta.mp4', 'free.png'])
    expect(await filenames('?scope=unused')).toEqual(['free.png'])

    expect(await filenames(`?spaceId=${spaceA}`, BOB)).toEqual([])
    expect(await filenames(`?spaceId=${spaceA}`, CAROL)).toEqual([])

    const invalid = await request('/api/memos/attachments?spaceId=nope', {
      headers: { 'x-test-user': ALICE },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      error: { code: 'bad_request', message: 'Invalid space id' },
    })
  })

  it('rejects an unknown scope and a corrupt cursor', async () => {
    const scope = await request('/api/memos/attachments?scope=video', {
      headers: { 'x-test-user': ALICE },
    })
    expect(scope.status).toBe(400)
    const cursor = await request('/api/memos/attachments?cursor=%25%25', {
      headers: { 'x-test-user': ALICE },
    })
    expect(cursor.status).toBe(400)
  })

  it('returns metadata only to its owner', async () => {
    const response = await upload(ALICE, pngBytes())
    const body = await response.json() as { id: string }

    const own = await request(`/api/memos/attachments/${body.id}`, {
      headers: { 'x-test-user': ALICE },
    })
    expect(own.status).toBe(200)
    expect((await own.json() as { id: string }).id).toBe(body.id)

    const foreign = await request(`/api/memos/attachments/${body.id}`, {
      headers: { 'x-test-user': BOB },
    })
    expect(foreign.status).toBe(404)

    const anonymous = await request(`/api/memos/attachments/${body.id}`)
    expect(anonymous.status).toBe(401)
  })
})

describe('memo attachment deletion', () => {
  it('refuses to delete an attachment a memo still renders', async () => {
    insertMemo(id(40), ALICE)
    const created = await upload(ALICE, pngBytes(), { memoId: id(40) })
    const body = await created.json() as { id: string }
    sqlite.prepare('UPDATE memos_items SET content = ? WHERE id = ?')
      .run(`![shot](/api/memos/files/${body.id})`, id(40))

    const refused = await request(`/api/memos/attachments/${body.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': ALICE },
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: {
        code: 'memo_attachment_in_use',
        message: `Attachment ${body.id} is still used by memo ${id(40)}`,
        details: { attachmentId: body.id, memoId: id(40) },
      },
    })
    expect(one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memos_attachments WHERE id = ?',
      body.id,
    )?.count).toBe(1)

    sqlite.prepare('UPDATE memos_items SET content = ? WHERE id = ?').run('', id(40))
    const deleted = await request(`/api/memos/attachments/${body.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': ALICE },
    })
    expect(deleted.status).toBe(200)
    expect(one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memos_attachments WHERE id = ?',
      body.id,
    )?.count).toBe(0)
    const key = `memos/${ALICE}/${body.id}.png`
    expect(r2.objects.has(key)).toBe(false)
  })

  it('returns 404 for another account and for an unknown id', async () => {
    const created = await upload(ALICE, pngBytes())
    const body = await created.json() as { id: string }
    for (const [viewer, target] of [[BOB, body.id], [ALICE, id(99)]] as const) {
      const response = await request(`/api/memos/attachments/${target}`, {
        method: 'DELETE',
        headers: { 'x-test-user': viewer },
      })
      expect(response.status).toBe(404)
    }
  })

  it('deletes the thumbnail object with its attachment', async () => {
    const created = await upload(ALICE, pngBytes(), { thumbnail: { bytes: jpegBytes() } })
    const body = await created.json() as { id: string }
    const row = one<{ storage_key: string; thumbnail_key: string }>(
      'SELECT storage_key, thumbnail_key FROM memos_attachments WHERE id = ?',
      body.id,
    )!
    expect(r2.objects.has(row.storage_key)).toBe(true)
    expect(r2.objects.has(row.thumbnail_key)).toBe(true)

    const deleted = await request(`/api/memos/attachments/${body.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': ALICE },
    })
    expect(deleted.status).toBe(200)
    expect(r2.objects.has(row.storage_key)).toBe(false)
    expect(r2.objects.has(row.thumbnail_key)).toBe(false)
  })

  it('deletes a batch atomically when one member is in use', async () => {
    insertMemo(id(50), ALICE)
    const bound = await upload(ALICE, pngBytes(), { memoId: id(50) })
    const boundBody = await bound.json() as { id: string }
    const free = await upload(ALICE, jpegBytes(), { filename: 'photo.jpg', mime: 'image/jpeg' })
    const freeBody = await free.json() as { id: string }
    sqlite.prepare('UPDATE memos_items SET content = ? WHERE id = ?')
      .run(`[file](/api/memos/files/${boundBody.id}?thumb=1)`, id(50))

    const refused = await request('/api/memos/attachments/batch-delete', {
      method: 'POST',
      headers: { 'x-test-user': ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [boundBody.id, freeBody.id] }),
    })
    expect(refused.status).toBe(409)
    expect(one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memos_attachments WHERE user_id = ?',
      ALICE,
    )?.count).toBe(2)

    const removed = await request('/api/memos/attachments/batch-delete', {
      method: 'POST',
      headers: { 'x-test-user': ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [freeBody.id] }),
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ deleted: 1, freedBytes: jpegBytes().byteLength })
    expect(r2.objects.has(`memos/${ALICE}/${freeBody.id}.jpg`)).toBe(false)
  })

  it('validates the batch size and ids', async () => {
    const empty = await request('/api/memos/attachments/batch-delete', {
      method: 'POST',
      headers: { 'x-test-user': ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    })
    expect(empty.status).toBe(400)

    const tooMany = await request('/api/memos/attachments/batch-delete', {
      method: 'POST',
      headers: { 'x-test-user': ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from({ length: 101 }, (_, index) => id(index)) }),
    })
    expect(tooMany.status).toBe(400)

    const invalid = await request('/api/memos/attachments/batch-delete', {
      method: 'POST',
      headers: { 'x-test-user': ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['nope'] }),
    })
    expect(invalid.status).toBe(400)
  })

  it('deletes every member of a motion group', async () => {
    const groupId = id(60)
    const still = await upload(ALICE, jpegBytes(), {
      filename: 'live.jpg',
      mime: 'image/jpeg',
      motionGroupId: groupId,
      motionRole: 'still',
    })
    const stillBody = await still.json() as { id: string }
    const video = await upload(ALICE, mp4Bytes(), {
      filename: 'live.mp4',
      mime: 'video/mp4',
      motionGroupId: groupId,
      motionRole: 'video',
    })
    const videoBody = await video.json() as { id: string }

    const response = await request(`/api/memos/attachments/${stillBody.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': ALICE },
    })
    expect(response.status).toBe(200)
    expect(one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memos_attachments WHERE user_id = ?',
      ALICE,
    )?.count).toBe(0)
    expect(r2.objects.has(`memos/${ALICE}/${videoBody.id}.mp4`)).toBe(false)
  })

  it('prunes only unbound attachments', async () => {
    insertMemo(id(70), ALICE)
    const bound = await upload(ALICE, mp4Bytes(), {
      filename: 'clip.mp4',
      mime: 'video/mp4',
      memoId: id(70),
    })
    const boundBody = await bound.json() as { id: string }
    const unused = await upload(ALICE, pngBytes())
    const unusedBody = await unused.json() as { id: string }

    const response = await request('/api/memos/attachments/prune', {
      method: 'POST',
      headers: { 'x-test-user': ALICE },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: 1, freedBytes: pngBytes().byteLength })
    expect(one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memos_attachments WHERE user_id = ?',
      ALICE,
    )?.count).toBe(1)
    expect(r2.objects.has(`memos/${ALICE}/${unusedBody.id}.png`)).toBe(false)
    expect(r2.objects.has(`memos/${ALICE}/${boundBody.id}.mp4`)).toBe(true)
  })
})

describe('memo attachment storage backends', () => {
  it('round trips through Workers KV', async () => {
    const kv = testKVNamespace()
    const kvEnv = testBindings(db, { FILES_KV: kv })
    const created = await upload(ALICE, pngBytes(), {}, kvEnv)
    expect(created.status).toBe(201)
    const body = await created.json() as { id: string }
    const row = one<{ storage: string; storage_key: string }>(
      'SELECT storage, storage_key FROM memos_attachments WHERE id = ?',
      body.id,
    )!
    expect(row.storage).toBe('kv')
    expect(await kv.get(row.storage_key)).not.toBeNull()

    const deleted = await request(`/api/memos/attachments/${body.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': ALICE },
    }, kvEnv)
    expect(deleted.status).toBe(200)
    expect(await kv.get(row.storage_key)).toBeNull()
  })
})
