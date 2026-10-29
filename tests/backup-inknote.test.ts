// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { emptyPageContent, serializePageContent } from '../src/shared/inknote/parse'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { readBackupInknote, applyBackupInknote, INKNOTE_BACKUP_FORMAT } from '../src/worker/inknote/backup'
import { inknoteAssetObjectKey } from '../src/worker/inknote/assets'
import { sha256Hex } from '../src/worker/lib/encoding'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const NOTE = '01m61bvqvcd7dxe3337x8pxwhz'
const PAGE = '01m61bvqvcd7dxe3337x8pxwhy'
const ASSET = '01m61bvqvcd7dxe3337x8pxwhx'
const RECORDING = '01m61bvqvcd7dxe3337x8pxwhw'

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket
const bytes = new TextEncoder().encode('tiny image bytes')

function seed(db: DatabaseSync, userId: string, noteId: string, pageId: string | null): void {
  db.prepare(`INSERT INTO inknote_subjects (user_id, id, name, position, created_at, updated_at) VALUES (?, '01m61bvqvcd7dxe3337x8pxwha', 'Physics', 0, 1, 1)`).run(userId)
  db.prepare(`INSERT INTO inknote_notebooks (user_id, id, subject_id, name, cover_color, emoji, position, created_at, updated_at) VALUES (?, '01m61bvqvcd7dxe3337x8pxwhb', '01m61bvqvcd7dxe3337x8pxwha', 'Mechanics', '', '', 0, 1, 1)`).run(userId)
  db.prepare(`INSERT INTO inknote_notes (user_id, id, notebook_id, title, title_key, paper_style, paper_color, paper_spacing, page_width, page_height, content_width, content_height, color_tag, pinned, page_count, content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at) VALUES (?, ?, '01m61bvqvcd7dxe3337x8pxwhb', 'Physics', 'note', 'line', 'white', 'normal', 816, 1056, 816, 1056, NULL, 0, 1, 0, NULL, 1, 1, 1, NULL)`).run(userId, noteId)
  if (pageId) {
    db.prepare(`INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 'first law', 1, 1, 1)`)
      .run(userId, pageId, noteId, serializePageContent({ ...emptyPageContent(), texts: [{ id: 't1', x: 0.1, y: 0.1, w: 0.5, h: 0.1, text: 'first law', fontSize: 26, color: '#111111', align: 'left', bold: false, italic: false, underline: false, hl: null, lh: 1.3, list: null }] }))
  }
}

async function insertAsset(db: DatabaseSync, userId: string, noteId: string): Promise<void> {
  const key = inknoteAssetObjectKey('image', userId, ASSET, 'image/png', 'a.png')
  const sha = await sha256Hex(bytes)
  db.prepare(`INSERT INTO inknote_assets (user_id, id, note_id, page_id, kind, filename, mime, size, sha256, object_key, width, height, storage, created_at)
    VALUES (?, ?, ?, NULL, 'image', 'a.png', 'image/png', ?, ?, ?, 1, 1, 'r2', 1)`).run(userId, ASSET, noteId, bytes.byteLength, sha, key)
  bucket.objects.set(key, bytes)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
})

