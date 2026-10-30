// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { DatabaseSync } from 'node:sqlite'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { hashPassword } from '../src/worker/lib/password'
import { insertFile, saveSettingsGroup } from '../src/worker/imgbed/store'
import { createToken } from '../src/worker/imgbed/tokens'
import { imgbedServeRoutes } from '../src/worker/imgbed/serve'
import { imgbedDavRoutes } from '../src/worker/imgbed/dav'
import { imgbedUploadRoutes } from '../src/worker/imgbed/upload-routes'
import type { AppBindings, Env } from '../src/worker/env'

function database() {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  return { sqlite, db: makeD1(sqlite) }
}

function appFor(prefix: string, routes: Hono<AppBindings>): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.route(prefix, routes)
  return app
}

interface FileOptions {
  fileType?: string
  fileName?: string
  listType?: string
  label?: string
  body?: string
}

async function seedFile(db: D1Database, bucket: ReturnType<typeof testR2Bucket>, id: string, options: FileOptions = {}): Promise<void> {
  const fileType = options.fileType ?? 'image/png'
  const fileName = options.fileName ?? id.split('/').pop()!
  const key = `imgbed/images/${id}`
  const bytes = new TextEncoder().encode(options.body ?? 'images-bytes')
  bucket.objects.set(key, bytes)
  bucket.types.set(key, fileType)
  await insertFile(db, {
    id, objectKey: key, fileName, fileType, sizeBytes: bytes.byteLength,
    width: null, height: null, uploadIp: null, uploadAddress: null,
    listType: options.listType ?? 'None', label: options.label ?? 'None',
    source: 'cfr2', channel: 'CloudflareR2', channelName: 'R2_env', uploaderId: null, createdAt: 1,
  })
}

function serveEnvironment(): { env: Env; db: D1Database; bucket: ReturnType<typeof testR2Bucket>; app: Hono<AppBindings> } {
  const { db } = database()
  const bucket = testR2Bucket()
  return { env: testBindings(db, { FILES: bucket }), db, bucket, app: appFor('/imgbed', imgbedServeRoutes) }
}

