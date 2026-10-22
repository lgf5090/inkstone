// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync, type Unzipped } from 'fflate'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_VERSION } from '../src/shared/constants'
import {
  MemoExportFormatError,
  isMemoExportEntryPath,
  memoExportArchiveFilename,
  memoExportAttachmentPath,
  memoExportSafeFilename,
  parseMemoExportManifest,
  parseMemoExportMemoRecord,
} from '../src/shared/memos/export'
import type { MemoState, MemoVisibility } from '../src/shared/memos/types'
import { initializeDatabase } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { buildMemoExport, type MemoExportArchive } from '../src/worker/memos/export'
import { memoTransferRoutes } from '../src/worker/routes/memos/transfer'
import {
  testBindings,
  testR2Bucket,
  type TestR2Bucket,
} from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const EXPORT_NOW = Date.UTC(2026, 8, 16, 8, 30, 0)
const BASE_TIME = 1_772_000_000
const NORMAL_CONTENT = '# Plan\n\nShip the export.\nNo trailing newline \u00e9\u2615'
const ARCHIVED_CONTENT = 'Archived note'
const COMMENT_CONTENT = 'Reply with #follow-up'
const BOB_CONTENT = 'Bob private note'
const PHOTO_FILENAME = '\u767d\u677f \u7167\u7247.jpg'
const ESCAPE_FILENAME = '../../escape:name.txt'
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const ESCAPE_BYTES = new TextEncoder().encode('escaped attachment')
const BOB_BYTES = new TextEncoder().encode('bob secret bytes')

const MEMO_NORMAL = id(1)
const MEMO_ARCHIVED = id(2)
const MEMO_COMMENT = id(3)
const MEMO_BOB = id(4)
const SPACE_WORK = id(10)
const SPACE_BOB = id(11)
const ATT_PHOTO = id(20)
const ATT_ESCAPE = id(21)
const ATT_BOB = id(22)

let sqlite: DatabaseSync
let db: D1Database
let r2: TestR2Bucket
let env: Env
let app: Hono<AppBindings>

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  db = makeD1(sqlite)
  r2 = testR2Bucket()
  env = testBindings(db, { FILES: r2 })
  await initializeDatabase(env)
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) c.set('userId', userId)
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/memos', memoTransferRoutes)
  await seedArchive()
})

afterEach(() => sqlite.close())

function id(value: number): string {
  return String(value).padStart(26, '0')
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function entry(entries: Unzipped, path: string): Uint8Array {
  const value = entries[path]
  if (!value) throw new Error(`Missing ZIP entry ${path}`)
  return value
}

function textOf(entries: Unzipped, path: string): string {
  return new TextDecoder().decode(entry(entries, path))
}

async function entriesOf(archive: MemoExportArchive): Promise<Unzipped> {
  const bytes = new Uint8Array(await new Response(archive.stream).arrayBuffer())
  return unzipSync(bytes)
}

function insertUser(userId: string, username: string, name: string): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'owner', '{}', ?, ?)`,
  ).run(userId, username, username, name, now, now)
}

function insertSpace(spaceId: string, userId: string, title: string): void {
  sqlite.prepare(
    `INSERT INTO memos_spaces (id, user_id, title, description, icon, created_at, updated_at)
     VALUES (?, ?, ?, '', '', 1, 1)`,
  ).run(spaceId, userId, title)
}

interface MemoSeed {
  memoId: string
  userId: string
  content: string
  visibility: MemoVisibility
  state: MemoState
  pinned?: boolean
  spaceId?: string
  parentId?: string
  location?: { placeholder: string; latitude: number; longitude: number }
  createdAt: number
  updatedAt: number
}

function insertMemo(seed: MemoSeed): void {
  const location = seed.location ?? null
  sqlite.prepare(
    `INSERT INTO memos_items (
       id, user_id, space_id, parent_id, content, title, snippet, visibility, state, pinned,
       has_location, location_placeholder, latitude, longitude, rev, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    seed.memoId,
    seed.userId,
    seed.spaceId ?? null,
    seed.parentId ?? null,
    seed.content,
    seed.visibility,
    seed.state,
    seed.pinned ? 1 : 0,
    location ? 1 : 0,
    location?.placeholder ?? null,
    location?.latitude ?? null,
    location?.longitude ?? null,
    seed.createdAt,
    seed.updatedAt,
  )
}

