// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { inknoteAssetsRoutes } from '../src/worker/routes/inknote-assets'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

const mocks = { userId: USER }

function id(value: number): string {
  return String(value).padStart(26, '0')
}

const NOTE = id(1)
const PAGE = id(2)
const TEMPLATE = id(3)
const RECORDING = id(4)

interface AssetBody {
  id: string
  kind: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  createdAt: number
}

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket
let app: Hono<AppBindings>

function png(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function insertNote(userId: string, noteId: string): void {
  sqlite.prepare(
    `INSERT INTO inknote_notes (
       user_id, id, notebook_id, title, title_key, paper_style, paper_color, paper_spacing,
       page_width, page_height, content_width, content_height, color_tag, pinned, page_count,
       content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at
     ) VALUES (?, ?, 'notebook', 'Note', 'note', 'line', 'white', 'normal',
       816, 1056, 816, 1056, NULL, 0, 1, 0, NULL, 1, 1, 1, NULL)`,
  ).run(userId, noteId)
}

function insertPage(userId: string, pageId: string, noteId: string, content: string): void {
  sqlite.prepare(
    `INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, '', 1, 1, 1)`,
  ).run(userId, pageId, noteId, content)
}

function insertTemplate(userId: string, templateId: string, bgAssetId: string | null): void {
  sqlite.prepare(
    `INSERT INTO inknote_templates (
       user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts,
       title, sub, title_size, sub_size, created_at, updated_at
     ) VALUES (?, ?, 'Template', 'line', 'white', 'normal', ?, '[]', '', '', 32, 15, 1, 1)`,
  ).run(userId, templateId, bgAssetId)
}

function insertRecording(userId: string, recordingId: string, noteId: string, assetId: string): void {
  sqlite.prepare(
    `INSERT INTO inknote_recordings (
       user_id, id, note_id, title, duration_ms, audio_asset_id, timeline_key, peaks, created_at
     ) VALUES (?, ?, ?, 'Recording', 1000, ?, 'inknote/txt/timeline.json', '[]', 1)`,
  ).run(userId, recordingId, noteId, assetId)
}

function fillQuota(userId: string): void {
  sqlite.prepare(
    `INSERT INTO attachments (
       id, user_id, scope, note_id, folder_id, filename, mime, size, sha256, object_key,
       width, height, is_starred, is_pinned, tags, storage, created_at
     ) VALUES (?, ?, 'notes', NULL, NULL, 'big', 'text/plain', ?, 'hash', 'big', NULL, NULL, 0, 0, '[]', 'r2', 1)`,
  ).run(id(90), userId, LIMITS.attachmentQuotaBytes)
}

function assetRows(userId = USER): number {
  return Number((sqlite.prepare(
    'SELECT COUNT(*) AS n FROM inknote_assets WHERE user_id = ?',
  ).get(userId) as { n: number }).n)
}

async function upload(
  kind: string,
  bytes: Uint8Array,
  options: { filename?: string; type?: string; noteId?: string; pageId?: string; userId?: string } = {},
): Promise<Response> {
  mocks.userId = options.userId ?? USER
  const form = new FormData()
  form.set('file', new File([bytes as unknown as BlobPart], options.filename ?? 'asset.png', { type: options.type ?? 'image/png' }))
  form.set('kind', kind)
  if (options.noteId) form.set('noteId', options.noteId)
  if (options.pageId) form.set('pageId', options.pageId)
  return await app.request('/api/inknote/assets', { method: 'POST', body: form }, env)
}

async function body<T>(response: Response): Promise<T> {
  return await response.json() as T
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  mocks.userId = USER
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/inknote/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  app.route('/api/inknote', inknoteAssetsRoutes)
})

