// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Zip, ZipPassThrough, unzipSync, zipSync, type Unzipped } from 'fflate'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MEMO_IMPORT_CHUNK_BYTES,
  MEMO_IMPORT_MANIFEST_MAX_BYTES,
  MEMO_IMPORT_RECORD_MAX_BYTES,
} from '../src/shared/memos/constants'
import type {
  MemoImportPlan,
  MemoImportReport,
  MemoImportSession,
} from '../src/shared/memos/types'
import { initializeDatabase } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { createMemoImportSession } from '../src/worker/memos/import'
import { memoTransferRoutes } from '../src/worker/routes/memos/transfer'
import {
  testBindings,
  testR2Bucket,
  type TestR2Bucket,
} from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const CHARLIE = 'user-charlie'
const BASE_TIME = 1_772_000_000
const NORMAL_CONTENT = 'Ship the export. #work #work/q3'
const ARCHIVED_CONTENT = 'Archived note'
const COMMENT_CONTENT = 'Reply with #follow-up'
const REPLACED_CONTENT = 'Changed during import #replaced'
const PHOTO_FILENAME = 'photo.png'
const TEXT_FILENAME = 'note.txt'
const PHOTO_BYTES = pngBytes(640, 480)
const TEXT_BYTES = new TextEncoder().encode('attachment text')

const MEMO_MAIN = id(1)
const MEMO_ARCHIVED = id(2)
const MEMO_COMMENT = id(3)
const SPACE_WORK = id(10)
const ATT_PHOTO = id(20)
const ATT_TEXT = id(21)

interface Instance {
  sqlite: DatabaseSync
  db: D1Database
  r2: TestR2Bucket
  env: Env
  app: Hono<AppBindings>
}

const openInstances: DatabaseSync[] = []
let source: Instance

beforeEach(async () => {
  source = await createInstance()
  await seedSource(source)
})

afterEach(() => {
  for (const sqlite of openInstances.splice(0)) sqlite.close()
})

async function createInstance(): Promise<Instance> {
  const sqlite = new DatabaseSync(':memory:')
  openInstances.push(sqlite)
  const db = makeD1(sqlite)
  const r2 = testR2Bucket()
  const env = testBindings(db, { FILES: r2 })
  await initializeDatabase(env)
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) c.set('userId', userId)
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/memos', memoTransferRoutes)
  return { sqlite, db, r2, env, app }
}

function id(value: number): string {
  return String(value).padStart(26, '0')
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function encode(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text))
}