describe('imgbed serve integration', () => {
  it('serves R2 bytes with shared headers, ranges and conditional requests', async () => {
    const { env, db, bucket, app } = serveEnvironment()
    await seedFile(db, bucket, 'photo.png')
    const response = await app.request('/imgbed/file/photo.png', {}, env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('images-bytes')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=60')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-disposition')).toContain('inline;')
    const etag = response.headers.get('etag')
    expect(etag).toBeTruthy()

    const ranged = await app.request('/imgbed/file/photo.png', { headers: { range: 'bytes=1-3' } }, env)
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('mag')
    expect(ranged.headers.get('content-range')).toBe('bytes 1-3/12')

    const cached = await app.request('/imgbed/file/photo.png', { headers: { 'if-none-match': etag! } }, env)
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')

    const head = await app.request('/imgbed/file/photo.png', { method: 'HEAD' }, env)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('12')
    expect(await head.text()).toBe('')

    const download = await app.request('/imgbed/file/photo.png?download=1', {}, env)
    expect(download.headers.get('content-disposition')).toContain('attachment;')
  })

  it('applies the blocked, whitelist, domain and admin access matrix', async () => {
    const { env, db, bucket, app } = serveEnvironment()
    await seedFile(db, bucket, 'normal.png')
    await seedFile(db, bucket, 'blocked.png', { listType: 'Block' })
    await seedFile(db, bucket, 'adult.png', { label: 'adult' })
    await seedFile(db, bucket, 'white.png', { listType: 'White', label: 'adult' })
    expect((await app.request('/imgbed/file/normal.png', {}, env)).status).toBe(200)
    const blocked = await app.request('/imgbed/file/blocked.png', {}, env)
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get('content-security-policy')).toContain('sandbox')
    expect((await app.request('/imgbed/file/adult.png', {}, env)).status).toBe(403)
    expect((await app.request('/imgbed/file/white.png', {}, env)).status).toBe(200)

    await saveSettingsGroup(db, 'security', { access: { whiteListMode: true } })
    expect((await app.request('/imgbed/file/normal.png', {}, env)).status).toBe(403)
    expect((await app.request('/imgbed/file/white.png', {}, env)).status).toBe(200)

    await saveSettingsGroup(db, 'security', { access: { allowedDomains: 'example.com' } })
    expect((await app.request('/imgbed/file/normal.png', { headers: { 'sec-fetch-dest': 'image' } }, env)).status).toBe(403)
    expect((await app.request('/imgbed/file/normal.png', { headers: { referer: 'https://example.com/page' } }, env)).status).toBe(200)
    expect((await app.request('/imgbed/file/normal.png', {}, env)).status).toBe(200)

    const token = await createToken(db, { name: 'manager', scopes: ['manage'], expiresAt: null, autoDelete: false, createdBy: 'u' })
    const unauthenticated = await app.request('/imgbed/file/blocked.png?from=admin', {}, env)
    expect(unauthenticated.status).toBe(401)
    const admin = await app.request('/imgbed/file/blocked.png?from=admin', { headers: { authorization: `Bearer ${token.token}` } }, env)
    expect(admin.status).toBe(200)
  })

  it('forces active content to an inert attachment and sandboxes SVG', async () => {
    const { env, db, bucket, app } = serveEnvironment()
    await seedFile(db, bucket, 'page.html', { fileType: 'text/html', fileName: 'page.html', body: '<script>alert(1)</script>' })
    await seedFile(db, bucket, 'vector.svg', { fileType: 'image/svg+xml', fileName: 'vector.svg', body: '<svg onload="alert(1)"/>' })
    const html = await app.request('/imgbed/file/page.html', {}, env)
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/plain')
    expect(html.headers.get('content-disposition')).toContain('attachment;')
    expect(html.headers.get('x-content-type-options')).toBe('nosniff')
    const svg = await app.request('/imgbed/file/vector.svg', {}, env)
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toContain('sandbox')
  })

  it('transforms only allowed sizes and falls back to the original when asked', async () => {
    const { db, bucket } = serveEnvironment()
    const calls: { transform: Record<string, unknown>; output: Record<string, unknown> }[] = []
    const images = {
      input: () => ({
        transform: (transform: Record<string, unknown>) => ({
          output: (output: Record<string, unknown>) => ({
            response: () => {
              calls.push({ transform, output })
              return new Response('resized', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '7' } })
            },
          }),
        }),
      }),
    }
    const env = testBindings(db, { FILES: bucket, IMAGES: images as unknown as Env['IMAGES'] })
    const app = appFor('/imgbed', imgbedServeRoutes)
    await seedFile(db, bucket, 'photo.png')
    await saveSettingsGroup(db, 'security', { access: { imageTransformEnabled: true, imageTransformAllowedSizes: '100x50' } })
    const transformed = await app.request('/imgbed/file/photo.png?width=100&height=50&fit=cover', {}, env)
    expect(transformed.status).toBe(200)
    expect(await transformed.text()).toBe('resized')
    expect(calls[0]?.transform).toEqual({ width: 100, height: 50, fit: 'cover' })
    expect(calls[0]?.output).toEqual({ format: 'image/png' })
    expect(transformed.headers.get('etag')).toMatch(/-100x50-cover"$/)

    await saveSettingsGroup(db, 'security', { access: { imageTransformEnabled: false } })
    const original = await app.request('/imgbed/file/photo.png?width=100&height=50&fallback=original', {}, env)
    expect(original.status).toBe(200)
    expect(await original.text()).toBe('images-bytes')
    expect((await app.request('/imgbed/file/photo.png?width=100&height=50', {}, env)).status).toBe(403)
  })
})

