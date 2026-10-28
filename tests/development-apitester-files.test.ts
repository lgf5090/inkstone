// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_PER_USER,
  MAX_FILES_PER_USER,
} from '../src/shared/development/api-tester/limits'
import type { FileKind } from '../src/shared/development/api-tester/limits'
import { newApiTesterId } from '../src/shared/development/api-tester/ids'
import type { ApiTesterFile } from '../src/shared/development/api-tester/types'
import type { AppBindings, Env } from '../src/worker/env'
import {
  fileKey,
  fileRoutes,
  readOwnedFileBytes,
} from '../src/worker/development/api-tester/files'
import { DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS } from '../src/worker/development/api-tester/schema'
import { ApiError, errorResponse } from '../src/worker/lib/errors'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-owner'
const OTHER = 'user-other'

const LOGIN_ATTEMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL,
  locked_until INTEGER
)`
const DAY = 24 * 60 * 60 * 1_000

let sqlite: DatabaseSync
let db: D1Database
let bucket: TestR2Bucket
let env: Env
let currentUser = USER

const app = new Hono<AppBindings>()
app.use('*', async (c, next) => {
  c.set('userId', currentUser)
  await next()
})
app.route('/', fileRoutes)
app.onError((err, c) => errorResponse(c, err))

interface UploadOptions {
  content?: string
  fileName?: string
  formName?: string
  kind?: string
  type?: string
  file?: boolean
}

async function upload(options: UploadOptions = {}): Promise<Response> {
  const form = new FormData()
  if (options.file !== false) {
    form.set(
      'file',
      new File([options.content ?? 'hello'], options.fileName ?? 'hello.txt', {
        type: options.type ?? '',
      }),
    )
  }
  if (options.kind !== undefined) form.set('kind', options.kind)
  else form.set('kind', 'txt')
  if (options.formName !== undefined) form.set('name', options.formName)
  return app.request('/files', { method: 'POST', body: form }, env)
}

async function uploadJson(options: UploadOptions = {}): Promise<ApiTesterFile> {
  const response = await upload(options)
  expect(response.status).toBe(200)
  return (await response.json()) as ApiTesterFile
}

interface InsertOptions {
  id?: string
  userId?: string
  kind?: FileKind
  name?: string
  contentType?: string
  size?: number
  r2Key?: string
  createdAt?: number
  expiresAt?: number
}

function insertRow(options: InsertOptions = {}): { id: string; key: string } {
  const id = options.id ?? newApiTesterId()
  const userId = options.userId ?? USER
  const kind = options.kind ?? 'txt'
  const now = Date.now()
  const key = options.r2Key ?? fileKey(kind, userId, id, options.contentType)
  db.prepare(
    `INSERT INTO development_apitester_files
       (id, user_id, kind, name, content_type, size, r2_key, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      kind,
      options.name ?? 'file.txt',
      options.contentType ?? 'text/plain; charset=utf-8',
      options.size ?? 1,
      key,
      options.createdAt ?? now,
      options.expiresAt ?? now + DAY,
    )
    .run()
  return { id, key }
}

beforeEach(() => {
  currentUser = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(LOGIN_ATTEMPTS_SCHEMA)
  for (const statement of DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = testBindings(db, { FILES: bucket })
})

afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
})

describe('file keys', () => {
  it('places every object under kind/user/id with the server-chosen extension', () => {
    expect(fileKey('json', USER, 'file1')).toBe(`development/apitester/json/${USER}/file1.json`)
    expect(fileKey('txt', USER, 'file2')).toBe(`development/apitester/txt/${USER}/file2.txt`)
    expect(fileKey('image', USER, 'file3', 'image/jpeg')).toBe(
      `development/apitester/image/${USER}/file3.jpg`,
    )
    expect(fileKey('image', USER, 'file4', 'image/svg+xml')).toBe(
      `development/apitester/image/${USER}/file4.svg`,
    )
    expect(fileKey('image', USER, 'file5', 'image/tiff')).toBe(
      `development/apitester/image/${USER}/file5.bin`,
    )
    expect(fileKey('image', USER, 'file6')).toBe(
      `development/apitester/image/${USER}/file6.png`,
    )
  })

  it('refuses kinds and segments that could escape the intended path', () => {
    expect(() => fileKey('exe' as FileKind, USER, 'file1')).toThrow(ApiError)
    expect(() => fileKey('json', 'bad/user', 'file1')).toThrow(ApiError)
    expect(() => fileKey('json', USER, '../evil')).toThrow(ApiError)
  })
})

