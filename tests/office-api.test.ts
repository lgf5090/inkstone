// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OFFICE_FILE_TYPES, OFFICE_LIMITS, type OfficeFileType } from '../src/shared/office/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { isValidId, newId } from '../src/worker/lib/id'
import { officeContentRoutes } from '../src/worker/routes/office-content'
import { officeRoutes } from '../src/worker/routes/office'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

/**
 * The office API's own door: files, snapshots, versions and assets.
 *
 * Ownership is the first thing every section checks: an id from another account must answer 404,
 * never a 403 that confirms the row exists. Snapshot tests assert the R2 key shape, because the
 * revision objects are what the conflict rules protect.
 */

const USER = 'user-alpha'
const OTHER = 'user-beta'

interface FileJson {
  id: string
  type: string
  title: string
  folderId: string | null
  rev: number
  size: number
  isPinned: boolean
  isStarred: boolean
  position: number
  lastOpenedAt: number | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

interface FolderJson {
  id: string
  parentId: string | null
  name: string
  position: number
}

interface TagJson {
  id: string
  name: string
  count: number
}

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/office', officeContentRoutes)
  instance.route('/api/office', officeRoutes)
  return instance
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json', ...headers }
  }
  return app().request(`http://localhost/api/office${path}`, init, env)
}

async function raw(method: string, path: string, body: string | Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return app().request(`http://localhost/api/office${path}`, {
    method,
    headers,
    body: body as BodyInit,
  }, env)
}

async function bodyOf<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function createFile(type: OfficeFileType, title: string, folderId?: string | null): Promise<FileJson> {
  const response = await call('POST', '/files', { type, title, ...(folderId === undefined ? {} : { folderId }) })
  expect(response.status).toBe(201)
  return (await bodyOf<{ file: FileJson }>(response)).file
}

async function createFolder(name: string, parentId: string | null = null): Promise<FolderJson> {
  const response = await call('POST', '/folders', { name, parentId })
  expect(response.status).toBe(201)
  return (await bodyOf<{ folder: FolderJson }>(response)).folder
}

async function createTag(name: string): Promise<TagJson> {
  const response = await call('POST', '/tags', { name })
  expect(response.status).toBe(201)
  return (await bodyOf<{ tag: TagJson }>(response)).tag
}

async function saveSnapshot(id: string, baseRev: number, snapshot: Record<string, unknown>): Promise<Response> {
  return call('PUT', `/files/${id}/snapshot`, { baseRev, snapshot })
}

function snapshotKeys(fileId: string, revs: readonly number[]): string[] {
  return revs.map((rev) => `office/txt/${USER}/${fileId}/${rev}.json`)
}

function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

function gifBytes(): Uint8Array {
  const bytes = new Uint8Array(20)
  bytes.set(new TextEncoder().encode('GIF89a'))
  return bytes
}

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function uploadAsset(bytes: Uint8Array, mime: string, name?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': mime }
  if (name) headers['x-office-name'] = name
  return raw('POST', '/assets', bytes, headers)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  mocks.userId = USER
})