describe('imgbed upload integration', () => {
  function uploadEnvironment() {
    const { db } = database()
    const bucket = testR2Bucket()
    return { db, bucket, env: testBindings(db, { FILES: bucket }), app: appFor('/api/imgbed', imgbedUploadRoutes) }
  }

  async function token(db: D1Database, scopes: ('list' | 'upload' | 'delete' | 'manage')[]): Promise<string> {
    return (await createToken(db, { name: 'route test', scopes, expiresAt: null, autoDelete: false, createdBy: 'u' })).token
  }

  it('uploads a single file into the R2 path a token is allowed to write', async () => {
    const { db, bucket, env, app } = uploadEnvironment()
    const bearer = await token(db, ['upload'])
    const form = new FormData()
    form.append('file', new File([new TextEncoder().encode('hello')], 'hello.png', { type: 'image/png' }))
    const response = await app.request('/api/imgbed/upload?uploadChannel=cfr2', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: form,
    }, env)
    expect(response.status).toBe(200)
    const [result] = await response.json() as { id: string; src: string; channel: string }[]
    expect(result?.src).toBe(`/imgbed/file/${result?.id}`)
    expect(result?.channel).toBe('CloudflareR2')
    const key = `imgbed/images/${result?.id}`
    expect(new TextDecoder().decode(bucket.objects.get(key))).toBe('hello')
    const row = await db.prepare('SELECT file_name, channel, object_key FROM imgbed_files WHERE id = ?1').bind(result?.id).first<{ file_name: string; channel: string; object_key: string }>()
    expect(row).toMatchObject({ file_name: 'hello.png', channel: 'CloudflareR2', object_key: key })
    const served = await appFor('/imgbed', imgbedServeRoutes).request(`/imgbed/file/${result?.id}`, {}, env)
    expect(await served.text()).toBe('hello')
  })

  it('refuses uploads without a session or with a token missing the upload scope', async () => {
    const { db, env, app } = uploadEnvironment()
    const anonymous = await app.request('/api/imgbed/upload?uploadChannel=cfr2', { method: 'POST', body: new FormData() }, env)
    expect(anonymous.status).toBe(401)
    const bearer = await token(db, ['list'])
    const denied = await app.request('/api/imgbed/upload?uploadChannel=cfr2', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: new FormData(),
    }, env)
    expect(denied.status).toBe(403)
    expect((await denied.json() as { error: { code: string } }).error.code).toBe('forbidden')
  })

  it('assembles multipart parts owned by one actor and enforces the size and part limits', async () => {
    const { db, bucket, env, app } = uploadEnvironment()
    const bearer = await token(db, ['upload'])
    const init = await app.request('/api/imgbed/uploads/init', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'chunk.txt', fileType: 'text/plain', size: 17 * 1024 * 1024, channel: 'cfr2' }),
    }, env)
    expect(init.status).toBe(200)
    const upload = await init.json() as { uploadId: string; partSize: number; totalParts: number; channel: string }
    expect(upload).toMatchObject({ partSize: 16 * 1024 * 1024, totalParts: 2, channel: 'cfr2' })

    const tooLarge = await app.request('/api/imgbed/uploads/init', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'huge.bin', fileType: 'application/octet-stream', size: 6 * 1024 * 1024 * 1024, channel: 'cfr2' }),
    }, env)
    expect(tooLarge.status).toBe(413)
    const outOfRange = await app.request(`/api/imgbed/uploads/${upload.uploadId}/parts/2`, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer}` }, body: new Uint8Array([1]),
    }, env)
    expect(outOfRange.status).toBe(400)

    const foreign = await token(db, ['upload'])
    const stolen = await app.request(`/api/imgbed/uploads/${upload.uploadId}/parts/0`, {
      method: 'PUT', headers: { authorization: `Bearer ${foreign}` }, body: new Uint8Array([1]),
    }, env)
    expect(stolen.status).toBe(403)

    for (const [index, body] of [['0', 'aa'], ['1', 'bb']] as const) {
      const part = await app.request(`/api/imgbed/uploads/${upload.uploadId}/parts/${index}`, {
        method: 'PUT', headers: { authorization: `Bearer ${bearer}` }, body: new TextEncoder().encode(body),
      }, env)
      expect(part.status).toBe(200)
    }
    const complete = await app.request(`/api/imgbed/uploads/${upload.uploadId}/complete`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}` },
    }, env)
    expect(complete.status).toBe(200)
    const done = await complete.json() as { id: string; size: number }
    expect(done.size).toBe(4)
    const row = await db.prepare('SELECT object_key FROM imgbed_files WHERE id = ?1').bind(done.id).first<{ object_key: string }>()
    expect(row?.object_key).toMatch(/^imgbed\/[a-z]+\//)
    expect(new TextDecoder().decode(bucket.objects.get(row!.object_key))).toBe('aabb')
    const leftover = await db.prepare('SELECT COUNT(*) AS n FROM imgbed_upload_parts WHERE session_id = ?1').bind(upload.uploadId).first<{ n: number }>()
    expect(leftover?.n).toBe(0)
  })
})

