// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { memoFileRoutes } from '../src/worker/routes/memos/files'
import { createShareToken } from '../src/worker/memos/tokens'
import { testBindings, testKVNamespace, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const PUBLIC_CACHE = 'public, max-age=31536000, immutable'
const PRIVATE_CACHE = 'private, no-store'

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
  app.route('/api/memos/files', memoFileRoutes)
})

afterEach(() => sqlite.close())

function id(n: number): string {
  return String(n).padStart(26, '0')
}

async function request(path: string, init: RequestInit = {}, targetEnv: Env = env): Promise<Response> {
  return await app.request(`http://localhost${path}`, init, targetEnv)
}

function viewer(viewerId: string | null): Record<string, string> {
  return viewerId ? { 'x-test-user': viewerId } : {}
}

function insertMemo(memoId: string, visibility: 'private' | 'protected' | 'public', state = 'normal'): void {
  sqlite.prepare(
    `INSERT INTO memos_items (id, user_id, content, visibility, state, rev, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, 1, 1, 1)`,
  ).run(memoId, ALICE, visibility, state)
}

function insertAttachment(options: {
  attachmentId: string
  userId?: string
  memoId?: string | null
  mime?: string
  filename?: string
  storage?: 'r2' | 'kv'
  size?: number
  storageKey?: string
  thumbnailKey?: string | null
  motionGroupId?: string | null
  motionRole?: string | null
  createdAt?: number
  updatedAt?: number
}): void {
  const userId = options.userId ?? ALICE
  sqlite.prepare(
    `INSERT INTO memos_attachments
       (id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
        thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    options.attachmentId,
    userId,
    options.memoId ?? null,
    options.filename ?? 'file.bin',
    options.mime ?? 'application/octet-stream',
    options.size ?? 0,
    options.storage ?? 'r2',
    options.storageKey ?? `memo/${userId}/${options.attachmentId}.bin`,
    options.thumbnailKey ?? null,
    options.motionGroupId ?? null,
    options.motionRole ?? null,
    options.createdAt ?? 1,
    options.updatedAt ?? 1,
  )
}

async function putR2(key: string, bytes: Uint8Array, mime: string): Promise<void> {
  await r2.put(key, bytes, { httpMetadata: { contentType: mime } })
}

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

async function expectBody(response: Response, expected: Uint8Array): Promise<void> {
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected)
}

describe('memo file access', () => {
  it('serves the owner, public memos and signed-in protected readers only', async () => {
    insertMemo(id(1), 'private')
    insertMemo(id(2), 'protected')
    insertMemo(id(3), 'public')
    const privateBytes = textBytes('private')
    const protectedBytes = textBytes('protected')
    const publicBytes = textBytes('public')
    for (const [n, bytes, memoId] of [
      [11, privateBytes, id(1)],
      [12, protectedBytes, id(2)],
      [13, publicBytes, id(3)],
    ] as const) {
      const key = `memo/${ALICE}/${id(n)}.bin`
      await putR2(key, bytes, 'text/plain')
      insertAttachment({ attachmentId: id(n), memoId, mime: 'text/plain', storageKey: key, size: bytes.byteLength })
    }

    for (const n of [11, 12, 13]) {
      const response = await request(`/api/memos/files/${id(n)}`, { headers: viewer(ALICE) })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('cache-control')).toBe(PRIVATE_CACHE)
    }
    await expectBody(await request(`/api/memos/files/${id(11)}`, { headers: viewer(ALICE) }), privateBytes)
    await expectBody(await request(`/api/memos/files/${id(12)}`, { headers: viewer(ALICE) }), protectedBytes)
    await expectBody(await request(`/api/memos/files/${id(13)}`, { headers: viewer(ALICE) }), publicBytes)

    expect((await request(`/api/memos/files/${id(11)}`, { headers: viewer(BOB) })).status).toBe(404)
    expect((await request(`/api/memos/files/${id(12)}`, { headers: viewer(BOB) })).status).toBe(200)
    expect((await request(`/api/memos/files/${id(13)}`, { headers: viewer(BOB) })).status).toBe(200)

    expect((await request(`/api/memos/files/${id(11)}`)).status).toBe(404)
    expect((await request(`/api/memos/files/${id(12)}`)).status).toBe(404)
    const anonymousPublic = await request(`/api/memos/files/${id(13)}`)
    expect(anonymousPublic.status).toBe(200)
    expect(anonymousPublic.headers.get('cache-control')).toBe(PUBLIC_CACHE)
    await expectBody(anonymousPublic, publicBytes)
  })

  it('keeps an unbound attachment private to its owner', async () => {
    const bytes = textBytes('orphan')
    await putR2(`memo/${ALICE}/${id(20)}.bin`, bytes, 'text/plain')
    insertAttachment({ attachmentId: id(20), mime: 'text/plain', size: bytes.byteLength })

    expect((await request(`/api/memos/files/${id(20)}`)).status).toBe(404)
    expect((await request(`/api/memos/files/${id(20)}`, { headers: viewer(BOB) })).status).toBe(404)
    const owner = await request(`/api/memos/files/${id(20)}`, { headers: viewer(ALICE) })
    expect(owner.status).toBe(200)
    await expectBody(owner, bytes)
  })

  it('reads a private attachment through a live share and rejects dead shares', async () => {
    insertMemo(id(30), 'private')
    const bytes = textBytes('shared')
    const key = `memo/${ALICE}/${id(31)}.bin`
    await putR2(key, bytes, 'text/plain')
    insertAttachment({ attachmentId: id(31), memoId: id(30), mime: 'text/plain', storageKey: key, size: bytes.byteLength })
    insertMemo(id(32), 'private')
    insertAttachment({ attachmentId: id(33), memoId: id(32), mime: 'text/plain' })

    const live = await createShareToken()
    insertShare(id(34), id(30), live.hash, null, null)
    const shared = await request(`/api/memos/files/${id(31)}?share=${live.token}`)
    expect(shared.status).toBe(200)
    expect(shared.headers.get('cache-control')).toBe(PRIVATE_CACHE)
    await expectBody(shared, bytes)

    expect((await request(`/api/memos/files/${id(31)}`)).status).toBe(404)
    expect((await request(`/api/memos/files/${id(31)}?share=${'x'.repeat(43)}`)).status).toBe(404)

    const expired = await createShareToken()
    insertShare(id(35), id(30), expired.hash, Math.floor(Date.now() / 1000) - 60, null)
    expect((await request(`/api/memos/files/${id(31)}?share=${expired.token}`)).status).toBe(404)

    const revoked = await createShareToken()
    insertShare(id(36), id(30), revoked.hash, null, Math.floor(Date.now() / 1000))
    expect((await request(`/api/memos/files/${id(31)}?share=${revoked.token}`)).status).toBe(404)

    const otherMemo = await createShareToken()
    insertShare(id(37), id(32), otherMemo.hash, null, null)
    expect((await request(`/api/memos/files/${id(31)}?share=${otherMemo.token}`)).status).toBe(404)

    expect((await request(`/api/memos/files/${id(31)}?share=${'x'.repeat(300)}`)).status).toBe(404)
  })

  it('answers 404 for an unknown id, a missing object and an archived public memo', async () => {
    expect((await request(`/api/memos/files/${id(40)}`)).status).toBe(404)
    expect((await request('/api/memos/files/not-an-id')).status).toBe(404)

    insertMemo(id(41), 'private')
    insertAttachment({ attachmentId: id(42), memoId: id(41), mime: 'text/plain' })
    const missing = await request(`/api/memos/files/${id(42)}`, { headers: viewer(ALICE) })
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('not_found')

    insertMemo(id(43), 'public', 'archived')
    const bytes = textBytes('archived')
    await putR2(`memo/${ALICE}/${id(44)}.bin`, bytes, 'text/plain')
    insertAttachment({ attachmentId: id(44), memoId: id(43), mime: 'text/plain', size: bytes.byteLength })
    expect((await request(`/api/memos/files/${id(44)}`)).status).toBe(404)
    expect((await request(`/api/memos/files/${id(44)}`, { headers: viewer(BOB) })).status).toBe(404)
    expect((await request(`/api/memos/files/${id(44)}`, { headers: viewer(ALICE) })).status).toBe(200)
  })
})

describe('memo file caching and variants', () => {
  it('answers a matching If-None-Match with 304 and keeps the tag stable', async () => {
    insertMemo(id(50), 'private')
    const bytes = textBytes('etag')
    await putR2(`memo/${ALICE}/${id(51)}.bin`, bytes, 'text/plain')
    insertAttachment({ attachmentId: id(51), memoId: id(50), mime: 'text/plain', size: bytes.byteLength })

    const first = await request(`/api/memos/files/${id(51)}`, { headers: viewer(ALICE) })
    const etag = first.headers.get('etag')
    expect(etag).toBe(`"${id(51)}-1"`)

    const cached = await request(`/api/memos/files/${id(51)}`, {
      headers: { ...viewer(ALICE), 'If-None-Match': etag! },
    })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe(etag)
    expect(await cached.text()).toBe('')

    const stale = await request(`/api/memos/files/${id(51)}`, {
      headers: { ...viewer(ALICE), 'If-None-Match': '"other"' },
    })
    expect(stale.status).toBe(200)
  })

  it('serves the thumbnail when asked and falls back to the original', async () => {
    insertMemo(id(60), 'private')
    const original = textBytes('original')
    const thumbnail = jpegBytes()
    await putR2(`memo/${ALICE}/${id(61)}.bin`, original, 'text/plain')
    await putR2(`memo/${ALICE}/${id(61)}-thumb.jpg`, thumbnail, 'image/jpeg')
    insertAttachment({
      attachmentId: id(61),
      memoId: id(60),
      mime: 'text/plain',
      size: original.byteLength,
      thumbnailKey: `memo/${ALICE}/${id(61)}-thumb.jpg`,
    })

    const originalResponse = await request(`/api/memos/files/${id(61)}`, { headers: viewer(ALICE) })
    const originalEtag = originalResponse.headers.get('etag')
    const thumbResponse = await request(`/api/memos/files/${id(61)}?thumb=1`, { headers: viewer(ALICE) })
    expect(thumbResponse.status).toBe(200)
    expect(thumbResponse.headers.get('content-type')).toBe('image/jpeg')
    expect(thumbResponse.headers.get('content-disposition')).toContain('inline')
    expect(thumbResponse.headers.get('etag')).not.toBe(originalEtag)
    await expectBody(thumbResponse, thumbnail)

    insertMemo(id(62), 'private')
    const plain = textBytes('no thumb')
    await putR2(`memo/${ALICE}/${id(63)}.bin`, plain, 'text/plain')
    insertAttachment({ attachmentId: id(63), memoId: id(62), mime: 'text/plain', size: plain.byteLength })

    const fallback = await request(`/api/memos/files/${id(63)}?thumb=1`, { headers: viewer(ALICE) })
    expect(fallback.status).toBe(200)
    await expectBody(fallback, plain)
    expect(fallback.headers.get('etag')).toBe(`"${id(63)}-1"`)
  })

  it('serves the video member of a motion group and 404s without one', async () => {
    const video = new Uint8Array(24)
    new DataView(video.buffer).setUint32(0, 24)
    video.set([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 4)
    await putR2(`memo/${ALICE}/${id(71)}.bin`, textBytes('still'), 'image/jpeg')
    await putR2(`memo/${ALICE}/${id(72)}.bin`, video, 'video/mp4')
    insertAttachment({
      attachmentId: id(71),
      mime: 'image/jpeg',
      size: 5,
      motionGroupId: id(70),
      motionRole: 'still',
    })
    insertAttachment({
      attachmentId: id(72),
      mime: 'video/mp4',
      size: video.byteLength,
      motionGroupId: id(70),
      motionRole: 'video',
    })

    const motion = await request(`/api/memos/files/${id(71)}?motion=1`, { headers: viewer(ALICE) })
    expect(motion.status).toBe(200)
    expect(motion.headers.get('content-type')).toBe('video/mp4')
    expect(motion.headers.get('content-disposition')).toContain('inline')
    await expectBody(motion, video)

    const self = await request(`/api/memos/files/${id(72)}?motion=1`, { headers: viewer(ALICE) })
    expect(self.status).toBe(200)
    await expectBody(self, video)

    insertAttachment({ attachmentId: id(73), mime: 'image/jpeg' })
    expect((await request(`/api/memos/files/${id(73)}?motion=1`, { headers: viewer(ALICE) })).status).toBe(404)
  })

  it('marks download-only types and leaves images inline', async () => {
    insertMemo(id(80), 'public')
    const cases = [
      { n: 81, mime: 'image/png', bytes: pngBytes(), disposition: 'inline' },
      { n: 82, mime: 'image/svg+xml', bytes: textBytes('<svg/>'), disposition: 'attachment' },
      { n: 83, mime: 'application/pdf', bytes: textBytes('%PDF-1.7'), disposition: 'attachment' },
    ]
    for (const item of cases) {
      const key = `memo/${ALICE}/${id(item.n)}.bin`
      await putR2(key, item.bytes, item.mime)
      insertAttachment({
        attachmentId: id(item.n),
        memoId: id(80),
        mime: item.mime,
        size: item.bytes.byteLength,
        storageKey: key,
      })
    }

    for (const item of cases) {
      const response = await request(`/api/memos/files/${id(item.n)}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(item.mime)
      expect(response.headers.get('content-disposition')).toContain(item.disposition)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE)
      expect(response.headers.get('accept-ranges')).toBe('bytes')
    }
  })
})

