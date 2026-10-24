// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MUSIC_LIMITS } from '../src/shared/music/constants'
import { MUSIC_SCHEMA_STATEMENTS } from '../src/worker/music/schema'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { MusicStore } from '../src/worker/music/store'
import {
  MUSIC_DOWNLOAD_MAX_ATTEMPTS,
  MusicDownloadStore,
} from '../src/worker/music/download-store'
import {
  MUSIC_DOWNLOAD_SLICE_BYTES,
  MusicQueue,
  kickMusicQueue,
  resolveDownloadFormat,
  runMusicDownloadSlice,
  type MusicDownloadCursor,
  type MusicSliceResult,
} from '../src/worker/music/queue'
import type { MusicProvider } from '../src/worker/music/providers/types'
import { createSession } from '../src/worker/lib/session-store'
import { errorResponse } from '../src/worker/lib/errors'
import { loadSession, requireClientHeader } from '../src/worker/middleware/auth'
import { musicDownloadRoutes } from '../src/worker/routes/music-downloads'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import {
  testBindings,
  testDurableObjectNamespace,
  testR2Bucket,
} from './doubles/bindings'

/**
 * The account ids use the app's own alphabet, because every object key and every store call validates
 * them; the first character is the only difference between the two readers.
 */
const USER_A = '0123456789abcdefghjkmnpqrs'
const USER_B = '0123456789abcdefghjkmnpqrt'
const SOURCE_URL = 'https://m1.music.126.net/audio.mp3'

/** One slice plus a tail: the second request is the one that reports the end of the file. */
const PAYLOAD = new Uint8Array(MUSIC_DOWNLOAD_SLICE_BYTES + 4096)
for (let index = 0; index < PAYLOAD.length; index++) PAYLOAD[index] = index % 251

/**
 * The provider factory the queue builds for itself is replaced here: the object under test reads the
 * account's cookie and constructs a Netease client, which must never reach the network in a test.
 */
const providerStub = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../src/worker/music/providers/netease/client', () => ({
  createNeteaseProvider: () => providerStub.current,
}))

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let store: MusicStore
let downloads: MusicDownloadStore
let otherDownloads: MusicDownloadStore
let app: Hono<AppBindings>
let tokenA: string
let tokenB: string
let fetchHandler: (request: Request) => Response | Promise<Response>

function fakeProvider(size: number | null = PAYLOAD.length): MusicProvider {
  return {
    id: 'netease',
    downloadUrl: async () => ({
      url: SOURCE_URL,
      expiresAt: Date.now() + 10 * 60 * 1000,
      format: 'mp3',
      bitrate: 320_000,
      size,
      quality: 'exhigh',
      freeTrial: false,
    }),
  } as unknown as MusicProvider
}