function insertTag(memoId: string, tag: string): void {
  sqlite.prepare('INSERT INTO memos_tags (memo_id, tag) VALUES (?, ?)').run(memoId, tag)
}

function insertRelation(memoId: string, relatedMemoId: string, createdAt: number): void {
  sqlite.prepare(
    'INSERT INTO memos_relations (memo_id, related_memo_id, created_at) VALUES (?, ?, ?)',
  ).run(memoId, relatedMemoId, createdAt)
}

interface AttachmentSeed {
  attachmentId: string
  userId: string
  memoId: string
  filename: string
  mime: string
  bytes: Uint8Array
  width?: number
  height?: number
  createdAt: number
}

async function insertAttachment(seed: AttachmentSeed): Promise<void> {
  const storageKey = `memo/${seed.userId}/${seed.attachmentId}.bin`
  sqlite.prepare(
    `INSERT INTO memos_attachments (
       id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
       thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'r2', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    seed.attachmentId,
    seed.userId,
    seed.memoId,
    seed.filename,
    seed.mime,
    seed.bytes.byteLength,
    storageKey,
    seed.width ?? null,
    seed.height ?? null,
    seed.createdAt,
    seed.createdAt,
  )
  await r2.put(storageKey, seed.bytes, { httpMetadata: { contentType: seed.mime } })
}

async function seedArchive(): Promise<void> {
  insertUser(ALICE, 'alice', 'Alice')
  insertUser(BOB, 'bob', 'Bob')
  insertSpace(SPACE_WORK, ALICE, 'Work')
  insertSpace(SPACE_BOB, BOB, 'Bob Space')

  insertMemo({
    memoId: MEMO_NORMAL,
    userId: ALICE,
    content: NORMAL_CONTENT,
    visibility: 'private',
    state: 'normal',
    pinned: true,
    spaceId: SPACE_WORK,
    location: { placeholder: 'Office', latitude: 52.52, longitude: 13.405 },
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 100,
  })
  insertMemo({
    memoId: MEMO_ARCHIVED,
    userId: ALICE,
    content: ARCHIVED_CONTENT,
    visibility: 'public',
    state: 'archived',
    createdAt: BASE_TIME + 200,
    updatedAt: BASE_TIME + 250,
  })
  insertMemo({
    memoId: MEMO_COMMENT,
    userId: ALICE,
    content: COMMENT_CONTENT,
    visibility: 'private',
    state: 'normal',
    spaceId: SPACE_WORK,
    parentId: MEMO_NORMAL,
    createdAt: BASE_TIME + 300,
    updatedAt: BASE_TIME + 300,
  })
  insertMemo({
    memoId: MEMO_BOB,
    userId: BOB,
    content: BOB_CONTENT,
    visibility: 'private',
    state: 'normal',
    spaceId: SPACE_BOB,
    createdAt: BASE_TIME + 400,
    updatedAt: BASE_TIME + 400,
  })

  insertTag(MEMO_NORMAL, 'work')
  insertTag(MEMO_NORMAL, 'work/q3')
  insertTag(MEMO_COMMENT, 'follow-up')
  insertTag(MEMO_BOB, 'bob-tag')
  insertRelation(MEMO_NORMAL, MEMO_ARCHIVED, 1)
  insertRelation(MEMO_BOB, MEMO_NORMAL, 2)

  await insertAttachment({
    attachmentId: ATT_PHOTO,
    userId: ALICE,
    memoId: MEMO_NORMAL,
    filename: PHOTO_FILENAME,
    mime: 'image/jpeg',
    bytes: PHOTO_BYTES,
    width: 640,
    height: 480,
    createdAt: BASE_TIME + 50,
  })
  await insertAttachment({
    attachmentId: ATT_ESCAPE,
    userId: ALICE,
    memoId: MEMO_ARCHIVED,
    filename: ESCAPE_FILENAME,
    mime: 'text/plain',
    bytes: ESCAPE_BYTES,
    createdAt: BASE_TIME + 60,
  })
  await insertAttachment({
    attachmentId: ATT_BOB,
    userId: BOB,
    memoId: MEMO_BOB,
    filename: 'bob.txt',
    mime: 'text/plain',
    bytes: BOB_BYTES,
    createdAt: BASE_TIME + 70,
  })
}

describe('memo export archive', () => {
  it('writes a manifest first with counts for normal, archived, and comment memos', async () => {
    const archive = await buildMemoExport(env, ALICE, { now: EXPORT_NOW })
    expect(archive.filename).toBe('memos-export-alice-20260916T083000Z.zip')

    const entries = await entriesOf(archive)
    expect(Object.keys(entries)[0]).toBe('manifest.json')
    expect(Object.keys(entries)).toHaveLength(9)

    const manifest = parseMemoExportManifest(JSON.parse(textOf(entries, 'manifest.json')))
    expect(manifest).toEqual({
      format: 'memos-export',
      formatVersion: '1.0',
      generator: { name: 'inkstone', version: APP_VERSION },
      exportTime: '2026-09-16T08:30:00Z',
      scope: { kind: 'USER', user: { username: 'alice', displayName: 'Alice' } },
      counts: { memos: 3, attachments: 2 },
    })
  })

  it('writes memo records and byte-identical Markdown for every state', async () => {
    const entries = await entriesOf(await buildMemoExport(env, ALICE, { now: EXPORT_NOW }))
    const normal = parseMemoExportMemoRecord(
      JSON.parse(textOf(entries, `memos/${MEMO_NORMAL}.json`)),
    )
    expect(normal).toMatchObject({
      uid: MEMO_NORMAL,
      creator: 'alice',
      createTime: '2026-02-25T06:13:20Z',
      updateTime: '2026-02-25T06:15:00Z',
      state: 'NORMAL',
      visibility: 'PRIVATE',
      pinned: true,
      contentPath: `memos/${MEMO_NORMAL}.md`,
      tags: ['work', 'work/q3'],
      location: { placeholder: 'Office', latitude: 52.52, longitude: 13.405 },
      space: { uid: SPACE_WORK, title: 'Work' },
      relations: [{ type: 'REFERENCE', memo: MEMO_ARCHIVED }],
    })
    expect(textOf(entries, `memos/${MEMO_NORMAL}.md`)).toBe(NORMAL_CONTENT)

    const archived = parseMemoExportMemoRecord(
      JSON.parse(textOf(entries, `memos/${MEMO_ARCHIVED}.json`)),
    )
    expect(archived).toMatchObject({
      uid: MEMO_ARCHIVED,
      state: 'ARCHIVED',
      visibility: 'PUBLIC',
      pinned: false,
      contentPath: `memos/${MEMO_ARCHIVED}.md`,
    })
    expect(archived.space).toBeUndefined()
    expect(archived.parent).toBeUndefined()
    expect(textOf(entries, `memos/${MEMO_ARCHIVED}.md`)).toBe(ARCHIVED_CONTENT)

    const comment = parseMemoExportMemoRecord(
      JSON.parse(textOf(entries, `memos/${MEMO_COMMENT}.json`)),
    )
    expect(comment.parent).toBe(MEMO_NORMAL)
    expect(comment.space).toEqual({ uid: SPACE_WORK, title: 'Work' })
    expect(comment.tags).toEqual(['follow-up'])
    expect(textOf(entries, `memos/${MEMO_COMMENT}.md`)).toBe(COMMENT_CONTENT)
  })

  it('copies attachment bytes from R2 with digests and safe entry names', async () => {
    const entries = await entriesOf(await buildMemoExport(env, ALICE, { now: EXPORT_NOW }))
    const normal = parseMemoExportMemoRecord(
      JSON.parse(textOf(entries, `memos/${MEMO_NORMAL}.json`)),
    )
    const photo = normal.attachments?.[0]
    if (!photo) throw new Error('Expected the photo attachment record')
    const photoPath = `attachments/${ATT_PHOTO}/${PHOTO_FILENAME}`
    expect(photo).toEqual({
      uid: ATT_PHOTO,
      filename: PHOTO_FILENAME,
      type: 'image/jpeg',
      size: PHOTO_BYTES.byteLength,
      sha256: sha256(PHOTO_BYTES),
      path: photoPath,
      createTime: '2026-02-25T06:14:10Z',
      mediaMetadata: { width: 640, height: 480 },
    })
    expect(isMemoExportEntryPath(photoPath)).toBe(true)
    expect(entry(entries, photoPath)).toEqual(PHOTO_BYTES)

    const archived = parseMemoExportMemoRecord(
      JSON.parse(textOf(entries, `memos/${MEMO_ARCHIVED}.json`)),
    )
    const escaped = archived.attachments?.[0]
    if (!escaped) throw new Error('Expected the escaped attachment record')
    const escapedPath = `attachments/${ATT_ESCAPE}/${memoExportSafeFilename(ESCAPE_FILENAME)}`
    expect(memoExportSafeFilename(ESCAPE_FILENAME)).toBe('_.._escape_name.txt')
    expect(escaped.path).toBe(escapedPath)
    expect(escaped.sha256).toBe(sha256(ESCAPE_BYTES))
    expect(escapedPath.split('/')).not.toContain('..')
    expect(isMemoExportEntryPath(escapedPath)).toBe(true)
    expect(entry(entries, escapedPath)).toEqual(ESCAPE_BYTES)
  })

  it('exports only the owner and never another account or internal keys', async () => {
    const entries = await entriesOf(await buildMemoExport(env, ALICE, { now: EXPORT_NOW }))
    const names = Object.keys(entries)
    expect(names.filter((path) => path.startsWith('attachments/'))).toHaveLength(2)
    expect(names.some((path) => path.includes(MEMO_BOB) || path.includes(ATT_BOB))).toBe(false)

    const text = names
      .filter((path) => path.endsWith('.json') || path.endsWith('.md'))
      .map((path) => textOf(entries, path))
      .join('\n')
    for (const marker of [
      MEMO_BOB,
      SPACE_BOB,
      ATT_BOB,
      'Bob Space',
      BOB_CONTENT,
      'bob secret bytes',
      'bob-tag',
      '"username":"bob"',
      'storage_key',
      'user_id',
    ]) {
      expect(text).not.toContain(marker)
    }

    const bobEntries = await entriesOf(await buildMemoExport(env, BOB, { now: EXPORT_NOW }))
    const bobManifest = parseMemoExportManifest(JSON.parse(textOf(bobEntries, 'manifest.json')))
    expect(bobManifest.scope.user).toEqual({ username: 'bob', displayName: 'Bob' })
    expect(bobManifest.counts).toEqual({ memos: 1, attachments: 1 })
    const bobRecord = parseMemoExportMemoRecord(
      JSON.parse(textOf(bobEntries, `memos/${MEMO_BOB}.json`)),
    )
    expect(bobRecord.creator).toBe('bob')
    expect(bobRecord.relations).toBeUndefined()
    expect(Object.keys(bobEntries).some((path) => path.includes(MEMO_NORMAL))).toBe(false)
  })

  it('serves the archive to an authenticated owner with zip headers', async () => {
    const anonymous = await app.request('http://localhost/api/memos/export', {}, env)
    expect(anonymous.status).toBe(401)

    const response = await app.request(
      'http://localhost/api/memos/export',
      { headers: { 'x-test-user': ALICE } },
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="memos-export-alice-\d{8}T\d{6}Z\.zip"; filename\*=UTF-8''memos-export-alice-\d{8}T\d{6}Z\.zip$/,
    )
    const body = new Uint8Array(await response.arrayBuffer())
    const entries = unzipSync(body)
    expect(Object.keys(entries)[0]).toBe('manifest.json')
    expect(parseMemoExportManifest(JSON.parse(textOf(entries, 'manifest.json'))).counts).toEqual({
      memos: 3,
      attachments: 2,
    })
  })

  it('refuses archives above the entry and byte caps before reading attachments', async () => {
    await expect(buildMemoExport(env, ALICE, { maxEntries: 4 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 413,
      code: 'payload_too_large',
    })
    await expect(buildMemoExport(env, ALICE, { maxTotalBytes: 64 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 413,
      code: 'payload_too_large',
    })
  })

  it('reports missing attachment storage and missing objects without writing an archive', async () => {
    await expect(buildMemoExport(testBindings(db), ALICE, { now: EXPORT_NOW })).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'storage_unavailable',
    })

    r2.objects.delete(`memo/${ALICE}/${ATT_PHOTO}.bin`)
    await expect(buildMemoExport(env, ALICE, { now: EXPORT_NOW })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      code: 'internal',
    })
  })
})

describe('memos export format helpers', () => {
  it('rejects unsupported manifest versions and missing scope users', async () => {
    const entries = await entriesOf(await buildMemoExport(env, ALICE, { now: EXPORT_NOW }))
    const manifest = parseMemoExportManifest(JSON.parse(textOf(entries, 'manifest.json')))
    expect(() => parseMemoExportManifest({ ...manifest, formatVersion: '2.0' })).toThrow(
      MemoExportFormatError,
    )
    expect(() => parseMemoExportManifest({ ...manifest, scope: { kind: 'USER' } })).toThrow(
      MemoExportFormatError,
    )
  })

  it('rejects unsafe content paths, unknown enums, and attachments without a valid digest', async () => {
    const entries = await entriesOf(await buildMemoExport(env, ALICE, { now: EXPORT_NOW }))
    const record = parseMemoExportMemoRecord(
      JSON.parse(textOf(entries, `memos/${MEMO_NORMAL}.json`)),
    )
    expect(() => parseMemoExportMemoRecord({ ...record, contentPath: '../escape.md' })).toThrow(
      MemoExportFormatError,
    )
    expect(() => parseMemoExportMemoRecord({ ...record, visibility: 'SECRET' })).toThrow(
      MemoExportFormatError,
    )
    const attachment = record.attachments?.[0]
    if (!attachment) throw new Error('Expected an attachment record')
    expect(() =>
      parseMemoExportMemoRecord({
        ...record,
        attachments: [{ ...attachment, sha256: 'not-a-digest' }],
      }),
    ).toThrow(MemoExportFormatError)
    expect(() =>
      parseMemoExportMemoRecord({
        ...record,
        attachments: [{ ...attachment, path: '../escape.jpg' }],
      }),
    ).toThrow(MemoExportFormatError)
  })

  it('maps filenames and builds archive names the way the format requires', () => {
    expect(memoExportSafeFilename('a/b:c.txt')).toBe('a_b_c.txt')
    expect(memoExportSafeFilename('CON')).toBe('_CON')
    expect(memoExportSafeFilename('con.txt')).toBe('_con.txt')
    expect(memoExportSafeFilename(' ... ')).toBe('file')
    expect(memoExportSafeFilename(ESCAPE_FILENAME)).toBe('_.._escape_name.txt')
    expect(memoExportAttachmentPath(ATT_PHOTO, 'x/../../y.txt').split('/')).not.toContain('..')
    expect(memoExportArchiveFilename('alice', '2026-09-16T08:30:00Z')).toBe(
      'memos-export-alice-20260916T083000Z.zip',
    )
    expect(() => memoExportArchiveFilename('alice', '2026-09-16 08:30:00')).toThrow(
      MemoExportFormatError,
    )
  })
})