describe('the Inknote backup document', () => {
  it('round-trips tables, pages, settings, templates, recordings and asset bytes', async () => {
    seed(sqlite, USER, NOTE, PAGE)
    seed(sqlite, OTHER, '01m61bvqvcd7dxe3337x8pxwhv', null)
    await insertAsset(sqlite, USER, NOTE)
    await insertAsset(sqlite, OTHER, '01m61bvqvcd7dxe3337x8pxwhv')
    sqlite.prepare(`INSERT INTO inknote_settings (user_id, config, updated_at) VALUES (?, ?, 1)`).run(USER, JSON.stringify({ tool: 'pen', color: '#123456', openTabs: [NOTE] }))
    sqlite.prepare(`INSERT INTO inknote_templates (user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts, title, sub, title_size, sub_size, created_at, updated_at) VALUES (?, '01m61bvqvcd7dxe3337x8pxwhc', 'My template', 'line', 'white', 'normal', NULL, '[]', '', '', 30, 15, 1, 1)`).run(USER)
    sqlite.prepare(`INSERT INTO inknote_recordings (user_id, id, note_id, title, duration_ms, audio_asset_id, timeline_key, peaks, created_at) VALUES (?, ?, ?, 'Rec', 1000, ?, ?, '[0.5]', 1)`)
      .run(USER, RECORDING, NOTE, ASSET, `inknote/txt/${USER}/recordings/${RECORDING}.json`)
    bucket.objects.set(`inknote/txt/${USER}/recordings/${RECORDING}.json`, new TextEncoder().encode(JSON.stringify([{ t: 0, type: 'page', pageId: PAGE }])))

    const text = await readBackupInknote(env, USER)
    expect(text).not.toBeNull()
    const document = JSON.parse(text!) as { format: string, notes: unknown[], assets: Array<{ data?: string }>, missingAssets: string[], recordings: Array<{ events: unknown[] }> }
    expect(document.format).toBe(INKNOTE_BACKUP_FORMAT)
    expect(document.notes).toHaveLength(1)
    expect(document.assets).toHaveLength(1)
    expect(document.missingAssets).toEqual([])
    expect(document.assets[0]!.data).toBeTruthy()
    expect(document.recordings[0]!.events).toHaveLength(1)

    const restored = new DatabaseSync(':memory:')
    restored.exec('PRAGMA journal_mode = OFF')
    for (const statement of SCHEMA_STATEMENTS) restored.exec(statement)
    const targetBucket = testR2Bucket()
    const targetEnv = testBindings(makeD1(restored), { FILES: targetBucket })
    const summary = await applyBackupInknote(targetEnv, USER, text!)
    expect(summary).toMatchObject({ subjects: 1, notebooks: 1, notes: 1, pages: 1, templates: 1, recordings: 1, assets: 1, missingAssets: [] })

    const page = restored.prepare('SELECT content FROM inknote_pages WHERE user_id = ? AND id = ?').get(USER, PAGE) as { content: string }
    expect(JSON.parse(page.content).texts[0].text).toBe('first law')
    const config = restored.prepare('SELECT config FROM inknote_settings WHERE user_id = ?').get(USER) as { config: string }
    expect(JSON.parse(config.config).tool).toBe('pen')
    expect(restored.prepare('SELECT name FROM inknote_templates WHERE user_id = ?').get(USER)).toMatchObject({ name: 'My template' })
    const timeline = targetBucket.objects.get(`inknote/txt/${USER}/recordings/${RECORDING}.json`)
    expect(timeline ? new TextDecoder().decode(timeline) : '').toContain('"page"')
    const restoredAsset = [...targetBucket.objects.entries()].find(([key]) => key.includes(`/${ASSET}.`))
    expect(restoredAsset, 'the asset object was not written').toBeTruthy()
    expect(new TextDecoder().decode(restoredAsset![1])).toBe('tiny image bytes')
  })

  it('returns null for an account with no Inknote data', async () => {
    expect(await readBackupInknote(env, USER)).toBeNull()
  })

  it('refuses a document that is not an Inknote backup', async () => {
    await expect(applyBackupInknote(env, USER, JSON.stringify({ format: 'other', version: 1 }))).rejects.toThrow()
    await expect(applyBackupInknote(env, USER, 'not json')).rejects.toThrow()
  })

  it('reports assets whose bytes are gone instead of inventing them', async () => {
    seed(sqlite, USER, NOTE, PAGE)
    await insertAsset(sqlite, USER, NOTE)
    bucket.objects.clear()
    const document = JSON.parse((await readBackupInknote(env, USER))!) as { assets: unknown[], missingAssets: string[] }
    expect(document.assets).toEqual([])
    expect(document.missingAssets).toEqual([ASSET])
  })
})