function incompressibleText(length: number): string {
  let seed = 123456789
  let output = ''
  for (let index = 0; index < length; index++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    output += String.fromCharCode(65 + (seed % 26))
  }
  return output
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function query<T>(instance: Instance, sql: string, ...params: Array<string | number | null>): T[] {
  return instance.sqlite.prepare(sql).all(...params) as T[]
}

function queryOne<T>(instance: Instance, sql: string, ...params: Array<string | number | null>): T | undefined {
  return instance.sqlite.prepare(sql).get(...params) as T | undefined
}

function count(instance: Instance, sql: string, ...params: Array<string | number | null>): number {
  return Number(queryOne<{ n: number }>(instance, sql, ...params)?.n ?? 0)
}

function run(instance: Instance, sql: string, ...params: Array<string | number | null>): void {
  instance.sqlite.prepare(sql).run(...params)
}

function insertUser(instance: Instance, userId: string, username: string, name: string): void {
  const now = Date.now()
  run(
    instance,
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'owner', '{}', ?, ?)`,
    userId,
    username,
    username,
    name,
    now,
    now,
  )
}

function insertSpace(instance: Instance, spaceId: string, userId: string, title: string): void {
  run(
    instance,
    `INSERT INTO memos_spaces (id, user_id, title, description, icon, created_at, updated_at)
     VALUES (?, ?, ?, '', '', 1, 1)`,
    spaceId,
    userId,
    title,
  )
}

interface MemoSeed {
  memoId: string
  userId: string
  content: string
  visibility: 'private' | 'protected' | 'public'
  state: 'normal' | 'archived'
  pinned?: boolean
  spaceId?: string
  parentId?: string
  location?: { placeholder: string; latitude: number; longitude: number }
  createdAt: number
  updatedAt: number
}

function insertMemo(instance: Instance, seed: MemoSeed): void {
  const location = seed.location ?? null
  run(
    instance,
    `INSERT INTO memos_items (
       id, user_id, space_id, parent_id, content, title, snippet, visibility, state, pinned,
       has_location, location_placeholder, latitude, longitude, rev, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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

function insertAttachment(
  instance: Instance,
  attachmentId: string,
  userId: string,
  memoId: string,
  filename: string,
  mime: string,
  bytes: Uint8Array,
  createdAt: number,
): void {
  const extension = filename.split('.').pop() ?? 'bin'
  const storageKey = `memo/${userId}/${attachmentId}.${extension}`
  run(
    instance,
    `INSERT INTO memos_attachments (
       id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
       thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'r2', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    attachmentId,
    userId,
    memoId,
    filename,
    mime,
    bytes.byteLength,
    storageKey,
    createdAt,
    createdAt,
  )
  instance.r2.put(storageKey, bytes, { httpMetadata: { contentType: mime } })
}

async function seedSource(instance: Instance): Promise<void> {
  insertUser(instance, ALICE, 'alice', 'Alice')
  insertSpace(instance, SPACE_WORK, ALICE, 'Work')

  insertMemo(instance, {
    memoId: MEMO_MAIN,
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
  insertMemo(instance, {
    memoId: MEMO_ARCHIVED,
    userId: ALICE,
    content: ARCHIVED_CONTENT,
    visibility: 'public',
    state: 'archived',
    createdAt: BASE_TIME + 200,
    updatedAt: BASE_TIME + 250,
  })
  insertMemo(instance, {
    memoId: MEMO_COMMENT,
    userId: ALICE,
    content: COMMENT_CONTENT,
    visibility: 'private',
    state: 'normal',
    spaceId: SPACE_WORK,
    parentId: MEMO_MAIN,
    createdAt: BASE_TIME + 300,
    updatedAt: BASE_TIME + 300,
  })

  run(instance, 'INSERT INTO memos_tags (memo_id, tag) VALUES (?, ?)', MEMO_MAIN, 'work')
  run(instance, 'INSERT INTO memos_tags (memo_id, tag) VALUES (?, ?)', MEMO_MAIN, 'work/q3')
  run(instance, 'INSERT INTO memos_tags (memo_id, tag) VALUES (?, ?)', MEMO_COMMENT, 'follow-up')
  run(
    instance,
    'INSERT INTO memos_relations (memo_id, related_memo_id, created_at) VALUES (?, ?, ?)',
    MEMO_MAIN,
    MEMO_ARCHIVED,
    1,
  )

  insertAttachment(instance, ATT_PHOTO, ALICE, MEMO_MAIN, PHOTO_FILENAME, 'image/png', PHOTO_BYTES, BASE_TIME + 50)
  insertAttachment(instance, ATT_TEXT, ALICE, MEMO_ARCHIVED, TEXT_FILENAME, 'text/plain', TEXT_BYTES, BASE_TIME + 60)
}

async function exportArchive(instance: Instance, userId = ALICE): Promise<Uint8Array> {
  const response = await instance.app.request(
    'http://localhost/api/memos/export',
    { headers: { 'x-test-user': userId } },
    instance.env,
  )
  expect(response.status).toBe(200)
  return new Uint8Array(await response.arrayBuffer())
}

async function jsonRequest(
  instance: Instance,
  userId: string,
  path: string,
  method: string,
  body: unknown,
): Promise<Response> {
  return await instance.app.request(
    `http://localhost${path}`,
    {
      method,
      headers: { 'x-test-user': userId, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    instance.env,
  )
}

async function createSession(instance: Instance, userId: string, totalSize: number): Promise<MemoImportSession> {
  const response = await jsonRequest(instance, userId, '/api/memos/import/sessions', 'POST', {
    filename: 'memos.zip',
    totalSize,
  })
  expect(response.status).toBe(201)
  return await response.json() as MemoImportSession
}

async function putChunk(
  instance: Instance,
  userId: string,
  sessionId: string,
  offset: number,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  return await instance.app.request(
    `http://localhost/api/memos/import/sessions/${sessionId}`,
    {
      method: 'PUT',
      headers: { 'x-test-user': userId, 'x-chunk-offset': String(offset) },
      body: bytes,
    },
    instance.env,
  )
}

async function uploadArchive(
  instance: Instance,
  userId: string,
  bytes: Uint8Array,
): Promise<MemoImportSession> {
  const session = await createSession(instance, userId, bytes.byteLength)
  for (let offset = 0; offset < bytes.byteLength; offset += MEMO_IMPORT_CHUNK_BYTES) {
    const chunk = bytes.slice(offset, Math.min(offset + MEMO_IMPORT_CHUNK_BYTES, bytes.byteLength))
    const response = await putChunk(instance, userId, session.id, offset, chunk)
    expect(response.status).toBe(200)
  }
  return session
}

function planSession(instance: Instance, userId: string, sessionId: string): Promise<Response> {
  return Promise.resolve(instance.app.request(
    `http://localhost/api/memos/import/sessions/${sessionId}/plan`,
    { method: 'POST', headers: { 'x-test-user': userId } },
    instance.env,
  ))
}

function commitSession(
  instance: Instance,
  userId: string,
  sessionId: string,
  body: unknown = {},
): Promise<Response> {
  return jsonRequest(
    instance,
    userId,
    `/api/memos/import/sessions/${sessionId}/commit`,
    'POST',
    body,
  )
}

async function importArchive(
  instance: Instance,
  userId: string,
  bytes: Uint8Array,
  conflictPolicy?: string,
): Promise<{ session: MemoImportSession; plan: MemoImportPlan; report: MemoImportReport }> {
  const session = await uploadArchive(instance, userId, bytes)
  const planResponse = await planSession(instance, userId, session.id)
  expect(planResponse.status).toBe(200)
  const plan = await planResponse.json() as MemoImportPlan
  const commitResponse = await commitSession(
    instance,
    userId,
    session.id,
    conflictPolicy === undefined ? {} : { conflictPolicy },
  )
  expect(commitResponse.status).toBe(200)
  const report = await commitResponse.json() as MemoImportReport
  return { session, plan, report }
}

function editArchive(bytes: Uint8Array, edit: (entries: Unzipped) => void): Uint8Array {
  const entries = unzipSync(bytes)
  edit(entries)
  return zipSync(entries)
}

function readRecord(entries: Unzipped, uid: string): Record<string, unknown> {
  const bytes = entries[`memos/${uid}.json`]
  if (!bytes) throw new Error(`Missing memo record ${uid}`)
  return JSON.parse(decode(bytes)) as Record<string, unknown>
}

function writeRecord(entries: Unzipped, uid: string, record: Record<string, unknown>): void {
  entries[`memos/${uid}.json`] = encode(JSON.stringify(record))
}

function setContent(entries: Unzipped, uid: string, content: string): void {
  entries[`memos/${uid}.md`] = encode(content)
}

function manifestBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return encode(JSON.stringify({
    format: 'memos-export',
    formatVersion: '1.0',
    generator: { name: 'memos', version: '0.31.0' },
    exportTime: '2026-09-16T08:30:00Z',
    scope: { kind: 'USER', user: { username: 'alice' } },
    counts: { memos: 0, attachments: 0 },
    ...overrides,
  }))
}

function memoRecord(uid: string, contentPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid,
    creator: 'alice',
    createTime: '2026-03-02T14:05:11Z',
    updateTime: '2026-03-02T14:20:47Z',
    state: 'NORMAL',
    visibility: 'PRIVATE',
    pinned: false,
    contentPath,
    ...overrides,
  }
}

function zipEntries(entries: Array<[string, Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = []
  let failure: Error | null = null
  const zip = new Zip((error, chunk) => {
    if (error) failure = error
    else if (chunk.byteLength) chunks.push(chunk)
  })
  for (const [name, bytes] of entries) {
    const file = new ZipPassThrough(name)
    zip.add(file)
    file.push(bytes, true)
  }
  zip.end()
  if (failure) throw failure
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function expectImportFailure(
  instance: Instance,
  bytes: Uint8Array,
  status: number,
  code: string,
): Promise<void> {
  const session = await uploadArchive(instance, ALICE, bytes)
  const response = await planSession(instance, ALICE, session.id)
  expect(response.status).toBe(status)
  const body = await response.json() as { error: { code: string } }
  expect(body.error.code).toBe(code)
}

describe('memo import sessions', () => {
  it('round-trips an export into a fresh instance with metadata, relations, spaces, and attachments', async () => {
    const target = await createInstance()
    insertUser(target, CHARLIE, 'charlie', 'Charlie')
    const archive = await exportArchive(source)

    const { plan, report } = await importArchive(target, CHARLIE, archive)

    expect(plan).toMatchObject({
      exporter: 'alice',
      memoCount: 3,
      attachmentCount: 2,
      newCount: 3,
      existingCount: 0,
      renamedCount: 0,
    })
    expect(plan.exportTime).toBeGreaterThan(0)
    expect(report).toEqual({
      created: 3,
      updated: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      warnings: [],
    })

    const main = queryOne<{
      content: string
      visibility: string
      state: string
      pinned: number
      space_id: string | null
      location_placeholder: string | null
      latitude: number | null
      longitude: number | null
      created_at: number
      updated_at: number
    }>(target, 'SELECT content, visibility, state, pinned, space_id, location_placeholder, latitude, longitude, created_at, updated_at FROM memos_items WHERE user_id = ? AND id = ?', CHARLIE, MEMO_MAIN)
    expect(main).toMatchObject({
      content: NORMAL_CONTENT,
      visibility: 'private',
      state: 'normal',
      pinned: 1,
      space_id: SPACE_WORK,
      location_placeholder: 'Office',
      latitude: 52.52,
      longitude: 13.405,
      created_at: BASE_TIME,
      updated_at: BASE_TIME + 100,
    })
    expect(queryOne<{ title: string }>(target, 'SELECT title FROM memos_spaces WHERE id = ?', SPACE_WORK)?.title).toBe('Work')

    const archived = queryOne<{ visibility: string; state: string }>(target, 'SELECT visibility, state FROM memos_items WHERE id = ?', MEMO_ARCHIVED)
    expect(archived).toEqual({ visibility: 'public', state: 'archived' })

    const comment = queryOne<{ parent_id: string | null; space_id: string | null }>(target, 'SELECT parent_id, space_id FROM memos_items WHERE id = ?', MEMO_COMMENT)
    expect(comment).toEqual({ parent_id: MEMO_MAIN, space_id: SPACE_WORK })

    expect(query<{ tag: string }>(target, 'SELECT tag FROM memos_tags WHERE memo_id = ? ORDER BY tag ASC', MEMO_MAIN).map((row) => row.tag)).toEqual(['work', 'work/q3'])
    expect(query<{ tag: string }>(target, 'SELECT tag FROM memos_tags WHERE memo_id = ?', MEMO_COMMENT).map((row) => row.tag)).toEqual(['follow-up'])
    expect(query<{ related_memo_id: string }>(target, 'SELECT related_memo_id FROM memos_relations WHERE memo_id = ?', MEMO_MAIN).map((row) => row.related_memo_id)).toEqual([MEMO_ARCHIVED])

    const attachments = query<{ id: string; filename: string; mime: string; storage_key: string; memo_id: string }>(target, 'SELECT id, filename, mime, storage_key, memo_id FROM memos_attachments WHERE user_id = ? ORDER BY id ASC', CHARLIE)
    expect(attachments.map((row) => ({ id: row.id, filename: row.filename, mime: row.mime, memo_id: row.memo_id }))).toEqual([
      { id: ATT_PHOTO, filename: PHOTO_FILENAME, mime: 'image/png', memo_id: MEMO_MAIN },
      { id: ATT_TEXT, filename: TEXT_FILENAME, mime: 'text/plain', memo_id: MEMO_ARCHIVED },
    ])
    expect(target.r2.objects.get(attachments[0]!.storage_key)).toEqual(PHOTO_BYTES)
    expect(target.r2.objects.get(attachments[1]!.storage_key)).toEqual(TEXT_BYTES)
    expect([...target.r2.objects.keys()].some((key) => key.startsWith('memo-import/'))).toBe(false)
  })

  it('skips existing memos under the skip policy', async () => {
    const archive = editArchive(await exportArchive(source), (entries) => {
      setContent(entries, MEMO_MAIN, REPLACED_CONTENT)
      const record = readRecord(entries, MEMO_MAIN)
      record.updateTime = '2026-09-16T08:31:00Z'
      writeRecord(entries, MEMO_MAIN, record)
    })

    const { plan, report } = await importArchive(source, ALICE, archive, 'skip')

    expect(plan).toMatchObject({ newCount: 0, existingCount: 3, renamedCount: 0 })
    expect(report).toEqual({
      created: 0,
      updated: 0,
      skipped: 3,
      failed: 0,
      failures: [],
      warnings: [],
    })
    expect(queryOne<{ content: string }>(source, 'SELECT content FROM memos_items WHERE id = ?', MEMO_MAIN)?.content).toBe(NORMAL_CONTENT)
  })

  it('replaces existing memos and reuses their attachments', async () => {
    const archive = editArchive(await exportArchive(source), (entries) => {
      setContent(entries, MEMO_MAIN, REPLACED_CONTENT)
      const record = readRecord(entries, MEMO_MAIN)
      record.updateTime = '2026-09-16T08:31:00Z'
      writeRecord(entries, MEMO_MAIN, record)
      const archived = readRecord(entries, MEMO_ARCHIVED)
      delete archived.attachments
      writeRecord(entries, MEMO_ARCHIVED, archived)
      const manifest = JSON.parse(decode(entries['manifest.json']!)) as Record<string, unknown>
      manifest.counts = { memos: 3, attachments: 1 }
      entries['manifest.json'] = encode(JSON.stringify(manifest))
    })

    const { report } = await importArchive(source, ALICE, archive, 'replace')

    expect(report).toEqual({
      created: 0,
      updated: 3,
      skipped: 0,
      failed: 0,
      failures: [],
      warnings: [],
    })
    const main = queryOne<{ content: string; updated_at: number; pinned: number; state: string }>(source, 'SELECT content, updated_at, pinned, state FROM memos_items WHERE id = ?', MEMO_MAIN)
    expect(main).toEqual({
      content: REPLACED_CONTENT,
      updated_at: Date.parse('2026-09-16T08:31:00Z') / 1000,
      pinned: 1,
      state: 'normal',
    })
    expect(query<{ tag: string }>(source, 'SELECT tag FROM memos_tags WHERE memo_id = ?', MEMO_MAIN).map((row) => row.tag)).toEqual(['replaced'])
    expect(query<{ id: string; memo_id: string }>(source, 'SELECT id, memo_id FROM memos_attachments ORDER BY id ASC')).toEqual([
      { id: ATT_PHOTO, memo_id: MEMO_MAIN },
      { id: ATT_TEXT, memo_id: MEMO_ARCHIVED },
    ])
  })

  it('duplicates existing memos under fresh UIDs', async () => {
    const { report } = await importArchive(source, ALICE, await exportArchive(source), 'duplicate')

    expect(report.created).toBe(3)
    expect(report.updated).toBe(0)
    expect(report.skipped).toBe(0)
    expect(count(source, 'SELECT COUNT(*) AS n FROM memos_items WHERE user_id = ?', ALICE)).toBe(6)
    expect(count(source, 'SELECT COUNT(*) AS n FROM memos_items WHERE user_id = ? AND content = ?', ALICE, NORMAL_CONTENT)).toBe(2)

    const copies = query<{ id: string }>(source, 'SELECT id FROM memos_items WHERE user_id = ? AND content = ? AND id <> ?', ALICE, NORMAL_CONTENT, MEMO_MAIN)
    expect(copies).toHaveLength(1)
    const copyId = copies[0]!.id
    const commentCopy = queryOne<{ parent_id: string | null }>(source, 'SELECT parent_id FROM memos_items WHERE user_id = ? AND content = ? AND id <> ?', ALICE, COMMENT_CONTENT, MEMO_COMMENT)
    expect(commentCopy?.parent_id).toBe(copyId)
    const archivedCopy = queryOne<{ id: string }>(source, 'SELECT id FROM memos_items WHERE user_id = ? AND content = ? AND id <> ?', ALICE, ARCHIVED_CONTENT, MEMO_ARCHIVED)
    expect(query<{ related_memo_id: string }>(source, 'SELECT related_memo_id FROM memos_relations WHERE memo_id = ?', copyId).map((row) => row.related_memo_id)).toEqual([archivedCopy?.id])
    expect(count(source, 'SELECT COUNT(*) AS n FROM memos_attachments WHERE user_id = ?', ALICE)).toBe(4)
    expect(query<{ id: string }>(source, 'SELECT id FROM memos_attachments WHERE user_id = ? AND id IN (?, ?)', ALICE, ATT_PHOTO, ATT_TEXT)).toHaveLength(2)
  })

  it('gives a fresh UID when another account owns the archive UID', async () => {
    const archive = await exportArchive(source)
    const target = await createInstance()
    insertUser(target, BOB, 'bob', 'Bob')
    insertUser(target, CHARLIE, 'charlie', 'Charlie')
    insertMemo(target, {
      memoId: MEMO_MAIN,
      userId: CHARLIE,
      content: 'Charlie original',
      visibility: 'private',
      state: 'normal',
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    })

    const session = await uploadArchive(target, BOB, archive)
    const planResponse = await planSession(target, BOB, session.id)
    expect(planResponse.status).toBe(200)
    const plan = await planResponse.json() as MemoImportPlan
    expect(plan).toMatchObject({ memoCount: 3, newCount: 2, existingCount: 0, renamedCount: 1 })

    const commitResponse = await commitSession(target, BOB, session.id, { conflictPolicy: 'skip' })
    expect(commitResponse.status).toBe(200)
    const report = await commitResponse.json() as MemoImportReport
    expect(report.created).toBe(3)
    expect(report.skipped).toBe(0)

    expect(queryOne<{ content: string }>(target, 'SELECT content FROM memos_items WHERE id = ?', MEMO_MAIN)?.content).toBe('Charlie original')
    const importedMain = queryOne<{ id: string }>(target, 'SELECT id FROM memos_items WHERE user_id = ? AND content = ?', BOB, NORMAL_CONTENT)
    expect(importedMain).toBeDefined()
    expect(importedMain?.id).not.toBe(MEMO_MAIN)
    const importedMainId = importedMain?.id
    if (!importedMainId) throw new Error('The imported main memo was not created')
    const importedArchived = queryOne<{ id: string }>(target, 'SELECT id FROM memos_items WHERE user_id = ? AND content = ?', BOB, ARCHIVED_CONTENT)
    const importedComment = queryOne<{ parent_id: string | null }>(target, 'SELECT parent_id FROM memos_items WHERE user_id = ? AND content = ?', BOB, COMMENT_CONTENT)
    expect(importedComment?.parent_id).toBe(importedMainId)
    expect(query<{ related_memo_id: string }>(target, 'SELECT related_memo_id FROM memos_relations WHERE memo_id = ?', importedMainId).map((row) => row.related_memo_id)).toEqual([importedArchived?.id])
  })

  it('accepts chunks with offsets and retries and rejects gaps and oversized chunks', async () => {
    const total = MEMO_IMPORT_CHUNK_BYTES + 16
    const session = await createSession(source, ALICE, total)
    expect(session.chunkSize).toBe(MEMO_IMPORT_CHUNK_BYTES)

    const first = new Uint8Array(MEMO_IMPORT_CHUNK_BYTES).fill(7)
    let response = await putChunk(source, ALICE, session.id, 0, first)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: MEMO_IMPORT_CHUNK_BYTES })

    response = await putChunk(source, ALICE, session.id, 0, first)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: MEMO_IMPORT_CHUNK_BYTES })

    response = await putChunk(source, ALICE, session.id, 123, first)
    expect(response.status).toBe(409)
    const gap = await response.json() as { error: { code: string; details: { expectedOffset: number } } }
    expect(gap.error.code).toBe('memo_import_conflict')
    expect(gap.error.details.expectedOffset).toBe(MEMO_IMPORT_CHUNK_BYTES)

    response = await putChunk(source, ALICE, session.id, MEMO_IMPORT_CHUNK_BYTES, new Uint8Array(16))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: total })

    response = await putChunk(source, ALICE, session.id, MEMO_IMPORT_CHUNK_BYTES, new Uint8Array(16))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: total })

    const oversized = await createSession(source, ALICE, MEMO_IMPORT_CHUNK_BYTES + 1)
    response = await putChunk(source, ALICE, oversized.id, 0, new Uint8Array(MEMO_IMPORT_CHUNK_BYTES + 1))
    expect(response.status).toBe(413)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('memo_import_too_large')

    const short = await createSession(source, ALICE, 1000)
    response = await putChunk(source, ALICE, short.id, 0, new Uint8Array(10))
    expect(response.status).toBe(400)

    response = await source.app.request(
      `http://localhost/api/memos/import/sessions/${short.id}`,
      { method: 'PUT', headers: { 'x-test-user': ALICE }, body: new Uint8Array(10) },
      source.env,
    )
    expect(response.status).toBe(400)
  })

  it('reports incomplete uploads and rejects unknown conflict policies', async () => {
    const partial = await createSession(source, ALICE, MEMO_IMPORT_CHUNK_BYTES + 1)
    const first = await putChunk(source, ALICE, partial.id, 0, new Uint8Array(MEMO_IMPORT_CHUNK_BYTES))
    expect(first.status).toBe(200)

    let response = await planSession(source, ALICE, partial.id)
    expect(response.status).toBe(409)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('memo_import_conflict')
    response = await commitSession(source, ALICE, partial.id)
    expect(response.status).toBe(409)

    const archive = await exportArchive(source)
    const session = await uploadArchive(source, ALICE, archive)
    response = await commitSession(source, ALICE, session.id, { conflictPolicy: 'merge' })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('memo_import_invalid')
  })

  it('cancels a session and removes staged objects', async () => {
    const archive = await exportArchive(source)
    const session = await uploadArchive(source, ALICE, archive)
    expect([...source.r2.objects.keys()].some((key) => key.startsWith('memo-import/'))).toBe(true)

    const response = await source.app.request(
      `http://localhost/api/memos/import/sessions/${session.id}`,
      { method: 'DELETE', headers: { 'x-test-user': ALICE } },
      source.env,
    )
    expect(response.status).toBe(200)
    expect(queryOne(source, 'SELECT id FROM memos_import_sessions WHERE id = ?', session.id)).toBeUndefined()
    expect([...source.r2.objects.keys()].some((key) => key.startsWith('memo-import/'))).toBe(false)

    const again = await source.app.request(
      `http://localhost/api/memos/import/sessions/${session.id}`,
      { method: 'DELETE', headers: { 'x-test-user': ALICE } },
      source.env,
    )
    expect(again.status).toBe(404)
  })

  it('expires sessions after their TTL', async () => {
    const archive = await exportArchive(source)
    const session = await uploadArchive(source, ALICE, archive)
    run(source, 'UPDATE memos_import_sessions SET expires_at = 0 WHERE id = ?', session.id)

    const response = await planSession(source, ALICE, session.id)
    expect(response.status).toBe(404)
    expect(queryOne(source, 'SELECT id FROM memos_import_sessions WHERE id = ?', session.id)).toBeUndefined()
    expect([...source.r2.objects.keys()].some((key) => key.startsWith('memo-import/'))).toBe(false)
  })

  it('validates session creation input and storage availability', async () => {
    let response = await jsonRequest(source, ALICE, '/api/memos/import/sessions', 'POST', { totalSize: 10 })
    expect(response.status).toBe(400)
    response = await jsonRequest(source, ALICE, '/api/memos/import/sessions', 'POST', { filename: 'x.zip', totalSize: 0 })
    expect(response.status).toBe(400)
    response = await jsonRequest(source, ALICE, '/api/memos/import/sessions', 'POST', {
      filename: 'x.zip',
      totalSize: 64 * 1024 * 1024 + 1,
    })
    expect(response.status).toBe(413)
    await expect(createMemoImportSession(testBindings(source.db), ALICE, {
      filename: 'x.zip',
      totalSize: 10,
    })).rejects.toMatchObject({ status: 503, code: 'storage_unavailable' })
  })

  it('requires authentication and session ownership', async () => {
    const session = await createSession(source, ALICE, 10)
    let response = await source.app.request(
      `http://localhost/api/memos/import/sessions/${session.id}/plan`,
      { method: 'POST' },
      source.env,
    )
    expect(response.status).toBe(401)
    response = await source.app.request(
      'http://localhost/api/memos/import/sessions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x.zip', totalSize: 10 }) },
      source.env,
    )
    expect(response.status).toBe(401)

    response = await planSession(source, BOB, session.id)
    expect(response.status).toBe(404)
    response = await source.app.request(
      `http://localhost/api/memos/import/sessions/${session.id}`,
      { method: 'DELETE', headers: { 'x-test-user': BOB } },
      source.env,
    )
    expect(response.status).toBe(404)
  })
})