describe('an inknote asset', () => {
  it('is stored under a server-generated key and served with ETag, cache policy and Range', async () => {
    const bytes = png()
    const response = await upload('image', bytes)
    expect(response.status).toBe(201)
    const asset = await body<AssetBody>(response)
    expect(asset.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(asset).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      size: 24,
      width: 1,
      height: 1,
      url: `/api/inknote/assets/${asset.id}`,
    })
    const key = `inknote/images/${USER}/${asset.id}.png`
    expect(bucket.objects.get(key)).toEqual(bytes)

    const fetched = await app.request(`/api/inknote/assets/${asset.id}`, {}, env)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    expect(fetched.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(fetched.headers.get('x-content-type-options')).toBe('nosniff')
    expect(fetched.headers.get('content-disposition')).toContain("inline; filename*=UTF-8''asset.png")
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes)

    const etag = fetched.headers.get('etag')
    const revalidated = await app.request(`/api/inknote/assets/${asset.id}`, {
      headers: { 'if-none-match': etag ?? '' },
    }, env)
    expect(revalidated.status).toBe(304)

    const ranged = await app.request(`/api/inknote/assets/${asset.id}`, {
      headers: { range: 'bytes=0-7' },
    }, env)
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 0-7/24')
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(0, 8))

    const suffix = await app.request(`/api/inknote/assets/${asset.id}`, {
      headers: { range: 'bytes=-4' },
    }, env)
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 20-23/24')

    const invalid = await app.request(`/api/inknote/assets/${asset.id}`, {
      headers: { range: 'bytes=99-100' },
    }, env)
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */24')
  })

  it('rejects SVG, mismatched image bytes and uploads past the quota', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect((await upload('image', svg, { filename: 'x.svg', type: 'image/svg+xml' })).status).toBe(400)
    expect((await upload('image', new Uint8Array([1, 2, 3]), { type: 'image/png' })).status).toBe(400)
    expect(bucket.objects.size).toBe(0)
    expect(assetRows()).toBe(0)

    fillQuota(USER)
    const oversized = await upload('image', png())
    expect(oversized.status).toBe(413)
    expect(bucket.objects.size).toBe(0)
  })

  it('is private to its owner', async () => {
    const asset = await body<AssetBody>(await upload('image', png()))
    mocks.userId = OTHER
    expect((await app.request(`/api/inknote/assets/${asset.id}`, {}, env)).status).toBe(404)
    expect((await app.request(`/api/inknote/assets/${asset.id}`, { method: 'DELETE' }, env)).status).toBe(404)
  })

  it('cannot be deleted while a page or other row still references it', async () => {
    const kept = await body<AssetBody>(await upload('image', png()))
    insertNote(USER, NOTE)
    insertPage(USER, PAGE, NOTE, JSON.stringify({
      format: 'inknote-page',
      version: 1,
      strokes: [],
      texts: [],
      images: [{ id: 'img-1', url: kept.url }],
      bg: null,
    }))

    mocks.userId = USER
    const refused = await app.request(`/api/inknote/assets/${kept.id}`, { method: 'DELETE' }, env)
    expect(refused.status).toBe(409)

    const spare = await body<AssetBody>(await upload('attachment', new Uint8Array([1, 2, 3]), {
      filename: 'notes.txt',
      type: 'text/plain',
    }))
    const deleted = await app.request(`/api/inknote/assets/${spare.id}`, { method: 'DELETE' }, env)
    expect(deleted.status).toBe(200)
    expect(assetRows()).toBe(1)
    expect(bucket.objects.has(`inknote/attachments/${USER}/${spare.id}.txt`)).toBe(false)
  })

  it('replaces a cover at the fixed note key', async () => {
    insertNote(USER, NOTE)
    const first = await body<AssetBody>(await upload('cover', png(1, 1), {
      filename: 'cover.jpg',
      type: 'image/png',
      noteId: NOTE,
    }))
    expect(first.id).toBe(NOTE)
    expect(first.url).toBe(`/api/inknote/assets/${NOTE}`)
    const key = `inknote/images/${USER}/covers/${NOTE}.jpg`
    expect(bucket.objects.has(key)).toBe(true)
    expect((sqlite.prepare(
      'SELECT cover_asset_id FROM inknote_notes WHERE user_id = ? AND id = ?',
    ).get(USER, NOTE) as { cover_asset_id: string }).cover_asset_id).toBe(NOTE)

    const second = await body<AssetBody>(await upload('cover', png(2, 2), {
      filename: 'cover.jpg',
      type: 'image/png',
      noteId: NOTE,
    }))
    expect(second.width).toBe(2)
    expect(assetRows()).toBe(1)
    expect(new Uint8Array(bucket.objects.get(key)!)).toEqual(png(2, 2))
  })

  it('prunes only assets no page, template, recording or cover names', async () => {
    insertNote(USER, NOTE)
    const pageAsset = await body<AssetBody>(await upload('image', png(1, 1)))
    insertPage(USER, PAGE, NOTE, `<p>${pageAsset.url}</p>`)

    const templateAsset = await body<AssetBody>(await upload('template', png(1, 1)))
    insertTemplate(USER, TEMPLATE, templateAsset.id)

    const audioAsset = await body<AssetBody>(await upload('audio', new Uint8Array([1, 2, 3]), {
      filename: 'voice.webm',
      type: 'audio/webm',
    }))
    insertRecording(USER, RECORDING, NOTE, audioAsset.id)

    const coverAsset = await body<AssetBody>(await upload('cover', png(1, 1), {
      noteId: NOTE,
      type: 'image/png',
    }))
    const stale = await body<AssetBody>(await upload('attachment', new Uint8Array([9, 9]), {
      filename: 'stale.txt',
      type: 'text/plain',
    }))

    mocks.userId = USER
    const response = await app.request('/api/inknote/assets/prune', { method: 'POST' }, env)
    expect(response.status).toBe(200)
    expect(await body<{ removed: number; bytes: number }>(response)).toEqual({ removed: 1, bytes: 2 })

    const remaining = sqlite.prepare(
      'SELECT id FROM inknote_assets WHERE user_id = ? ORDER BY id',
    ).all(USER) as Array<{ id: string }>
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [pageAsset.id, templateAsset.id, audioAsset.id, coverAsset.id].sort(),
    )
    expect(bucket.objects.has(`inknote/attachments/${USER}/${stale.id}.txt`)).toBe(false)
  })

  it('lists the attachments of one note for its owner and filters by kind', async () => {
    insertNote(USER, NOTE)
    expect((await upload('attachment', png(), { noteId: NOTE, filename: 'notes.png' })).status).toBe(201)
    expect((await upload('image', png(), { noteId: NOTE, filename: 'image.png' })).status).toBe(201)
    const listed = await app.request(`/api/inknote/assets?noteId=${NOTE}&kind=attachment`, {}, env)
    expect(listed.status).toBe(200)
    const payload = await body<{ assets: AssetBody[] }>(listed)
    expect(payload.assets.map((asset) => asset.filename)).toEqual(['notes.png'])
    expect(payload.assets[0]!.kind).toBe('attachment')
    mocks.userId = OTHER
    const foreign = await app.request(`/api/inknote/assets?noteId=${NOTE}`, {}, env)
    expect(foreign.status).toBe(200)
    expect((await body<{ assets: AssetBody[] }>(foreign)).assets).toEqual([])
  })

  it('rejects an upload for a note or page that is not the caller', async () => {
    insertNote(OTHER, NOTE)
    mocks.userId = USER
    const missing = await upload('image', png(), { noteId: NOTE })
    expect(missing.status).toBe(400)
  })
})