describe('office file listing and metadata', () => {
  it('creates every product type and filters by it', async () => {
    for (const type of OFFICE_FILE_TYPES) await createFile(type, `${type} document`)
    const all = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files'))
    expect(all.files).toHaveLength(OFFICE_FILE_TYPES.length)
    for (const type of OFFICE_FILE_TYPES) {
      const filtered = await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?type=${type}`))
      expect(filtered.files.map((file) => file.type)).toEqual([type])
    }
  })

  it('refuses an unknown type and an unusable title', async () => {
    expect((await call('POST', '/files', { type: 'sheet', title: 'x' })).status).toBe(400)
    expect((await call('POST', '/files', { type: 'docs', title: '   ' })).status).toBe(400)
    expect((await call('POST', '/files', { type: 'docs', title: 'bad\u0000name' })).status).toBe(400)
  })

  it('searches titles, filters by folder, star, recent and trash', async () => {
    const folder = await createFolder('Work')
    const budget = await createFile('sheets', 'Budget 2026', folder.id)
    const plan = await createFile('docs', 'Plan')
    await call('PATCH', `/files/${plan.id}`, { isStarred: true })
    await call('POST', `/files/${budget.id}/open`)

    const byQuery = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files?q=budget'))
    expect(byQuery.files.map((file) => file.id)).toEqual([budget.id])
    const byFolder = await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?folderId=${folder.id}`))
    expect(byFolder.files.map((file) => file.id)).toEqual([budget.id])
    const rootOnly = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files?folderId=root'))
    expect(rootOnly.files.map((file) => file.id)).toEqual([plan.id])
    const starred = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files?starred=1'))
    expect(starred.files.map((file) => file.id)).toEqual([plan.id])
    const recent = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files?recent=1'))
    expect(recent.files.map((file) => file.id)).toEqual([budget.id])

    const deleted = await createFile('docs', 'Old plan')
    expect((await call('DELETE', `/files/${deleted.id}`)).status).toBe(200)
    const visible = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files'))
    expect(visible.files.some((file) => file.id === deleted.id)).toBe(false)
    const trash = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files?trash=1'))
    expect(trash.files.map((file) => file.id)).toEqual([deleted.id])
  })

  it('orders pinned files first and rejects malformed filters', async () => {
    const first = await createFile('docs', 'First')
    await createFile('docs', 'Second')
    await call('PATCH', `/files/${first.id}`, { isPinned: true })
    const files = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files'))
    expect(files.files[0]!.id).toBe(first.id)

    expect((await call('GET', '/files?type=nope')).status).toBe(400)
    expect((await call('GET', '/files?folderId=nope')).status).toBe(400)
    expect((await call('GET', '/files?tagId=nope')).status).toBe(400)
    expect((await call('GET', '/files?limit=0')).status).toBe(400)
  })

  it('opens a file and records the moment for the recent view', async () => {
    const file = await createFile('docs', 'Opened')
    expect(file.lastOpenedAt).toBeNull()
    const opened = await bodyOf<{ file: FileJson }>(await call('POST', `/files/${file.id}/open`))
    expect(opened.file.lastOpenedAt).not.toBeNull()
  })

  it('renames, moves, stars and pins through one patch', async () => {
    const folder = await createFolder('Target')
    const file = await createFile('docs', 'Draft')
    const patched = await bodyOf<{ file: FileJson }>(
      await call('PATCH', `/files/${file.id}`, {
        title: 'Final',
        folderId: folder.id,
        isPinned: true,
        isStarred: true,
      }),
    )
    expect(patched.file).toMatchObject({
      title: 'Final',
      folderId: folder.id,
      isPinned: true,
      isStarred: true,
    })
    expect((await call('PATCH', `/files/${file.id}`, { isPinned: 'yes' })).status).toBe(400)
  })

  it('soft-deletes, restores and purges including every snapshot object', async () => {
    const file = await createFile('docs', 'Discard me')
    expect((await saveSnapshot(file.id, 0, { body: { text: 'one' } })).status).toBe(200)
    expect((await saveSnapshot(file.id, 1, { body: { text: 'two' } })).status).toBe(200)
    expect(snapshotKeys(file.id, [1, 2]).every((key) => bucket.objects.has(key))).toBe(true)

    await call('DELETE', `/files/${file.id}`)
    const restored = await bodyOf<{ file: FileJson }>(await call('POST', `/files/${file.id}/restore`))
    expect(restored.file.id).toBe(file.id)
    expect(restored.file.rev).toBe(2)

    expect((await call('DELETE', `/files/${file.id}?purge=1`)).status).toBe(200)
    expect((await call('GET', `/files/${file.id}`)).status).toBe(404)
    expect(snapshotKeys(file.id, [1, 2]).some((key) => bucket.objects.has(key))).toBe(false)
  })

  it('duplicates metadata, tags and the current snapshot under a new id', async () => {
    const tag = await createTag('shared')
    const file = await createFile('docs', 'Original')
    await call('PATCH', `/files/${file.id}`, { tagIds: [tag.id] })
    await saveSnapshot(file.id, 0, { body: { text: 'copy me' } })

    const response = await call('POST', `/files/${file.id}/duplicate`)
    expect(response.status).toBe(201)
    const copy = (await bodyOf<{ file: FileJson }>(response)).file
    expect(copy.id).not.toBe(file.id)
    expect(copy.title).toBe('Original (copy)')
    expect(copy.rev).toBe(1)
    expect(bucket.objects.has(`office/txt/${USER}/${copy.id}/1.json`)).toBe(true)

    const copySnapshot = await bodyOf<{ snapshot: unknown }>(await call('GET', `/files/${copy.id}/snapshot`))
    expect(copySnapshot.snapshot).toEqual({ body: { text: 'copy me' } })
    const tagged = await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?tagId=${tag.id}`))
    expect(tagged.files.map((entry) => entry.id).sort()).toEqual([file.id, copy.id].sort())
  })
})

describe('office snapshots and revisions', () => {
  it('saves revisions conditionally and reports a stale writer as a 409', async () => {
    const file = await createFile('docs', 'Revisions')
    expect((await call('GET', `/files/${file.id}/snapshot`)).status).toBe(200)
    const empty = await bodyOf<{ rev: number; snapshot: null }>(await call('GET', `/files/${file.id}/snapshot`))
    expect(empty).toMatchObject({ rev: 0, snapshot: null })

    const first = await saveSnapshot(file.id, 0, { body: { text: 'one' } })
    expect(first.status).toBe(200)
    const firstBody = await bodyOf<{ rev: number; size: number }>(first)
    expect(firstBody.rev).toBe(1)
    expect(firstBody.size).toBeGreaterThan(0)
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/1.json`)).toBe(true)

    expect((await saveSnapshot(file.id, 1, { body: { text: 'two' } })).status).toBe(200)
    const read = await bodyOf<{ rev: number; snapshot: unknown }>(await call('GET', `/files/${file.id}/snapshot`))
    expect(read.rev).toBe(2)
    expect(read.snapshot).toEqual({ body: { text: 'two' } })

    const stale = await saveSnapshot(file.id, 0, { body: { text: 'stale' } })
    expect(stale.status).toBe(409)
    const staleBody = await bodyOf<ErrorJson>(stale)
    expect(staleBody.error.code).toBe('conflict')
    expect(staleBody.error.details).toMatchObject({ currentRev: 2 })
    // The kept revision is untouched and no third object was published.
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/1.json`)).toBe(true)
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/3.json`)).toBe(false)

    const versions = await bodyOf<{ versions: Array<{ rev: number }> }>(
      await call('GET', `/files/${file.id}/versions`),
    )
    expect(versions.versions.map((version) => version.rev)).toEqual([2, 1])
  })

  it('refuses a snapshot body that is not an object and one above the byte limit', async () => {
    const file = await createFile('sheets', 'Limits')
    expect((await call('PUT', `/files/${file.id}/snapshot`, { baseRev: 0, snapshot: [1, 2] })).status).toBe(400)
    expect((await call('PUT', `/files/${file.id}/snapshot`, { baseRev: -1, snapshot: {} })).status).toBe(400)

    const oversized = { body: 'x'.repeat(OFFICE_LIMITS.snapshotBytes + 2048) }
    const response = await saveSnapshot(file.id, 0, oversized)
    expect(response.status).toBe(413)
    expect((await bodyOf<ErrorJson>(response)).error.code).toBe('payload_too_large')
  })

  it('accepts a PDF envelope without a full parse and restores it as the snapshot value', async () => {
    const file = await createFile('pdfs', 'Scan')
    const envelope = '{"baseRev":0,"snapshot":{"pages":[{"id":"p1"}]}}'
    const saved = await raw('PUT', `/files/${file.id}/snapshot`, envelope, { 'content-type': 'application/json' })
    expect(saved.status).toBe(200)
    expect((await bodyOf<{ rev: number }>(saved)).rev).toBe(1)

    const read = await bodyOf<{ rev: number; snapshot: unknown }>(await call('GET', `/files/${file.id}/snapshot`))
    expect(read).toMatchObject({ rev: 1, snapshot: { pages: [{ id: 'p1' }] } })

    const reordered = '{"snapshot":{"pages":[]},"baseRev":1}'
    expect((await raw('PUT', `/files/${file.id}/snapshot`, reordered, { 'content-type': 'application/json' })).status).toBe(400)
    expect((await raw('PUT', `/files/${file.id}/snapshot`, new Uint8Array([0xff, 0xfe]), { 'content-type': 'application/json' })).status).toBe(400)
  })

  it('keeps another account from reading or writing the same ids', async () => {
    const file = await createFile('docs', 'Private')
    await saveSnapshot(file.id, 0, { body: { text: 'secret' } })

    mocks.userId = OTHER
    expect((await call('GET', `/files/${file.id}`)).status).toBe(404)
    expect((await call('PATCH', `/files/${file.id}`, { title: 'Stolen' })).status).toBe(404)
    expect((await call('POST', `/files/${file.id}/open`)).status).toBe(404)
    expect((await call('POST', `/files/${file.id}/restore`)).status).toBe(404)
    expect((await call('POST', `/files/${file.id}/duplicate`)).status).toBe(404)
    expect((await call('DELETE', `/files/${file.id}`)).status).toBe(404)
    expect((await call('GET', `/files/${file.id}/snapshot`)).status).toBe(404)
    expect((await call('PUT', `/files/${file.id}/snapshot`, { baseRev: 1, snapshot: { body: {} } })).status).toBe(404)
    expect((await call('GET', `/files/${file.id}/versions`)).status).toBe(404)
    expect((await call('POST', `/files/${file.id}/versions/1/restore`)).status).toBe(404)
    const theirs = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files'))
    expect(theirs.files).toEqual([])
  })
})