describe('memo import archive validation', () => {
  it('rejects path traversal and duplicate entry names', async () => {
    await expectImportFailure(
      source,
      zipSync({
        'manifest.json': manifestBytes(),
        '../escape.md': encode('escape'),
      }),
      400,
      'memo_import_invalid',
    )

    await expectImportFailure(
      source,
      zipEntries([
        ['manifest.json', manifestBytes()],
        ['manifest.json', manifestBytes()],
      ]),
      400,
      'memo_import_invalid',
    )
  })

  it('rejects oversized manifest, record, and expanding archives', async () => {
    await expectImportFailure(
      source,
      zipSync({ 'manifest.json': new Uint8Array(MEMO_IMPORT_MANIFEST_MAX_BYTES + 1) }),
      413,
      'memo_import_too_large',
    )

    await expectImportFailure(
      source,
      zipSync({
        'manifest.json': manifestBytes(),
        [`memos/${id(40)}.json`]: new Uint8Array(MEMO_IMPORT_RECORD_MAX_BYTES + 1),
      }),
      413,
      'memo_import_too_large',
    )

    await expectImportFailure(
      source,
      zipSync({
        'manifest.json': manifestBytes(),
        [`memos/${id(41)}.md`]: new Uint8Array(8 * 1024 * 1024),
      }),
      413,
      'memo_import_too_large',
    )
  })

  it('rejects an unsupported manifest version', async () => {
    await expectImportFailure(
      source,
      zipSync({ 'manifest.json': manifestBytes({ formatVersion: '2.0' }) }),
      400,
      'memo_import_invalid',
    )
  })

  it('rejects records whose UID does not match their file name', async () => {
    const uid = id(42)
    await expectImportFailure(
      source,
      zipSync({
        'manifest.json': manifestBytes({ counts: { memos: 1, attachments: 0 } }),
        [`memos/${uid}.json`]: encode(JSON.stringify(memoRecord(id(43), `memos/${uid}.md`))),
        [`memos/${uid}.md`]: encode('content'),
      }),
      400,
      'memo_import_invalid',
    )
  })
})