describe('imgbed WebDAV integration', () => {
  async function davEnvironment() {
    const { sqlite, db } = database()
    const bucket = testR2Bucket()
    await saveSettingsGroup(db, 'others', {
      webDAV: { enabled: true, username: 'dav', passwordHash: await hashPassword('secret'), uploadChannel: '', channelName: '' },
    })
    return {
      sqlite, db, bucket, env: testBindings(db, { FILES: bucket }),
      app: appFor('/imgbed/dav', imgbedDavRoutes),
      auth: `Basic ${btoa('dav:secret')}`,
    }
  }

  it('requires Basic auth and serves DAV listings, headers and inert active content', async () => {
    const { db, bucket, env, app, auth } = await davEnvironment()
    await seedFile(db, bucket, 'a&b.png', { fileName: 'a&b.png', body: 'dav-bytes' })
    await seedFile(db, bucket, 'page.html', { fileName: 'page.html', fileType: 'text/html', body: '<script>alert(1)</script>' })
    const anonymous = await app.request('/imgbed/dav/', {}, env)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain('Basic')
    expect((await app.request('/imgbed/dav/', { headers: { authorization: 'Basic @@' } }, env)).status).toBe(400)
    expect((await app.request('/imgbed/dav/', { headers: { authorization: `Basic ${btoa('dav:wrong')}` } }, env)).status).toBe(401)

    const listing = await app.request('/imgbed/dav/', { headers: { authorization: auth } }, env)
    expect(listing.status).toBe(200)
    expect(listing.headers.get('content-type')).toContain('text/html')
    const html = await listing.text()
    expect(html).toContain('a&amp;b.png')
    expect(html).not.toContain('a&b.png')

    const file = await app.request('/imgbed/dav/a%26b.png', { headers: { authorization: auth } }, env)
    expect(file.status).toBe(200)
    expect(await file.text()).toBe('dav-bytes')
    expect(file.headers.get('cache-control')).toBe('private, no-store')
    expect(file.headers.get('content-disposition')).toContain('inline;')
    expect(file.headers.get('access-control-allow-origin')).toBe('*')

    const head = await app.request('/imgbed/dav/a%26b.png', { method: 'HEAD', headers: { authorization: auth } }, env)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe('9')

    const active = await app.request('/imgbed/dav/page.html', { headers: { authorization: auth } }, env)
    expect(active.headers.get('content-type')).toBe('text/plain')
    expect(active.headers.get('content-disposition')).toContain('attachment;')

    const propfind = await app.request('/imgbed/dav/', { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } }, env)
    expect(propfind.status).toBe(207)
    expect(propfind.headers.get('content-type')).toContain('application/xml')
    const xml = await propfind.text()
    expect(xml).toContain('<D:displayname>a&amp;b.png</D:displayname>')
    expect(xml).not.toContain('<D:displayname>a&b.png</D:displayname>')
    expect((await app.request('/imgbed/dav/', { method: 'PROPFIND', headers: { authorization: auth, depth: 'infinity' } }, env)).status).toBe(403)
  })

  it('throttles repeated failed Basic attempts', async () => {
    const { env, app } = await davEnvironment()
    const invalid = { authorization: `Basic ${btoa('dav:wrong')}` }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.request('/imgbed/dav/', { headers: invalid }, env)).status).toBe(401)
    }
    const locked = await app.request('/imgbed/dav/', { headers: invalid }, env)
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('creates, moves and deletes an R2-backed file over DAV', async () => {
    const { sqlite, db, bucket, env, app, auth } = await davEnvironment()
    sqlite.prepare("INSERT INTO users (id, username, password_hash, login, role, created_at, last_seen_at) VALUES ('owner1','owner','x','owner','owner',1,1)").run()
    const put = await app.request('/imgbed/dav/dav/put.txt', { method: 'PUT', headers: { authorization: auth }, body: new TextEncoder().encode('put-bytes') }, env)
    expect(put.status).toBe(201)
    const row = await db.prepare('SELECT file_name, source, channel, object_key FROM imgbed_files WHERE id = ?1').bind('dav/put.txt')
      .first<{ file_name: string; source: string; channel: string; object_key: string }>()
    expect(row).toMatchObject({ file_name: 'put.txt', source: 'cfr2', channel: 'CloudflareR2' })
    expect(new TextDecoder().decode(bucket.objects.get(row!.object_key))).toBe('put-bytes')

    const destination = new URL('/imgbed/dav/dav/renamed.txt', 'http://localhost').href
    const moved = await app.request('/imgbed/dav/dav/put.txt', { method: 'MOVE', headers: { authorization: auth, destination } }, env)
    expect(moved.status).toBe(201)
    expect(await db.prepare('SELECT id FROM imgbed_files WHERE id = ?1').bind('dav/put.txt').first()).toBeNull()
    const renamed = await db.prepare('SELECT object_key FROM imgbed_files WHERE id = ?1').bind('dav/renamed.txt').first<{ object_key: string }>()
    expect(renamed?.object_key).toMatch(/^imgbed\/txt\/dav\/renamed\.txt$/)
    expect(bucket.objects.has(row!.object_key)).toBe(false)
    const served = await appFor('/imgbed', imgbedServeRoutes).request('/imgbed/file/dav/renamed.txt', {}, env)
    expect(await served.text()).toBe('put-bytes')

    const removed = await app.request('/imgbed/dav/dav/renamed.txt', { method: 'DELETE', headers: { authorization: auth } }, env)
    expect(removed.status).toBe(204)
    expect(await db.prepare('SELECT id FROM imgbed_files WHERE id = ?1').bind('dav/renamed.txt').first()).toBeNull()
    expect(bucket.objects.has(renamed!.object_key)).toBe(false)
  })
})
