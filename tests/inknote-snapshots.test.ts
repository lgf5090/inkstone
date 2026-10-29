// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { InknoteSnapshotMeta } from '../src/shared/inknote/types'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { inknoteSnapshotObjectKey } from '../src/worker/inknote/snapshots'
import { inknoteSnapshotsRoutes } from '../src/worker/routes/inknote-snapshots'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const ALICE = '0123456789abcdefghjkmnpqrs'
const BOB = '0123456789abcdefghjkmnpqrt'

const mocks = { userId: ALICE }

function id(value: number): string {
  return String(value).padStart(26, '0')
}

const SUBJECT = id(1)
const NOTEBOOK = id(2)
const NOTE = id(3)
const TEMPLATE = id(4)
const ASSET = id(5)
const COVER = id(6)

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket
let app: Hono<AppBindings>

function insertSubject(userId: string, subjectId: string, name = 'Subject'): void {
  sqlite.prepare(
    `INSERT INTO inknote_subjects (user_id, id, name, position, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, 1)`,
  ).run(userId, subjectId, name)
}

function insertNotebook(userId: string, notebookId: string, subjectId: string, name = 'Notebook'): void {
  sqlite.prepare(
    `INSERT INTO inknote_notebooks (
       user_id, id, subject_id, name, cover_color, emoji, position, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '', '', 0, 1, 1)`,
  ).run(userId, notebookId, subjectId, name)
}

function insertNote(
  userId: string,
  noteId: string,
  notebookId: string,
  title = 'Note',
  options: { rev?: number; pageCount?: number; coverAssetId?: string | null; deletedAt?: number | null } = {},
): void {
  sqlite.prepare(
    `INSERT INTO inknote_notes (
       user_id, id, notebook_id, title, title_key, paper_style, paper_color, paper_spacing,
       page_width, page_height, content_width, content_height, color_tag, pinned, page_count,
       content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, 'line', 'white', 'normal', 816, 1056, 816, 1056,
       NULL, 0, ?, 0, ?, ?, 1, 1, ?)`,
  ).run(
    userId,
    noteId,
    notebookId,
    title,
    title.toLowerCase(),
    options.pageCount ?? 1,
    options.coverAssetId ?? null,
    options.rev ?? 1,
    options.deletedAt ?? null,
  )
}

function insertPage(
  userId: string,
  pageId: string,
  noteId: string,
  position: number,
  content: string,
  rev = 1,
): void {
  sqlite.prepare(
    `INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, 1, 1)`,
  ).run(userId, pageId, noteId, position, content, rev)
}

function insertTemplateRow(userId: string, templateId: string, bgAssetId: string | null): void {
  sqlite.prepare(
    `INSERT INTO inknote_templates (
       user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts,
       title, sub, title_size, sub_size, created_at, updated_at
     ) VALUES (?, ?, 'Template', 'line', 'white', 'normal', ?, '[]', '', '', 32, 15, 1, 1)`,
  ).run(userId, templateId, bgAssetId)
}

function insertSettings(userId: string, config: string): void {
  sqlite.prepare(
    `INSERT INTO inknote_settings (user_id, config, updated_at) VALUES (?, ?, 1)`,
  ).run(userId, config)
}

function insertAsset(userId: string, assetId: string): void {
  sqlite.prepare(
    `INSERT INTO inknote_assets (
       user_id, id, note_id, page_id, kind, filename, mime, size, sha256,
       object_key, width, height, storage, created_at
     ) VALUES (?, ?, NULL, NULL, 'image', 'a.png', 'image/png', 10, 'hash', ?, 1, 1, 'r2', 1)`,
  ).run(userId, assetId, `inknote/images/${userId}/${assetId}.png`)
}

function insertSnapshotRow(
  userId: string,
  snapshotId: string,
  label: string,
  objectKey: string,
  createdAt: number,
): void {
  sqlite.prepare(
    `INSERT INTO inknote_snapshots (user_id, id, label, note_count, size, object_key, created_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`,
  ).run(userId, snapshotId, label, objectKey, createdAt)
}

function count(sql: string, ...values: string[]): number {
  return Number((sqlite.prepare(sql).get(...values) as { n: number }).n)
}