describe('memo import reports', () => {
  it('fails one record and continues when its content is too large', async () => {
    const bigUid = id(50)
    const smallUid = id(51)
    const bigContent = incompressibleText(2_100_000)
    const archive = zipSync({
      'manifest.json': manifestBytes({ counts: { memos: 2, attachments: 0 } }),
      [`memos/${bigUid}.json`]: encode(JSON.stringify(memoRecord(bigUid, `memos/${bigUid}.md`))),
      [`memos/${bigUid}.md`]: encode(bigContent),
      [`memos/${smallUid}.json`]: encode(JSON.stringify(memoRecord(smallUid, `memos/${smallUid}.md`))),
      [`memos/${smallUid}.md`]: encode('small memo'),
    })

    const { plan, report } = await importArchive(source, ALICE, archive)

    expect(plan).toMatchObject({ memoCount: 2, newCount: 2, attachmentCount: 0 })
    expect(report).toMatchObject({ created: 1, updated: 0, skipped: 0, failed: 1 })
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toMatchObject({ code: 'content_too_large', path: `memos/${bigUid}.json` })
    expect(queryOne<{ content: string }>(source, 'SELECT content FROM memos_items WHERE id = ?', smallUid)?.content).toBe('small memo')
    expect(queryOne(source, 'SELECT id FROM memos_items WHERE id = ?', bigUid)).toBeUndefined()
  })

  it('fails a record with a bad attachment digest and keeps the others', async () => {
    const target = await createInstance()
    insertUser(target, CHARLIE, 'charlie', 'Charlie')
    const archive = editArchive(await exportArchive(source), (entries) => {
      const record = readRecord(entries, MEMO_MAIN)
      const attachments = record.attachments as Array<Record<string, unknown>>
      attachments[0]!.sha256 = '0'.repeat(64)
      writeRecord(entries, MEMO_MAIN, record)
    })

    const { report } = await importArchive(target, CHARLIE, archive)

    expect(report).toMatchObject({ created: 2, failed: 1 })
    expect(report.failures[0]).toMatchObject({ code: 'attachment_digest_mismatch' })
    expect(report.warnings.some((warning) => warning.code === 'parent_missing')).toBe(true)
    expect(queryOne(target, 'SELECT id FROM memos_items WHERE user_id = ? AND id = ?', CHARLIE, MEMO_MAIN)).toBeUndefined()
    expect(count(target, 'SELECT COUNT(*) AS n FROM memos_attachments WHERE user_id = ?', CHARLIE)).toBe(1)
    expect(count(target, 'SELECT COUNT(*) AS n FROM memos_attachments WHERE user_id = ? AND id = ?', CHARLIE, ATT_PHOTO)).toBe(0)
  })

  it('warns about external attachments and manifest count mismatches', async () => {
    const target = await createInstance()
    insertUser(target, CHARLIE, 'charlie', 'Charlie')
    const archive = editArchive(await exportArchive(source), (entries) => {
      const manifest = JSON.parse(decode(entries['manifest.json']!)) as Record<string, unknown>
      manifest.counts = { memos: 99, attachments: 99 }
      entries['manifest.json'] = encode(JSON.stringify(manifest))
      const record = readRecord(entries, MEMO_MAIN)
      const attachments = record.attachments as Array<Record<string, unknown>>
      attachments[0] = {
        uid: ATT_PHOTO,
        filename: PHOTO_FILENAME,
        type: 'image/png',
        size: 0,
        externalLink: 'https://example.com/photo.png',
        createTime: '2026-02-25T06:14:10Z',
      }
      writeRecord(entries, MEMO_MAIN, record)
      delete entries[`attachments/${ATT_PHOTO}/${PHOTO_FILENAME}`]
    })

    const { plan, report } = await importArchive(target, CHARLIE, archive)

    expect(plan.warnings.filter((warning) => warning.code === 'manifest_count_mismatch')).toHaveLength(2)
    expect(report.created).toBe(3)
    expect(report.warnings.some((warning) => warning.code === 'manifest_count_mismatch')).toBe(true)
    expect(report.warnings.some((warning) => warning.code === 'external_attachment')).toBe(true)
    expect(count(target, 'SELECT COUNT(*) AS n FROM memos_attachments WHERE user_id = ?', CHARLIE)).toBe(1)
  })
})