/** A source that honors `Range`, the shape the real CDN has. */
function rangeResponse(request: Request): Response {
  const header = request.headers.get('range')
  if (!header) {
    return new Response(PAYLOAD, {
      status: 200,
      headers: { 'content-length': String(PAYLOAD.length) },
    })
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(header)
  if (!match) return new Response('bad range', { status: 400 })
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), PAYLOAD.length - 1)
  if (start >= PAYLOAD.length) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${PAYLOAD.length}` },
    })
  }
  const slice = PAYLOAD.slice(start, end + 1)
  return new Response(slice, {
    status: 206,
    headers: {
      'content-range': `bytes ${start}-${end}/${PAYLOAD.length}`,
      'content-length': String(slice.length),
    },
  })
}

/**
 * The shared R2 double cannot resume a multipart upload, which is exactly what a queue that keeps its
 * upload id between alarms does. This wraps it with an in-memory session table so a part written by
 * one slice is completed by a later one.
 */
function multipartBucket(): { bucket: R2Bucket; objects: Map<string, Uint8Array> } {
  const base = testR2Bucket()
  const sessions = new Map<string, {
    key: string
    parts: Map<number, Uint8Array>
    options?: R2MultipartOptions
  }>()
  let sequence = 0

  const handle = (key: string, uploadId: string): R2MultipartUpload => ({
    key,
    uploadId,
    async uploadPart(partNumber, value) {
      const session = sessions.get(uploadId)
      if (!session) throw new TypeError(`no multipart session ${uploadId}`)
      const bytes = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        : new Uint8Array(await new Response(value as BodyInit).arrayBuffer())
      session.parts.set(partNumber, bytes)
      return { partNumber, etag: `etag-${partNumber}` }
    },
    async abort() {
      sessions.delete(uploadId)
    },
    async complete(parts) {
      const session = sessions.get(uploadId)
      if (!session) throw new TypeError(`no multipart session ${uploadId}`)
      const ordered = parts
        .slice()
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((part) => {
          const bytes = session.parts.get(part.partNumber)
          if (!bytes) throw new TypeError(`part ${part.partNumber} was completed but never uploaded`)
          return bytes
        })
      const assembled = new Uint8Array(ordered.reduce((sum, part) => sum + part.byteLength, 0))
      let offset = 0
      for (const part of ordered) {
        assembled.set(part, offset)
        offset += part.byteLength
      }
      sessions.delete(uploadId)
      return await base.put(key, assembled, session.options)
    },
  })

  const bucket = Object.assign({
    head: base.head.bind(base),
    get: base.get.bind(base),
    put: base.put.bind(base),
    delete: base.delete.bind(base),
    list: base.list.bind(base),
    createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
      sequence += 1
      const uploadId = `upload-${sequence}`
      sessions.set(uploadId, { key, parts: new Map(), options })
      return handle(key, uploadId)
    },
    resumeMultipartUpload: (key: string, uploadId: string) => handle(key, uploadId),
  }, { objects: base.objects }) as unknown as R2Bucket

  return { bucket, objects: base.objects }
}

/** A Durable Object state held in one map, with the alarm left readable for assertions. */
function fakeState(): { state: DurableObjectState; alarmAt: () => number | null } {
  const values = new Map<string, unknown>()
  let alarm: number | null = null
  const state = {
    storage: {
      async get(key: string) {
        return values.get(key)
      },
      async put(key: string, value: unknown) {
        values.set(key, value)
      },
      async delete(key: string) {
        return values.delete(key)
      },
      async getAlarm() {
        return alarm
      },
      async setAlarm(at: number) {
        alarm = at
        return at
      },
    },
  } as unknown as DurableObjectState
  return { state, alarmAt: () => alarm }
}

/** Byte-for-byte without vitest's deep walk over eight million entries. */
function sameBytes(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
  if (!actual || actual.byteLength !== expected.byteLength) return false
  for (let index = 0; index < expected.byteLength; index++) {
    if (actual[index] !== expected[index]) return false
  }
  return true
}

function seedUser(id: string): void {
  // The session middleware writes `last_seen_at` through the execution context; a fresh stamp keeps
  // this test's minimal context out of that branch.
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'x', ?, '', '', 'member', '{}', 1, ?)`,
  ).run(id, id, id, now)
}

async function createTrack(providerId = '42', overrides: { size?: number } = {}): Promise<string> {
  const track = await store.upsertTrack({
    provider: 'netease',
    providerId,
    title: `Song ${providerId}`,
    artists: [{ id: '7', name: 'Artist' }],
    size: overrides.size ?? PAYLOAD.length,
  })
  return track.id
}

/** Enqueue a task and return its id. */
async function enqueue(trackId: string): Promise<string> {
  const { download } = await downloads.enqueue({ trackId, quality: 'exhigh', format: 'auto' })
  return download.id
}

/** Drive the engine until it stops advancing, the way the object's alarms would. */
async function drain(
  provider: MusicProvider,
  cursor: MusicDownloadCursor | null = null,
  userId = USER_A,
): Promise<MusicSliceResult> {
  let result: MusicSliceResult = { outcome: 'idle', cursor, downloadId: null }
  for (let step = 0; step < 10; step++) {
    result = await runMusicDownloadSlice({
      env,
      userId,
      provider,
      downloads,
      musicStore: store,
      cursor: result.cursor,
    })
    if (result.outcome !== 'progress') return result
  }
  throw new Error('the download never left the progress state')
}

interface CallOptions {
  token?: string
  body?: unknown
}

