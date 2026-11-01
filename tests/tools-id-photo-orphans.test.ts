// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TOOLS_ID_PHOTO_ORPHAN_SCHEMA_STATEMENTS,
  TOOLS_ID_PHOTO_SCHEMA_STATEMENTS,
} from '../src/worker/tools/id-photo/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsIdPhotoRoutes } from '../src/worker/routes/tools-id-photo'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

interface Flaky {
  env: Env
  bucket: ReturnType<typeof testR2Bucket>
  refuse(pattern: (key: string) => boolean): void
  stopRefusing(): void
}

function flakyBucket(): Omit<Flaky, 'env'> {
  const bucket = testR2Bucket()
  const original = bucket.delete.bind(bucket)
  let matcher: ((key: string) => boolean) | null = null

  bucket.delete = async (keys: string | string[]): Promise<void> => {
    const list = Array.isArray(keys) ? keys : [keys]
    if (matcher && list.some(matcher)) {
      // A real bucket refuses the whole call, so nothing is removed on a refused delete.
      throw new Error('bucket_unavailable')
    }
    await original(list)
  }

  return {
    bucket,
    refuse: (pattern) => {
      matcher = pattern
    },
    stopRefusing: () => {
      matcher = null
    },
  }
}

let sqlite: DatabaseSync
let flaky: Flaky
let app: Hono<AppBindings>

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('/api/tools/id-photo/*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: userId,
        login: userId,
        name: userId,
        avatarUrl: '',
        role: 'member',
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  instance.route('/api/tools/id-photo', toolsIdPhotoRoutes)
  return instance
}

async function call(method: string, path: string, user = USER_A, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'x-test-user': user, 'X-Inkstone-Client': '1' }
  let payload: BodyInit | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body: payload }), flaky.env)
}

async function archivePhoto(user: string): Promise<{ id: string; key: string }> {
  const jpegBytes = [0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode('fake-jpeg-photo-bytes')]
  const res = await call('POST', '/api/tools/id-photo/records', user, {
    title: 'photo',
    specId: 'cn_one_inch',
    specName: '标准一寸',
    widthPx: 295,
    heightPx: 413,
    widthMm: 25,
    heightMm: 35,
    dpi: 300,
    bgColor: '#ffffff',
    options: {},
    fileData: 'data:image/jpeg;base64,' + btoa(String.fromCharCode(...jpegBytes)),
    fileType: 'jpg',
  })
  expect(res.status).toBe(201)
  const json = (await res.json()) as { data: { id: string; r2Key: string } }
  return { id: json.data.id, key: json.data.r2Key }
}

async function listData(user = USER_A): Promise<{ total: number; orphansPending: number }> {
  const res = await call('GET', '/api/tools/id-photo/records', user)
  expect(res.status).toBe(200)
  const json = (await res.json()) as { data: { total: number; orphansPending: number } }
  return json.data
}

describe('ID photo orphan storage queue', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of [...TOOLS_ID_PHOTO_SCHEMA_STATEMENTS, ...TOOLS_ID_PHOTO_ORPHAN_SCHEMA_STATEMENTS]) {
      sqlite.exec(statement)
    }
    const holder = flakyBucket()
    flaky = { ...holder, env: testBindings(makeD1(sqlite), { FILES: holder.bucket }) }
    app = buildApp()
  })

  afterEach(() => {
    sqlite.close()
  })

  it('queues the key when the bucket refuses the delete', async () => {
    const { id, key } = await archivePhoto(USER_A)
    expect(flaky.bucket.objects.has(key)).toBe(true)

    flaky.refuse((candidate) => candidate === key)
    const res = await call('DELETE', `/api/tools/id-photo/records/${id}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { deleted: boolean; storageCleaned: boolean; orphansQueued: number } }
    expect(json.data.deleted).toBe(true)
    expect(json.data.storageCleaned).toBe(false)
    expect(json.data.orphansQueued).toBe(1)

    // The row is gone but the bytes are still billed, which is exactly what the queue remembers.
    expect((await listData()).total).toBe(0)
    expect(flaky.bucket.objects.has(key)).toBe(true)
  })

  it('reclaims the queued object on the next archive read', async () => {
    const { id, key } = await archivePhoto(USER_A)
    flaky.refuse((candidate) => candidate === key)
    await call('DELETE', `/api/tools/id-photo/records/${id}`)
    flaky.stopRefusing()

    expect((await listData()).orphansPending).toBe(0)
    expect(flaky.bucket.objects.has(key)).toBe(false)
  })

  it('keeps trying without piling up duplicates while the bucket refuses', async () => {
    const { id, key } = await archivePhoto(USER_A)
    flaky.refuse((candidate) => candidate === key)

    await call('DELETE', `/api/tools/id-photo/records/${id}`)
    expect((await listData()).orphansPending).toBe(1)
    expect((await listData()).orphansPending).toBe(1)
    expect((await listData()).orphansPending).toBe(1)
    expect(flaky.bucket.objects.has(key)).toBe(true)
  })

  it('drains one bounded batch per read', async () => {
    const keys: string[] = []
    flaky.refuse(() => true)
    for (let index = 0; index < 9; index += 1) {
      const { id, key } = await archivePhoto(USER_A)
      await call('DELETE', `/api/tools/id-photo/records/${id}`)
      keys.push(key)
    }
    flaky.stopRefusing()

    await listData()
    const clearedNow = keys.filter((key) => !flaky.bucket.objects.has(key))
    expect(clearedNow).toHaveLength(8)
    expect((await listData()).orphansPending).toBe(0)
    expect(keys.filter((key) => !flaky.bucket.objects.has(key))).toHaveLength(9)
  })

  it('never touches another account\'s queue', async () => {
    const { id, key } = await archivePhoto(USER_A)
    flaky.refuse((candidate) => candidate === key)
    await call('DELETE', `/api/tools/id-photo/records/${id}`)
    flaky.stopRefusing()

    // Bob reading his archive must not clear (or keep) Alice\'s object.
    expect((await listData(USER_B)).orphansPending).toBe(0)
    expect(flaky.bucket.objects.has(key)).toBe(true)

    expect((await listData(USER_A)).orphansPending).toBe(0)
    expect(flaky.bucket.objects.has(key)).toBe(false)
  })
})