describe('memo file ranges', () => {
  it('serves a single byte range, a suffix and 416 for an impossible range', async () => {
    const kv = testKVNamespace()
    const kvEnv = testBindings(db, { FILES_KV: kv })
    const bytes = textBytes('0123456789')
    const key = `memo/${ALICE}/${id(91)}.bin`
    await kv.put(key, bytes, { metadata: { mime: 'video/mp4' } })
    insertAttachment({
      attachmentId: id(91),
      mime: 'video/mp4',
      storage: 'kv',
      storageKey: key,
      size: bytes.byteLength,
    })

    const ranged = await request(`/api/memos/files/${id(91)}`, {
      headers: { ...viewer(ALICE), Range: 'bytes=2-5' },
    }, kvEnv)
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(ranged.headers.get('content-length')).toBe('4')
    expect(ranged.headers.get('accept-ranges')).toBe('bytes')
    expect(await ranged.text()).toBe('2345')

    const suffix = await request(`/api/memos/files/${id(91)}`, {
      headers: { ...viewer(ALICE), Range: 'bytes=-3' },
    }, kvEnv)
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(await suffix.text()).toBe('789')

    for (const range of ['bytes=10-', 'bytes=0-1,3-4', 'bytes=nope']) {
      const unsupported = await request(`/api/memos/files/${id(91)}`, {
        headers: { ...viewer(ALICE), Range: range },
      }, kvEnv)
      expect(unsupported.status).toBe(416)
      expect(unsupported.headers.get('content-range')).toBe('bytes */10')
    }
  })
})

function insertShare(
  shareId: string,
  memoId: string,
  tokenHash: string,
  expiresAt: number | null,
  revokedAt: number | null,
): void {
  sqlite.prepare(
    `INSERT INTO memos_shares (id, user_id, memo_id, token_hash, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(shareId, ALICE, memoId, tokenHash, expiresAt, revokedAt)
}