async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'X-Inkstone-Client': '1' }
  if (options.token) headers.Cookie = `inkstone_session=${options.token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  return await app.request(
    `http://localhost${path}`,
    {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    env,
    {} as ExecutionContext,
  )
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  for (const statement of MUSIC_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  const files = multipartBucket()
  env = testBindings(db, {
    FILES: files.bucket,
    MUSIC_QUEUE: testDurableObjectNamespace(async () => new Response(null, { status: 204 })),
  })
  seedUser(USER_A)
  seedUser(USER_B)
  tokenA = await createSession(db, USER_A)
  tokenB = await createSession(db, USER_B)

  store = new MusicStore(db, USER_A)
  downloads = new MusicDownloadStore(db, USER_A)
  otherDownloads = new MusicDownloadStore(db, USER_B)
  providerStub.current = fakeProvider()

  fetchHandler = (request) => rangeResponse(request)
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    return fetchHandler(new Request(input instanceof Request ? input : String(input), init))
  })

  app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('/api/*', requireClientHeader)
  app.use('/api/*', loadSession)
  app.route('/api/music/downloads', musicDownloadRoutes)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('music download store', () => {
  it('is idempotent on track, quality and format', async () => {
    const trackId = await createTrack()
    const first = await downloads.enqueue({ trackId, quality: 'exhigh', format: 'auto' })
    const second = await downloads.enqueue({ trackId, quality: 'exhigh', format: 'auto' })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.download.id).toBe(first.download.id)
    expect(second.download.status).toBe('queued')

    const lossless = await downloads.enqueue({ trackId, quality: 'lossless', format: 'auto' })
    const flac = await downloads.enqueue({ trackId, quality: 'exhigh', format: 'flac' })
    expect(lossless.download.id).not.toBe(first.download.id)
    expect(flac.download.id).not.toBe(first.download.id)
    expect(await downloads.list()).toHaveLength(3)
  })

  it('never answers another account', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)
    expect(await otherDownloads.get(id)).toBeNull()
    expect(await otherDownloads.list()).toEqual([])
    expect((await otherDownloads.remove(id)).deleted).toBe(false)
    expect((await otherDownloads.requestPause(id)).download).toBeNull()
    expect((await otherDownloads.claimNextQueued(1))).toEqual([])
    expect(await downloads.get(id)).not.toBeNull()
  })

  it('joins the track snapshot onto a listed task', async () => {
    const trackId = await createTrack()
    await enqueue(trackId)
    const [entry] = await downloads.list()
    expect(entry?.trackId).toBe(trackId)
    expect(entry?.track?.title).toBe('Song 42')
    expect(entry?.track?.artists).toEqual([{ id: '7', name: 'Artist' }])
  })

  it('walks the pause, resume, cancel and retry states', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)

    expect((await downloads.requestResume(id)).changed).toBe(false)
    expect((await downloads.requestPause(id)).download?.status).toBe('paused')
    expect((await downloads.requestPause(id)).changed).toBe(false)
    expect((await downloads.requestResume(id)).download?.status).toBe('queued')

    const [claimed] = await downloads.claimNextQueued(1)
    expect(claimed?.id).toBe(id)
    expect(claimed?.attempts).toBe(1)
    expect(claimed?.status).toBe('running')

    expect((await downloads.requestCancel(id)).download?.status).toBe('canceled')
    expect((await downloads.requestCancel(id)).changed).toBe(false)

    const retried = await downloads.requestRetry(id)
    expect(retried.changed).toBe(true)
    expect(retried.download).toMatchObject({ status: 'queued', attempts: 0, progress: 0, error: '' })
    expect((await downloads.requestRetry(id)).changed).toBe(false)
  })

  it('claims the oldest task once and requeues a stale running one', async () => {
    const first = await enqueue(await createTrack('1'))
    const second = await enqueue(await createTrack('2'))

    const [claimed] = await downloads.claimNextQueued(1)
    expect(claimed?.id).toBe(first)
    const [next] = await downloads.claimNextQueued(1)
    expect(next?.id).toBe(second)
    expect(await downloads.claimNextQueued(1)).toEqual([])

    expect(await downloads.requeueStale(60_000, Date.now() + 120_000)).toBe(2)
    expect((await downloads.get(first))?.status).toBe('queued')
  })

  it('fails a task that spent its whole attempt budget', async () => {
    const id = await enqueue(await createTrack())
    for (let attempt = 1; attempt <= MUSIC_DOWNLOAD_MAX_ATTEMPTS; attempt++) {
      expect(await downloads.claimQueued(id)).not.toBeNull()
      await downloads.failAttempt(id, 'The source answered 500', true)
    }
    const failed = await downloads.get(id)
    expect(failed?.status).toBe('failed')
    expect(failed?.attempts).toBe(MUSIC_DOWNLOAD_MAX_ATTEMPTS)
    expect(failed?.error).toBe('The source answered 500')
  })
})

