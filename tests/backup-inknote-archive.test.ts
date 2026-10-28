// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSnapshot, materializeSnapshot } from '../src/worker/backup/snapshot'
import { BACKUP_INKNOTE_NAME, parseMarkdownBackupManifest } from '../src/shared/backup-format'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { inknoteAssetObjectKey } from '../src/worker/inknote/assets'
import { sha256Hex } from '../src/worker/lib/encoding'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const NOTE = '01m61bvqvcd7dxe3337x8pxwhz'
const ASSET = '01m61bvqvcd7dxe3337x8pxwhx'

let sqlite: DatabaseSync
let bucket: TestR2Bucket
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'inknote', 'h', 'inknote', 'Inknote', '', 'member', '{}', 1, 1)`,
  ).run(USER)
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
})

async function seed(): Promise<void> {
  sqlite.prepare(`INSERT INTO inknote_subjects (user_id, id, name, position, created_at, updated_at) VALUES (?, '01m61bvqvcd7dxe3337x8pxwha', 'Physics', 0, 1, 1)`).run(USER)
  sqlite.prepare(`INSERT INTO inknote_notebooks (user_id, id, subject_id, name, cover_color, emoji, position, created_at, updated_at) VALUES (?, '01m61bvqvcd7dxe3337x8pxwhb', '01m61bvqvcd7dxe3337x8pxwha', 'Mechanics', '', '', 0, 1, 1)`).run(USER)
  sqlite.prepare(`INSERT INTO inknote_notes (user_id, id, notebook_id, title, title_key, paper_style, paper_color, paper_spacing, page_width, page_height, content_width, content_height, color_tag, pinned, page_count, content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at) VALUES (?, ?, '01m61bvqvcd7dxe3337x8pxwhb', 'Physics', 'note', 'line', 'white', 'normal', 816, 1056, 816, 1056, NULL, 0, 1, 0, NULL, 1, 1, 1, NULL)`).run(USER, NOTE)
  const bytes = new TextEncoder().encode('asset bytes')
  const key = inknoteAssetObjectKey('image', USER, ASSET, 'image/png', 'a.png')
  bucket.objects.set(key, bytes)
  sqlite.prepare(`INSERT INTO inknote_assets (user_id, id, note_id, page_id, kind, filename, mime, size, sha256, object_key, width, height, storage, created_at) VALUES (?, ?, ?, NULL, 'image', 'a.png', 'image/png', ?, ?, ?, 1, 1, 'r2', 1)`)
    .run(USER, ASSET, NOTE, bytes.byteLength, await sha256Hex(bytes), key)
}

describe('the Inknote part of a backup snapshot', () => {
  it('writes inknote.json with asset bytes and pins it in the manifest', async () => {
    await seed()
    const snapshot = await buildSnapshot(env, USER)
    const file = snapshot.payloadFiles.find((entry) => entry.path === BACKUP_INKNOTE_NAME)
    expect(file, 'inknote.json is missing from the snapshot').toBeDefined()
    expect(file!.kind).toBe('inknote')
    const materialized = (await materializeSnapshot(snapshot)).find((entry) => entry.path === BACKUP_INKNOTE_NAME)!
    const document = JSON.parse(new TextDecoder().decode(materialized.body)) as { notes: unknown[], assets: Array<{ data?: string }> }
    expect(document.notes).toHaveLength(1)
    expect(document.assets[0]!.data).toBeTruthy()
    const manifest = parseMarkdownBackupManifest(JSON.parse(new TextDecoder().decode(
      (await materializeSnapshot(snapshot)).find((entry) => entry.path === 'manifest.json')!.body,
    )))
    expect(manifest?.inknote).toEqual({ path: BACKUP_INKNOTE_NAME, bytes: file!.byteLength, sha256: await sha256Hex(materialized.body) })
    const raw = JSON.parse(new TextDecoder().decode(
      (await materializeSnapshot(snapshot)).find((entry) => entry.path === 'manifest.json')!.body,
    )) as { inknote: { path: string } }
    raw.inknote.path = 'somewhere-else.json'
    expect(parseMarkdownBackupManifest(raw), 'a manifest may not point the inknote section anywhere').toBeNull()
  })

  it('leaves the section out for an account with no hand-written pages', async () => {
    const snapshot = await buildSnapshot(env, USER)
    expect(snapshot.payloadFiles.some((entry) => entry.path === BACKUP_INKNOTE_NAME)).toBe(false)
  })
})