async function send(method: string, path: string, body?: unknown, userId = ALICE): Promise<Response> {
  mocks.userId = userId
  return await app.request(
    `/api/inknote${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function pageContent(assetId: string | null = null): string {
  return JSON.stringify({
    format: 'inknote-page',
    version: 1,
    strokes: [],
    texts: [],
    images: assetId ? [{ id: 'img-1', url: `/api/inknote/assets/${assetId}` }] : [],
    bg: null,
  })
}

function library(): void {
  insertSubject(ALICE, SUBJECT)
  insertNotebook(ALICE, NOTEBOOK, SUBJECT)
  insertNote(ALICE, NOTE, NOTEBOOK, 'Original', { rev: 7, coverAssetId: COVER })
  insertPage(ALICE, id(10), NOTE, 0, pageContent(ASSET), 7)
  insertTemplateRow(ALICE, TEMPLATE, ASSET)
  insertSettings(ALICE, JSON.stringify({ tool: 'eraser' }))
  insertAsset(ALICE, ASSET)
  insertAsset(ALICE, COVER)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  mocks.userId = ALICE
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/inknote/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  app.route('/api/inknote', inknoteSnapshotsRoutes)
})

describe('inknote snapshots', () => {
  it('builds the JSON from D1 and lists its metadata', async () => {
    library()
    const created = await send('POST', '/snapshots', { label: 'before-edit' })
    expect(created.status).toBe(201)
    const meta = await json<InknoteSnapshotMeta>(created)
    expect(meta).toMatchObject({ label: 'before-edit', noteCount: 1 })
    expect(meta.size).toBeGreaterThan(0)

    const key = inknoteSnapshotObjectKey(ALICE, meta.id)
    const bytes = bucket.objects.get(key)
    expect(bytes).toBeDefined()
    const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    expect(snapshot.format).toBe('inknote-snapshot')
    expect(snapshot.version).toBe(1)
    expect(snapshot.label).toBe('before-edit')
    expect((snapshot.subjects as Array<{ id: string }>)[0]!.id).toBe(SUBJECT)
    expect((snapshot.notes as Array<{ title: string }>)[0]!.title).toBe('Original')
    expect((snapshot.pages as Array<{ rev: number }>)[0]!.rev).toBe(7)
    expect((snapshot.settings as { tool: string }).tool).toBe('eraser')
    expect((snapshot.assetIds as string[]).sort()).toEqual([ASSET, COVER].sort())

    const list = await json<{ snapshots: InknoteSnapshotMeta[] }>(await send('GET', '/snapshots'))
    expect(list.snapshots).toEqual([meta])
  })

  it('keeps the ten newest snapshots', async () => {
    library()
    const keys: string[] = []
    const ids: string[] = []
    for (let index = 0; index < 11; index++) {
      const response = await send('POST', '/snapshots', { label: `manual-${index}` })
      expect(response.status).toBe(201)
      const meta = await json<InknoteSnapshotMeta>(response)
      ids.push(meta.id)
      keys.push(inknoteSnapshotObjectKey(ALICE, meta.id))
      await new Promise((resolve) => setTimeout(resolve, 3))
    }
    const list = await json<{ snapshots: InknoteSnapshotMeta[] }>(await send('GET', '/snapshots'))
    expect(list.snapshots).toHaveLength(10)
    expect(count('SELECT COUNT(*) AS n FROM inknote_snapshots WHERE user_id = ?', ALICE)).toBe(10)
    expect(bucket.objects.size).toBe(10)
    expect(list.snapshots.some((entry) => entry.id === ids[0])).toBe(false)
    expect(bucket.objects.has(keys[0]!)).toBe(false)
  })

  it('restores every table in batches and keeps asset rows', async () => {
    library()
    for (let index = 1; index < 120; index++) {
      insertPage(ALICE, id(100 + index), NOTE, index, pageContent())
    }
    sqlite.prepare(`UPDATE inknote_notes SET page_count = 120 WHERE user_id = ? AND id = ?`).run(ALICE, NOTE)
    const snapshot = await json<InknoteSnapshotMeta>(await send('POST', '/snapshots', { label: 'full' }))

    sqlite.prepare(`UPDATE inknote_notes SET title = 'Changed' WHERE user_id = ? AND id = ?`).run(ALICE, NOTE)
    sqlite.prepare(`DELETE FROM inknote_pages WHERE user_id = ? AND note_id = ? AND position >= 100`).run(ALICE, NOTE)
    insertSubject(ALICE, id(7), 'Extra subject')
    insertNote(ALICE, id(8), NOTEBOOK, 'Extra note')
    sqlite.prepare(`UPDATE inknote_settings SET config = '{"tool":"pen"}' WHERE user_id = ?`).run(ALICE)

    const restored = await send('POST', `/snapshots/${snapshot.id}/restore`)
    expect(restored.status).toBe(200)
    expect(await json<{ restored: boolean; missingAssets: string[] }>(restored)).toEqual({
      restored: true,
      missingAssets: [],
    })

    expect(count('SELECT COUNT(*) AS n FROM inknote_notes WHERE user_id = ?', ALICE)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM inknote_pages WHERE user_id = ?', ALICE)).toBe(120)
    expect(count('SELECT COUNT(*) AS n FROM inknote_subjects WHERE user_id = ?', ALICE)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM inknote_templates WHERE user_id = ?', ALICE)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM inknote_assets WHERE user_id = ?', ALICE)).toBe(2)
    const note = sqlite.prepare(
      'SELECT title, rev, page_count FROM inknote_notes WHERE user_id = ? AND id = ?',
    ).get(ALICE, NOTE) as { title: string; rev: number; page_count: number }
    expect(note).toEqual({ title: 'Original', rev: 7, page_count: 120 })
    const page = sqlite.prepare(
      'SELECT rev FROM inknote_pages WHERE user_id = ? AND id = ?',
    ).get(ALICE, id(10)) as { rev: number }
    expect(page.rev).toBe(7)
    const settings = sqlite.prepare(
      'SELECT config FROM inknote_settings WHERE user_id = ?',
    ).get(ALICE) as { config: string }
    expect(JSON.parse(settings.config).tool).toBe('eraser')

    const list = await json<{ snapshots: InknoteSnapshotMeta[] }>(await send('GET', '/snapshots'))
    expect(list.snapshots.some((entry) => entry.label === 'pre-restore')).toBe(true)
  })

  it('reports assets the snapshot names but the account no longer has', async () => {
    library()
    const snapshot = await json<InknoteSnapshotMeta>(await send('POST', '/snapshots', { label: 'assets' }))
    sqlite.prepare('DELETE FROM inknote_assets WHERE user_id = ?').run(ALICE)

    const response = await send('POST', `/snapshots/${snapshot.id}/restore`)
    expect(response.status).toBe(200)
    const result = await json<{ restored: boolean; missingAssets: string[] }>(response)
    expect(result.restored).toBe(true)
    expect(result.missingAssets.sort()).toEqual([ASSET, COVER].sort())
  })

  it('rejects a corrupted object without touching the library', async () => {
    library()
    const snapshotId = id(50)
    const key = inknoteSnapshotObjectKey(ALICE, snapshotId)
    await bucket.put(key, new TextEncoder().encode('{not json'))
    insertSnapshotRow(ALICE, snapshotId, 'broken', key, 1)

    const response = await send('POST', `/snapshots/${snapshotId}/restore`)
    expect(response.status).toBe(400)
    expect(count('SELECT COUNT(*) AS n FROM inknote_notes WHERE user_id = ?', ALICE)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM inknote_snapshots WHERE user_id = ?', ALICE)).toBe(1)
  })

  it('does not let another account restore or delete a snapshot', async () => {
    library()
    const snapshot = await json<InknoteSnapshotMeta>(await send('POST', '/snapshots', { label: 'mine' }))
    expect((await send('POST', `/snapshots/${snapshot.id}/restore`, undefined, BOB)).status).toBe(404)
    expect((await send('DELETE', `/snapshots/${snapshot.id}`, undefined, BOB)).status).toBe(404)
  })

  it('deletes a snapshot row and its object', async () => {
    library()
    const snapshot = await json<InknoteSnapshotMeta>(await send('POST', '/snapshots', { label: 'delete-me' }))
    const key = inknoteSnapshotObjectKey(ALICE, snapshot.id)
    expect(bucket.objects.has(key)).toBe(true)
    expect((await send('DELETE', `/snapshots/${snapshot.id}`)).status).toBe(200)
    expect(count('SELECT COUNT(*) AS n FROM inknote_snapshots WHERE user_id = ?', ALICE)).toBe(0)
    expect(bucket.objects.has(key)).toBe(false)
  })

  it('limits automatic snapshots to two per minute', async () => {
    library()
    expect((await send('POST', '/snapshots', { label: 'auto' })).status).toBe(201)
    expect((await send('POST', '/snapshots', { label: 'auto' })).status).toBe(201)
    expect((await send('POST', '/snapshots', { label: 'auto' })).status).toBe(429)
  })
})