describe('music download slices', () => {
  it('downloads a track in slices and publishes the rows that make it playable', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)
    const provider = fakeProvider()
    const downloadUrl = vi.spyOn(provider, 'downloadUrl')

    const result = await drain(provider)
    expect(result.outcome).toBe('completed')
    expect(result.cursor).toBeNull()
    // One provider lookup serves every slice while the URL has not expired.
    expect(downloadUrl).toHaveBeenCalledTimes(1)

    const row = await downloads.get(id)
    const key = `music/mp3/${USER_A}/${trackId}-exhigh.mp3`
    expect(row).toMatchObject({
      status: 'done',
      progress: 100,
      size: PAYLOAD.length,
      r2Key: key,
      completedAt: expect.any(Number),
    })

    const bucket = env.FILES as unknown as { objects: Map<string, Uint8Array> }
    expect(sameBytes(bucket.objects.get(key), PAYLOAD)).toBe(true)

    const track = await store.getTrack(trackId)
    expect(track).toMatchObject({ r2Key: key, format: 'mp3', size: PAYLOAD.length, sourceQuality: 'exhigh' })
    const ledger = sqlite.prepare(
      `SELECT size, quality, format FROM music_object WHERE user_id = ? AND r2_key = ?`,
    ).get(USER_A, key) as { size: number; quality: string; format: string } | undefined
    expect(ledger).toEqual({ size: PAYLOAD.length, quality: 'exhigh', format: 'mp3' })
  })

  it('parks a paused task and continues it after resume', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)
    const provider = fakeProvider()

    const first = await runMusicDownloadSlice({
      env,
      userId: USER_A,
      provider,
      downloads,
      musicStore: store,
      cursor: null,
    })
    expect(first.outcome).toBe('progress')
    expect(first.cursor?.offset).toBe(MUSIC_DOWNLOAD_SLICE_BYTES)
    expect(first.cursor?.parts).toHaveLength(1)

    await downloads.requestPause(id)
    const paused = await runMusicDownloadSlice({
      env,
      userId: USER_A,
      provider,
      downloads,
      musicStore: store,
      cursor: first.cursor,
    })
    expect(paused.outcome).toBe('paused')
    expect(paused.cursor?.offset).toBe(MUSIC_DOWNLOAD_SLICE_BYTES)

    await downloads.requestResume(id)
    const resumed = await drain(provider, paused.cursor)
    expect(resumed.outcome).toBe('completed')
    expect((await downloads.get(id))?.status).toBe('done')

    const bucket = env.FILES as unknown as { objects: Map<string, Uint8Array> }
    expect(sameBytes(bucket.objects.get(`music/mp3/${USER_A}/${trackId}-exhigh.mp3`), PAYLOAD)).toBe(true)
  })

  it('releases the multipart upload when the task is canceled', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)
    const provider = fakeProvider()

    const first = await runMusicDownloadSlice({
      env,
      userId: USER_A,
      provider,
      downloads,
      musicStore: store,
      cursor: null,
    })
    expect(first.outcome).toBe('progress')
    await downloads.requestCancel(id)

    const canceled = await runMusicDownloadSlice({
      env,
      userId: USER_A,
      provider,
      downloads,
      musicStore: store,
      cursor: first.cursor,
    })
    expect(canceled.outcome).toBe('canceled')
    expect(canceled.cursor).toBeNull()
    expect((await downloads.get(id))?.status).toBe('canceled')

    const bucket = env.FILES as unknown as { objects: Map<string, Uint8Array> }
    expect(bucket.objects.size).toBe(0)
  })

  it('requeues a failed slice until the attempt budget is spent', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)
    fetchHandler = () => new Response('nope', { status: 500 })

    const statuses: string[] = []
    for (let attempt = 0; attempt < MUSIC_DOWNLOAD_MAX_ATTEMPTS; attempt++) {
      const result = await drain(fakeProvider())
      expect(result.outcome).toBe('failed')
      statuses.push((await downloads.get(id))?.status ?? 'missing')
    }
    expect(statuses).toEqual(['queued', 'queued', 'failed'])
    expect((await downloads.get(id))?.error).toContain('500')
  })

  it('refuses to publish when the account has no quota left', async () => {
    sqlite.prepare(
      `INSERT INTO music_object (user_id, r2_key, track_id, format, quality, size, sha256, created_at)
       VALUES (?, ?, NULL, 'mp3', 'exhigh', ?, '', 1)`,
    ).run(USER_A, `music/mp3/${USER_A}/existing.mp3`, MUSIC_LIMITS.quotaBytes)

    const trackId = await createTrack()
    const id = await enqueue(trackId)
    const result = await drain(fakeProvider())
    expect(result.outcome).toBe('failed')

    const row = await downloads.get(id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('quota')
    const bucket = env.FILES as unknown as { objects: Map<string, Uint8Array> }
    expect(bucket.objects.size).toBe(0)
  })

  it('names the container from the provider, not from the hint', () => {
    expect(resolveDownloadFormat('flac', 'auto')).toBe('flac')
    expect(resolveDownloadFormat('', 'm4a')).toBe('m4a')
    expect(() => resolveDownloadFormat('', 'auto')).toThrow()
  })
})