describe('file uploads', () => {
  it('stores the bytes, maps the content type and never trusts the client type', async () => {
    const file = await uploadJson({
      content: '{"a":1}',
      fileName: 'payload.txt',
      formName: 'payload.json',
      kind: 'json',
      type: 'text/html',
    })

    expect(file.kind).toBe('json')
    expect(file.name).toBe('payload.json')
    expect(file.contentType).toBe('application/json; charset=utf-8')
    expect(file.size).toBe(7)
    expect(file.url).toBe(`/api/development/api-tester/files/${file.id}`)
    expect(file.expiresAt - file.createdAt).toBe(7 * DAY)

    const key = `development/apitester/json/${USER}/${file.id}.json`
    expect(bucket.objects.has(key)).toBe(true)
    expect(new TextDecoder().decode(bucket.objects.get(key))).toBe('{"a":1}')
    expect(bucket.types.get(key)).toBe('application/json; charset=utf-8')

    const row = sqlite
      .prepare(
        'SELECT user_id, kind, name, content_type, size, r2_key FROM development_apitester_files WHERE id = ?',
      )
      .get(file.id) as {
      user_id: string
      kind: string
      name: string
      content_type: string
      size: number
      r2_key: string
    }
    expect(row.user_id).toBe(USER)
    expect(row.r2_key).toBe(key)
    expect(row.size).toBe(7)
  })

  it('uses the image MIME for the extension and falls back to binary for unknown types', async () => {
    const jpeg = await uploadJson({ kind: 'image', fileName: 'photo.png', type: 'image/jpeg' })
    expect(jpeg.contentType).toBe('image/jpeg')
    expect(bucket.objects.has(`development/apitester/image/${USER}/${jpeg.id}.jpg`)).toBe(true)

    const unknown = await uploadJson({ kind: 'image', fileName: 'scan.tiff', type: 'image/tiff' })
    expect(unknown.contentType).toBe('application/octet-stream')
    expect(bucket.objects.has(`development/apitester/image/${USER}/${unknown.id}.bin`)).toBe(true)
  })

  it('cleans control characters and path separators out of the display name', async () => {
    const file = await uploadJson({
      kind: 'txt',
      fileName: 'ignored.txt',
      formName: 'my/photo\u0000\\copy.txt',
    })
    expect(file.name).toBe('my_photo_copy.txt')
  })

  it('rejects a file past the 8 MiB ceiling', async () => {
    const response = await upload({ content: 'a'.repeat(MAX_FILE_BYTES + 1), kind: 'txt' })
    expect(response.status).toBe(413)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('apitester_file_too_large')
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects unsupported kinds and requests without a file', async () => {
    const unsupported = await upload({ kind: 'exe' })
    expect(unsupported.status).toBe(400)

    const missing = await upload({ kind: 'txt', file: false })
    expect(missing.status).toBe(400)
    expect(bucket.objects.size).toBe(0)
  })

  it('enforces the per-user file count quota before writing anything', async () => {
    for (let index = 0; index < MAX_FILES_PER_USER; index++) insertRow({ size: 1 })

    const response = await upload({ content: 'x' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('apitester_quota_exceeded')
    expect(bucket.objects.size).toBe(0)
  })

  it('enforces the per-user byte quota', async () => {
    insertRow({ size: MAX_FILE_BYTES_PER_USER })

    const response = await upload({ content: 'x' })
    expect(response.status).toBe(409)
    expect(bucket.objects.size).toBe(0)
  })

  it('removes the object when the D1 row cannot be written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    sqlite.exec(
      `CREATE TRIGGER fail_file_insert BEFORE INSERT ON development_apitester_files
       BEGIN SELECT RAISE(ABORT, 'insert failed'); END`,
    )

    const response = await upload({ content: 'orphan' })
    expect(response.status).toBe(500)
    expect(bucket.objects.size).toBe(0)
    const row = sqlite.prepare('SELECT COUNT(*) AS count FROM development_apitester_files').get() as {
      count: number
    }
    expect(row.count).toBe(0)
  })
})

