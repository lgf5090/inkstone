import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { hashToken } from '../src/worker/lib/session-store'
import { assignParts, type PartMount } from '../src/worker/clouddrive/distributed'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER = 'user-a'
const TOKEN = 'a'.repeat(64)
const MIB = 1024 * 1024
const PART = 32 * MIB
const SIZE = PART + MIB

interface Harness {
  sqlite: DatabaseSync
  env: Env
  bucket: TestR2Bucket
  app: ReturnType<typeof createApp>
  s3Mount: string
  s3Objects: Map<string, Uint8Array>
}

async function harness(): Promise<Harness> {
  const sqlite = new DatabaseSync(':memory:')
  const bucket = testR2Bucket()
  const env = testBindings(makeD1(sqlite), { FILES: bucket })
  const app = createApp()
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'owner', 'hash', 'owner', 'Owner', '', 'owner', '{}', ?, ?)`,
  ).run(USER, now, now)
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(TOKEN), USER, now + 600_000, now)
  await app.fetch(new Request('http://localhost/api/clouddrive/health', {
    headers: { Cookie: `inkstone_session=${TOKEN}` },
  }), env)
  const storageId = '01m00000000000000000000001'
  const s3Mount = '01m00000000000000000000002'
  sqlite.prepare(
    `INSERT INTO CloudDrive_storages
       (user_id, id, name, type, config, credentials, status, is_default, api_key_visible, read_quota,
        default_path, last_used_at, last_test_at, last_test_status, created_at, updated_at)
     VALUES (?, ?, 'parts', 's3', ?, '', 'enabled', 0, 0, 0, '/', NULL, NULL, NULL, ?, ?)`,
  ).run(
    USER, storageId,
    JSON.stringify({ endpoint: 'https://s3.test', bucketName: 'bucket', region: 'auto', pathStyle: true }),
    now, now,
  )
  sqlite.prepare(
    `INSERT INTO CloudDrive_mounts
       (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight, sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'Parts', '/parts', 0, 300, 0, 'native_proxy', 1, -1, 1, ?, ?)`,
  ).run(USER, s3Mount, storageId, now, now)
  sqlite.prepare(
    `INSERT INTO CloudDrive_settings (user_id, key, value, updated_at) VALUES (?, 'upload.distributedMinBytes', ?, ?)`,
  ).run(USER, String(8 * MIB), now)
  return { sqlite, env, bucket, app, s3Mount, s3Objects: new Map() }
}

async function request(h: Harness, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return await h.app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { Cookie: `inkstone_session=${TOKEN}`, 'X-Inkstone-Client': '1', ...headers },
    body,
  }), h.env)
}

let h: Harness
let fetchMock: ReturnType<typeof vi.fn>
let failS3 = false

beforeEach(async () => {
  h = await harness()
  failS3 = false
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    const key = decodeURIComponent(url.pathname)
    if (request.method === 'PUT') {
      if (failS3 && url.hostname === 's3.test') return new Response('nope', { status: 500 })
      const bytes = new Uint8Array(await request.arrayBuffer())
      h.s3Objects.set(key, bytes)
      return new Response(null, { status: 200, headers: { etag: '"s3-etag"' } })
    }
    if (request.method === 'DELETE') {
      h.s3Objects.delete(key)
      return new Response(null, { status: 204 })
    }
    const stored = h.s3Objects.get(key)
    if (!stored) return new Response('missing', { status: 404 })
    const range = request.headers.get('range')
    if (!range) return new Response(stored.buffer as ArrayBuffer, { status: 200 })
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!match) return new Response('bad range', { status: 416 })
    const start = Number(match[1])
    const end = Number(match[2])
    return new Response(stored.slice(start, end + 1).buffer as ArrayBuffer, { status: 206 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  h.sqlite.close()
})

describe('distributed part assignment', () => {
  it('honours mount weights and stays deterministic', () => {
    const mounts: PartMount[] = [
      { id: 'primary', storageId: 'primary', storageType: 'r2', weight: 1 },
      { id: 's3', storageId: 'storage', storageType: 's3', weight: 2 },
    ]
    const plan = assignParts('session', 4, mounts)
    expect(plan.map((part) => part.mountId)).toEqual(['primary', 's3', 's3', 'primary'])
    expect(plan.map((part) => part.storageKey)).toEqual([
      'CloudDrive/parts/session/1',
      'CloudDrive/parts/session/2',
      'CloudDrive/parts/session/3',
      'CloudDrive/parts/session/4',
    ])
  })

  it('keeps parts under a storage capacity and prefixes its upload folder', () => {
    const mounts: PartMount[] = [
      { id: 'primary', storageId: 'primary', storageType: 'r2', weight: 1 },
      { id: 'a', storageId: 'sa', storageType: 's3', weight: 1, usedBytes: 900, capacityBytes: 1000 },
      { id: 'b', storageId: 'sb', storageType: 's3', weight: 1, usedBytes: 0, capacityBytes: 1000, uploadPrefix: 'uploads' },
    ]
    const plan = assignParts('session', 4, mounts, 100, 400)
    expect(plan.map((part) => part.mountId)).toEqual(['primary', 'a', 'b', 'primary'])
    expect(plan[2]!.storageKey).toBe('uploads/CloudDrive/parts/session/3')
    expect(() => assignParts('session', 1, [mounts[1]!], 200, 200)).toThrow('capacity limit')
  })
})

describe('distributed upload and read', () => {
  it('falls back to the primary mount when an S3 part write fails', async () => {
    failS3 = true
    const size = 9 * MIB
    const init = await request(h, 'POST', '/api/clouddrive/uploads', JSON.stringify({
      parentPath: '/', name: 'fallback.bin', size, mime: 'application/octet-stream',
    }), { 'Content-Type': 'application/json' })
    const session = await init.json() as { session: { id: string; strategy: string; totalParts: number } }
    expect(session.session).toMatchObject({ strategy: 'distributed', totalParts: 1 })
    const upload = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/parts/1`, new Uint8Array(size).fill(7) as unknown as BodyInit)
    expect(upload.status).toBe(200)
    const complete = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`, '{}', { 'Content-Type': 'application/json' })
    expect(complete.status).toBe(200)
    const entry = (await complete.json() as { entry: { id: string } }).entry
    const parts = h.sqlite.prepare('SELECT mount_id FROM CloudDrive_file_parts WHERE user_id = ? AND file_id = ?').all(USER, entry.id) as { mount_id: string }[]
    expect(parts).toEqual([{ mount_id: 'primary' }])
    expect(h.bucket.objects.size).toBe(1)
  }, 60_000)

  it('uploads parts across R2 and S3, reads ranges across the boundary, and purges both sides', async () => {
    const first = new Uint8Array(PART).fill(1)
    const last = new Uint8Array(MIB).fill(2)
    const init = await request(h, 'POST', '/api/clouddrive/uploads', JSON.stringify({
      parentPath: '/', name: 'big.bin', size: SIZE, mime: 'application/octet-stream',
    }), { 'Content-Type': 'application/json' })
    expect(init.status).toBe(200)
    const session = await init.json() as { session: { id: string; strategy: string; partSize: number; totalParts: number } }
    expect(session.session).toMatchObject({ strategy: 'distributed', partSize: PART, totalParts: 2 })

    const part1 = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/parts/1`, first as unknown as BodyInit)
    expect(part1.status).toBe(200)
    expect(h.s3Objects.size).toBe(1)
    const part2 = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/parts/2`, last as unknown as BodyInit)
    expect(part2.status).toBe(200)
    expect(h.bucket.objects.size).toBe(1)

    const complete = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`, '{}', {
      'Content-Type': 'application/json',
    })
    expect(complete.status).toBe(200)
    const entry = (await complete.json() as { entry: { id: string; storageKind: string; size: number } }).entry
    expect(entry).toMatchObject({ storageKind: 'distributed', size: SIZE })
    const parts = h.sqlite.prepare(
      `SELECT mount_id, size FROM CloudDrive_file_parts WHERE user_id = ? AND file_id = ? ORDER BY part_number`,
    ).all(USER, entry.id) as { mount_id: string; size: number }[]
    expect(parts).toEqual([{ mount_id: h.s3Mount, size: PART }, { mount_id: 'primary', size: MIB }])

    const full = await request(h, 'GET', `/api/clouddrive/files/${entry.id}/content`)
    expect(full.status).toBe(200)
    expect((await full.arrayBuffer()).byteLength).toBe(SIZE)

    const range = await request(h, 'GET', `/api/clouddrive/files/${entry.id}/content`, undefined, {
      Range: `bytes=${PART - 2}-${PART + 1}`,
    })
    expect(range.status).toBe(206)
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array([1, 1, 2, 2]))

    const share = await request(h, 'POST', '/api/clouddrive/shares', JSON.stringify({
      targetKind: 'file', fileId: entry.id, mountId: 'primary', path: '/big.bin', allowDownload: true,
    }), { 'Content-Type': 'application/json' })
    expect(share.status).toBe(200)
    const slug = (await share.json() as { share: { slug: string } }).share.slug
    const sharedRange = await h.app.fetch(new Request(`http://localhost/api/public/clouddrive/shares/${slug}/content`, {
      headers: { Range: `bytes=${PART - 2}-${PART + 1}` },
    }), h.env)
    expect(sharedRange.status).toBe(206)
    expect(new Uint8Array(await sharedRange.arrayBuffer())).toEqual(new Uint8Array([1, 1, 2, 2]))

    const trashed = await request(h, 'DELETE', '/api/clouddrive/files', JSON.stringify({ ids: [entry.id] }), {
      'Content-Type': 'application/json',
    })
    expect(trashed.status).toBe(200)
    const purged = await request(h, 'DELETE', '/api/clouddrive/files/purge', JSON.stringify({ ids: [entry.id] }), {
      'Content-Type': 'application/json',
    })
    expect(purged.status).toBe(200)
    expect(h.s3Objects.size).toBe(0)
    expect(h.bucket.objects.size).toBe(0)
  }, 60_000)
})