describe('music queue object', () => {
  it('accepts a kick for its own account and finishes the task across alarms', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)
    const { state, alarmAt } = fakeState()
    const queue = new MusicQueue(state, env)

    const kicked = await queue.fetch(new Request('https://music-queue.internal/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'kick', userId: USER_A, downloadId: id }),
    }))
    expect(kicked.status).toBe(204)
    expect(alarmAt()).not.toBeNull()

    for (let step = 0; step < 5; step++) {
      await queue.alarm()
      if ((await downloads.get(id))?.status === 'done') break
    }
    expect(await downloads.get(id)).toMatchObject({ status: 'done', progress: 100 })

    const rejected = await queue.fetch(new Request('https://music-queue.internal/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'kick', userId: USER_B }),
    }))
    expect(rejected.status).toBe(409)

    const malformed = await queue.fetch(new Request('https://music-queue.internal/kick', {
      method: 'POST',
      body: JSON.stringify({ action: 'kick', userId: 'nope' }),
    }))
    expect(malformed.status).toBe(400)
  })

  it('answers 503 when the deployment has no queue binding', async () => {
    await expect(kickMusicQueue(testBindings(db, { FILES: testR2Bucket() }), USER_A)).rejects.toMatchObject({
      status: 503,
      code: 'music_storage_unavailable',
    })
  })
})