describe('file listing and cleanup', () => {
  it('lists newest first, filters by kind and caps the page at fifty', async () => {
    await uploadJson({ content: '{}', kind: 'json', fileName: 'one.json' })
    await uploadJson({ content: 'hi', kind: 'txt', fileName: 'two.txt' })

    const all = (await (await app.request('/files', {}, env)).json()) as ApiTesterFile[]
    expect(all).toHaveLength(2)
    expect(all.some((file) => file.kind === 'json')).toBe(true)
    expect(all.some((file) => file.kind === 'txt')).toBe(true)
    expect('r2Key' in all[0]!).toBe(false)

    const jsonOnly = (await (await app.request('/files?kind=json', {}, env)).json()) as ApiTesterFile[]
    expect(jsonOnly).toHaveLength(1)
    expect(jsonOnly[0]!.kind).toBe('json')

    for (let index = 0; index < 55; index++) {
      insertRow({ kind: 'csv', createdAt: Date.now() + index })
    }
    const page = (await (await app.request('/files?kind=csv', {}, env)).json()) as ApiTesterFile[]
    expect(page).toHaveLength(50)
    expect(page[0]!.createdAt).toBeGreaterThan(page[49]!.createdAt)
  })

  it('drops expired rows and objects before listing', async () => {
    const expired = insertRow({ expiresAt: Date.now() - 1 })
    bucket.put(expired.key, new TextEncoder().encode('old'))

    const list = (await (await app.request('/files', {}, env)).json()) as ApiTesterFile[]
    expect(list).toEqual([])
    expect(bucket.objects.has(expired.key)).toBe(false)
    const row = sqlite
      .prepare('SELECT COUNT(*) AS count FROM development_apitester_files')
      .get() as { count: number }
    expect(row.count).toBe(0)
  })

  it('drops expired rows and objects before an upload', async () => {
    const expired = insertRow({ expiresAt: Date.now() - 1 })
    bucket.put(expired.key, new TextEncoder().encode('old'))

    const file = await uploadJson({ content: 'fresh', kind: 'txt' })
    expect(bucket.objects.has(expired.key)).toBe(false)
    expect(bucket.objects.has(`development/apitester/txt/${USER}/${file.id}.txt`)).toBe(true)
  })

  it('still deletes expired rows when R2 refuses the object delete', async () => {
    insertRow({ expiresAt: Date.now() - 1 })
    vi.spyOn(bucket, 'delete').mockRejectedValue(new Error('r2 down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const list = (await (await app.request('/files', {}, env)).json()) as ApiTesterFile[]
    expect(list).toEqual([])
    const row = sqlite
      .prepare('SELECT COUNT(*) AS count FROM development_apitester_files')
      .get() as { count: number }
    expect(row.count).toBe(0)
  })
})

describe('file downloads', () => {
  it('serves the bytes with attachment headers', async () => {
    const file = await uploadJson({
      content: '{"ok":true}',
      kind: 'json',
      formName: '报告 1.json',
    })

    const response = await app.request(`/files/${file.id}`, {}, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition.startsWith('attachment;')).toBe(true)
    expect(disposition).toContain("filename*=UTF-8''")
    expect(disposition).toContain(encodeURIComponent('报告 1.json'))
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('answers 404 when the object is gone and for an expired row', async () => {
    const file = await uploadJson({ content: 'x', kind: 'txt' })
    bucket.objects.delete(`development/apitester/txt/${USER}/${file.id}.txt`)
    expect((await app.request(`/files/${file.id}`, {}, env)).status).toBe(404)

    const expired = insertRow({ expiresAt: Date.now() - 1 })
    bucket.put(expired.key, new TextEncoder().encode('old'))
    expect((await app.request(`/files/${expired.id}`, {}, env)).status).toBe(404)
  })

  it('isolates files by owner', async () => {
    const file = await uploadJson({ content: 'secret', kind: 'txt' })
    currentUser = OTHER

    const list = (await (await app.request('/files', {}, env)).json()) as ApiTesterFile[]
    expect(list).toEqual([])
    expect((await app.request(`/files/${file.id}`, {}, env)).status).toBe(404)
    expect((await app.request(`/files/${file.id}`, { method: 'DELETE' }, env)).status).toBe(404)
    await expect(readOwnedFileBytes(env, OTHER, file.id)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })

    currentUser = USER
    const bytes = await readOwnedFileBytes(env, USER, file.id)
    expect(new TextDecoder().decode(bytes)).toBe('secret')
  })
})

describe('file deletion', () => {
  it('removes the row and the object', async () => {
    const file = await uploadJson({ content: 'bye', kind: 'txt' })
    const key = `development/apitester/txt/${USER}/${file.id}.txt`

    const response = await app.request(`/files/${file.id}`, { method: 'DELETE' }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(bucket.objects.has(key)).toBe(false)
    const row = sqlite
      .prepare('SELECT COUNT(*) AS count FROM development_apitester_files')
      .get() as { count: number }
    expect(row.count).toBe(0)
    expect((await app.request(`/files/${file.id}`, {}, env)).status).toBe(404)
  })

  it('still succeeds when the object was already missing', async () => {
    const file = await uploadJson({ content: 'bye', kind: 'txt' })
    bucket.objects.delete(`development/apitester/txt/${USER}/${file.id}.txt`)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await app.request(`/files/${file.id}`, { method: 'DELETE' }, env)
    expect(response.status).toBe(200)
  })
})

describe('file storage availability', () => {
  it('answers 503 on every endpoint when R2 is not bound', async () => {
    const unbound = testBindings(db)
    const file = insertRow({})

    const uploadResponse = await app.request(
      '/files',
      {
        method: 'POST',
        body: (() => {
          const form = new FormData()
          form.set('file', new File(['x'], 'x.txt'))
          form.set('kind', 'txt')
          return form
        })(),
      },
      unbound,
    )
    expect(uploadResponse.status).toBe(503)
    expect((await app.request('/files', {}, unbound)).status).toBe(503)
    expect((await app.request(`/files/${file.id}`, {}, unbound)).status).toBe(503)
    expect((await app.request(`/files/${file.id}`, { method: 'DELETE' }, unbound)).status).toBe(503)
    await expect(readOwnedFileBytes(unbound, USER, file.id)).rejects.toMatchObject({
      status: 503,
      code: 'storage_unavailable',
    })
  })
})