describe('office batch actions', () => {
  it('moves, tags, stars, pins, copies and deletes in one request each', async () => {
    const folder = await createFolder('Batch')
    const tag = await createTag('batch')
    const files = await Promise.all([
      createFile('docs', 'One'),
      createFile('docs', 'Two'),
      createFile('docs', 'Three'),
    ])
    const ids = files.map((file) => file.id)

    const moved = await bodyOf<{ affected: number }>(
      await call('POST', '/files/batch', { ids, action: 'move', folderId: folder.id }),
    )
    expect(moved.affected).toBe(3)
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?folderId=${folder.id}`))).files).toHaveLength(3)

    expect((await call('POST', '/files/batch', { ids, action: 'tag', tagIds: [tag.id] })).status).toBe(200)
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?tagId=${tag.id}`))).files).toHaveLength(3)

    expect((await call('POST', '/files/batch', { ids, action: 'star' })).status).toBe(200)
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', '/files?starred=1'))).files).toHaveLength(3)

    expect((await call('POST', '/files/batch', { ids, action: 'pin' })).status).toBe(200)
    const pinned = await bodyOf<{ files: FileJson[] }>(await call('GET', '/files'))
    expect(pinned.files.slice(0, 3).every((file) => file.isPinned)).toBe(true)

    const copied = await bodyOf<{ affected: number }>(await call('POST', '/files/batch', { ids, action: 'copy' }))
    expect(copied.affected).toBe(3)
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?folderId=${folder.id}`))).files).toHaveLength(6)

    const deleted = await bodyOf<{ affected: number }>(await call('POST', '/files/batch', { ids, action: 'delete' }))
    expect(deleted.affected).toBe(3)
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', '/files'))).files).toHaveLength(3)
  })

  it('refuses the whole batch when any id or action is invalid', async () => {
    const file = await createFile('docs', 'Kept')
    const missing = newId()
    expect(isValidId(missing)).toBe(true)

    const response = await call('POST', '/files/batch', { ids: [file.id, missing], action: 'star' })
    expect(response.status).toBe(404)
    expect((await bodyOf<ErrorJson>(response)).error.details).toMatchObject({ id: missing })
    const kept = await bodyOf<{ file: FileJson }>(await call('GET', `/files/${file.id}`))
    expect(kept.file.isStarred).toBe(false)

    expect((await call('POST', '/files/batch', { ids: [file.id], action: 'rename' })).status).toBe(400)
    expect((await call('POST', '/files/batch', { ids: [file.id], action: 'move' })).status).toBe(400)
    expect((await call('POST', '/files/batch', { ids: [], action: 'star' })).status).toBe(400)
  })

  it('does not move files into a folder owned by another account', async () => {
    const folder = await createFolder('Mine')
    const file = await createFile('docs', 'Mine too')
    mocks.userId = OTHER
    const foreign = await createFolder('Foreign')
    const foreignTag = await createTag('foreign-tag')

    mocks.userId = USER
    const response = await call('POST', '/files/batch', {
      ids: [file.id],
      action: 'move',
      folderId: foreign.id,
    })
    expect(response.status).toBe(400)
    const tagged = await call('POST', '/files/batch', {
      ids: [file.id],
      action: 'tag',
      tagIds: [foreignTag.id],
    })
    expect(tagged.status).toBe(400)
    const kept = await bodyOf<{ file: FileJson }>(await call('GET', `/files/${file.id}`))
    expect(kept.file.folderId).not.toBe(foreign.id)
    expect(folder.id).not.toBe(foreign.id)
  })
})

describe('office assets', () => {
  it('stores a PNG by content hash and serves it inline with an immutable cache', async () => {
    const response = await uploadAsset(pngBytes(), 'image/png', 'picture.png')
    expect(response.status).toBe(201)
    const asset = await bodyOf<{ id: string; url: string; mime: string; size: number; name: string }>(response)
    expect(asset.id).toMatch(/^[0-9a-f]{64}$/)
    expect(asset).toMatchObject({ url: `/api/office/assets/${asset.id}`, mime: 'image/png', size: 32, name: 'picture.png' })

    const read = await call('GET', `/assets/${asset.id}`)
    expect(read.status).toBe(200)
    expect(read.headers.get('content-type')).toBe('image/png')
    expect(read.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(read.headers.get('x-content-type-options')).toBe('nosniff')
    expect(read.headers.get('content-disposition')).toContain('inline;')
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(pngBytes())

    const again = await uploadAsset(pngBytes(), 'image/png', 'renamed.png')
    expect(again.status).toBe(200)
    expect((await bodyOf<{ id: string; name: string }>(again)).id).toBe(asset.id)
    expect(bucket.objects.size).toBe(1)
  })

  it('serves PDF inline and text as an attachment', async () => {
    const pdf = await bodyOf<{ id: string }>(await uploadAsset(pdfBytes(), 'application/pdf', 'scan.pdf'))
    const pdfRead = await call('GET', `/assets/${pdf.id}`)
    expect(pdfRead.headers.get('content-disposition')).toContain('inline;')

    const csv = await bodyOf<{ id: string; mime: string }>(
      await uploadAsset(textBytes('a,b\n1,2\n'), 'text/csv', 'rows.csv'),
    )
    expect(csv.mime).toBe('text/csv')
    const csvRead = await call('GET', `/assets/${csv.id}`)
    expect(csvRead.headers.get('content-disposition')).toContain('attachment;')
  })

  it('rejects SVG, HTML, script names and mislabelled bytes', async () => {
    expect((await uploadAsset(textBytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'text/plain', 'x.svg')).status).toBe(415)
    expect((await uploadAsset(textBytes('<!DOCTYPE html><html></html>'), 'text/plain', 'x.html')).status).toBe(415)
    expect((await uploadAsset(textBytes('const answer = 42\n'), 'text/plain', 'evil.js')).status).toBe(415)
    expect((await uploadAsset(textBytes('not really a png'), 'image/png', 'fake.png')).status).toBe(415)
    expect((await uploadAsset(gifBytes(), 'image/png', 'wrong.png')).status).toBe(415)
    expect((await uploadAsset(pngBytes(), 'text/plain', 'wrong.txt')).status).toBe(415)
  })

  it('refuses an asset above ten megabytes', async () => {
    const response = await uploadAsset(new Uint8Array(OFFICE_LIMITS.assetBytes + 1), 'application/pdf', 'huge.pdf')
    expect(response.status).toBe(413)
    expect((await bodyOf<ErrorJson>(response)).error.code).toBe('payload_too_large')
  })

  it('hides another account asset behind a 404', async () => {
    const asset = await bodyOf<{ id: string }>(await uploadAsset(pngBytes(), 'image/png', 'mine.png'))
    mocks.userId = OTHER
    expect((await call('GET', `/assets/${asset.id}`)).status).toBe(404)
  })

  it('keeps the same bytes as two per-account objects', async () => {
    const mine = await bodyOf<{ id: string }>(await uploadAsset(pngBytes(), 'image/png', 'mine.png'))
    mocks.userId = OTHER
    const theirs = await bodyOf<{ id: string }>(await uploadAsset(pngBytes(), 'image/png', 'theirs.png'))
    expect(theirs.id).toBe(mine.id)
    expect(bucket.objects.has(`office/images/${USER}/${mine.id}.png`)).toBe(true)
    expect(bucket.objects.has(`office/images/${OTHER}/${mine.id}.png`)).toBe(true)

    expect((await call('GET', `/assets/${mine.id}`)).status).toBe(200)
    mocks.userId = USER
    expect((await call('GET', `/assets/${mine.id}`)).status).toBe(200)
  })

  it('answers 503 when the deployment has no R2 binding', async () => {
    env = testBindings(makeD1(sqlite))
    const file = await call('POST', '/files', { type: 'docs', title: 'No storage' })
    expect(file.status).toBe(201)
    const id = (await bodyOf<{ file: FileJson }>(file)).file.id
    const snapshot = await call('PUT', `/files/${id}/snapshot`, { baseRev: 0, snapshot: { body: {} } })
    expect(snapshot.status).toBe(503)
    expect((await bodyOf<ErrorJson>(snapshot)).error.code).toBe('storage_unavailable')
    expect((await uploadAsset(pngBytes(), 'image/png')).status).toBe(503)
  })
})

describe('applying a plan without an editor', () => {
  it('writes the cells and lands on a new revision', async () => {
    const file = await createFile('sheets', 'Scheduled target')
    const snapshot = { sheets: { s1: { name: 'Sheet1', cellData: {} } }, sheetOrder: ['s1'] }
    const first = await call('PUT', `/files/${file.id}/snapshot`, { baseRev: 0, snapshot })
    expect(first.status).toBe(200)

    const applied = await call('POST', `/files/${file.id}/apply-plan`, {
      plan: {
        type: 'sheets',
        fileId: file.id,
        summary: 'Fill the morning row',
        ops: [{ kind: 'sheets.set-values', sheet: 'Sheet1', range: 'B2', values: [[42]] }],
      },
    })
    expect(applied.status).toBe(200)
    const body = await bodyOf<{ rev: number; applied: number }>(applied)
    expect(body.applied).toBe(1)

    const stored = await call('GET', `/files/${file.id}/snapshot`)
    const json = JSON.stringify((await bodyOf<{ snapshot: unknown }>(stored)).snapshot)
    expect(json).toContain('42')
    expect(body.rev).toBeGreaterThan(1)
  })

  it('refuses an operation the editor-free path does not implement', async () => {
    const file = await createFile('sheets', 'Styled target')
    const response = await call('POST', `/files/${file.id}/apply-plan`, {
      plan: {
        type: 'sheets',
        fileId: file.id,
        summary: 'Bold the header',
        ops: [{ kind: 'sheets.set-style', range: 'A1', bold: true }],
      },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('refuses a document that is not a sheet', async () => {
    const file = await createFile('docs', 'Text target')
    const response = await call('POST', `/files/${file.id}/apply-plan`, {
      plan: { type: 'docs', fileId: file.id, summary: 'Append', ops: [{ kind: 'docs.append-paragraph', text: 'x' }] },
    })
    expect(response.status).toBe(400)
  })
})