describe('music download routes', () => {
  it('requires a session for every method', async () => {
    const list = await call('GET', '/api/music/downloads')
    expect(list.status).toBe(401)
    const create = await call('POST', '/api/music/downloads', {
      body: { trackId: 'x', quality: 'exhigh', format: 'auto' },
    })
    expect(create.status).toBe(401)
  })

  it('queues a task once and lists it with its track', async () => {
    const trackId = await createTrack()
    const first = await call('POST', '/api/music/downloads', {
      token: tokenA,
      body: { trackId, quality: 'exhigh', format: 'auto' },
    })
    expect(first.status).toBe(201)
    const created = await first.json() as { download: { id: string; status: string } }
    expect(created.download.status).toBe('queued')

    const again = await call('POST', '/api/music/downloads', {
      token: tokenA,
      body: { trackId, quality: 'exhigh', format: 'auto' },
    })
    expect(again.status).toBe(200)
    expect((await again.json() as { download: { id: string } }).download.id).toBe(created.download.id)

    const list = await call('GET', '/api/music/downloads', { token: tokenA })
    expect(list.status).toBe(200)
    const payload = await list.json() as { items: Array<{ id: string; track: { id: string } | null }> }
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]?.track?.id).toBe(trackId)
  })

  it('answers a foreign or unknown task id with 404', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)

    const foreignList = await call('GET', '/api/music/downloads', { token: tokenB })
    expect((await foreignList.json() as { items: unknown[] }).items).toEqual([])

    const pause = await call('PATCH', `/api/music/downloads/${id}`, {
      token: tokenB,
      body: { action: 'pause' },
    })
    expect(pause.status).toBe(404)

    const remove = await call('DELETE', `/api/music/downloads/${id}`, { token: tokenB })
    expect(remove.status).toBe(404)

    const missing = await call('PATCH', '/api/music/downloads/0123456789abcdefghjkmnprst', {
      token: tokenA,
      body: { action: 'pause' },
    })
    expect(missing.status).toBe(404)
  })

  it('rejects a track this account does not own and an unsupported action', async () => {
    const otherTrack = await new MusicStore(db, USER_B).upsertTrack({
      provider: 'netease',
      providerId: '99',
      title: 'Not mine',
    })
    const create = await call('POST', '/api/music/downloads', {
      token: tokenA,
      body: { trackId: otherTrack.id, quality: 'exhigh', format: 'auto' },
    })
    expect(create.status).toBe(404)

    const trackId = await createTrack()
    const id = await enqueue(trackId)
    const badAction = await call('PATCH', `/api/music/downloads/${id}`, {
      token: tokenA,
      body: { action: 'explode' },
    })
    expect(badAction.status).toBe(400)

    const badQuality = await call('POST', '/api/music/downloads', {
      token: tokenA,
      body: { trackId, quality: 'original', format: 'auto' },
    })
    expect(badQuality.status).toBe(400)
  })

  it('refuses when the account quota is full', async () => {
    sqlite.prepare(
      `INSERT INTO music_object (user_id, r2_key, track_id, format, quality, size, sha256, created_at)
       VALUES (?, ?, NULL, 'mp3', 'exhigh', ?, '', 1)`,
    ).run(USER_A, `music/mp3/${USER_A}/existing.mp3`, MUSIC_LIMITS.quotaBytes)

    const trackId = await createTrack()
    const response = await call('POST', '/api/music/downloads', {
      token: tokenA,
      body: { trackId, quality: 'exhigh', format: 'auto' },
    })
    expect(response.status).toBe(413)
    const payload = await response.json() as { error: { code: string } }
    expect(payload.error.code).toBe('music_quota_exceeded')
    expect(await downloads.list()).toEqual([])
  })

  it('needs storage and a queue binding', async () => {
    const trackId = await createTrack()
    const body = { trackId, quality: 'exhigh', format: 'auto' }

    app = new Hono<AppBindings>()
    app.onError((error, c) => errorResponse(c, error))
    app.use('/api/*', requireClientHeader)
    app.use('/api/*', loadSession)
    app.route('/api/music/downloads', musicDownloadRoutes)
    env = testBindings(db, {
      MUSIC_QUEUE: testDurableObjectNamespace(async () => new Response(null, { status: 204 })),
    })
    const noStorage = await call('POST', '/api/music/downloads', { token: tokenA, body })
    expect(noStorage.status).toBe(503)
    expect((await noStorage.json() as { error: { code: string } }).error.code).toBe('music_storage_unavailable')

    env = testBindings(db, { FILES: testR2Bucket() })
    const noQueue = await call('POST', '/api/music/downloads', { token: tokenA, body })
    expect(noQueue.status).toBe(503)
    expect((await noQueue.json() as { error: { code: string } }).error.code).toBe('music_storage_unavailable')
  })

  it('removes a task and keeps the library copy the track still points at', async () => {
    const trackId = await createTrack()
    const id = await enqueue(trackId)
    await drain(fakeProvider())
    const key = `music/mp3/${USER_A}/${trackId}-exhigh.mp3`
    const bucket = env.FILES as unknown as { objects: Map<string, Uint8Array> }
    expect(bucket.objects.has(key)).toBe(true)

    const removed = await call('DELETE', `/api/music/downloads/${id}`, { token: tokenA })
    expect(removed.status).toBe(200)
    expect(await downloads.get(id)).toBeNull()
    expect(bucket.objects.has(key)).toBe(true)
    expect(await store.objectReferenceCount(key)).toBe(1)

    const again = await call('DELETE', `/api/music/downloads/${id}`, { token: tokenA })
    expect(again.status).toBe(404)
  })
})
