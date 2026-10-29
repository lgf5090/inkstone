/**
 * The Inknote slice of the account backup.
 *
 * Everything the app owns is written as one JSON document: tables, pages, settings, templates,
 * recordings with their timelines, and the bytes of every asset as base64. One file keeps the restore
 * inside the existing music/calendar path; the budget below is what keeps it inside the 64 MB upload
 * limit. Assets that would push the document past the budget are listed as missing instead of being
 * silently dropped, and the restore reports them.
 */
import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import { sanitizePageForSave, serializePageContent, extractPageText } from '@shared/inknote/parse'
import { sanitizeInknoteSettings, sanitizePaper } from '@shared/inknote/settings'
import type { InknoteAssetKind } from '@shared/inknote/types'
import {
  putAttachmentObject,
  selectAttachmentStorage,
} from '../attachments/backend'
import type { AttachmentObjectStorage } from '../attachments/keys'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { inknoteAssetObjectKey, isInknoteAssetKind } from './assets'

export const INKNOTE_BACKUP_FORMAT = 'inknote-backup'
export const INKNOTE_BACKUP_VERSION = 1
export const INKNOTE_BACKUP_ASSET_BUDGET = 40 * 1024 * 1024

const MAX_SUBJECTS = 500
const MAX_NOTEBOOKS = 5_000
const MAX_NOTES = 20_000
const MAX_PAGES = 50_000
const MAX_TEMPLATES = 500
const MAX_RECORDINGS = 10_000
const MAX_ASSETS = 20_000
const BATCH = 100

type Row = Record<string, unknown>

interface BackupAsset {
  id: string
  noteId: string | null
  pageId: string | null
  kind: InknoteAssetKind
  filename: string
  mime: string
  size: number
  sha256: string
  width: number | null
  height: number | null
  createdAt: number
  data?: string
}

export interface InknoteBackupDocument {
  format: typeof INKNOTE_BACKUP_FORMAT
  version: typeof INKNOTE_BACKUP_VERSION
  exportedAt: string
  subjects: Row[]
  notebooks: Row[]
  notes: Row[]
  pages: Row[]
  templates: Row[]
  recordings: Row[]
  assets: BackupAsset[]
  missingAssets: string[]
  settings: unknown
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

function record(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') throw ApiError.badRequest('The Inknote backup has an invalid string')
  return value.slice(0, max)
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ApiError.badRequest('The Inknote backup has an invalid number')
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
  return value === null || value === undefined ? null : integer(value, min, max)
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !isValidId(value)) throw ApiError.badRequest(`The Inknote backup has an invalid id: ${String(value).slice(0, 40)}`)
  return value
}

function optionalId(value: unknown): string | null {
  return value === null || value === undefined ? null : id(value)
}

function rows(value: unknown, max: number, label: string): Row[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`The Inknote backup has no ${label}`)
  if (value.length > max) throw ApiError.badRequest(`The Inknote backup has too many ${label}`)
  return value.map((entry) => {
    const row = record(entry)
    if (!row) throw ApiError.badRequest(`The Inknote backup has an invalid ${label} row`)
    return row
  })
}

export async function readBackupInknote(env: Env, userId: string): Promise<string | null> {
  const [subjects, notebooks, notes, pages, templates, recordings, assets, settings] = await Promise.all([
    env.DB.prepare(`SELECT id, name, position FROM inknote_subjects WHERE user_id = ?1 ORDER BY position, id`).bind(userId).all<Row>(),
    env.DB.prepare(`SELECT id, subject_id, name, cover_color, emoji, position FROM inknote_notebooks WHERE user_id = ?1 ORDER BY position, id`).bind(userId).all<Row>(),
    env.DB.prepare(`SELECT id, notebook_id, title, paper_style, paper_color, paper_spacing, page_width, page_height, content_width, content_height, color_tag, pinned, page_count, content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at FROM inknote_notes WHERE user_id = ?1 ORDER BY created_at, id`).bind(userId).all<Row>(),
    env.DB.prepare(`SELECT id, note_id, position, content, rev, updated_at FROM inknote_pages WHERE user_id = ?1 ORDER BY note_id, position, id`).bind(userId).all<Row>(),
    env.DB.prepare(`SELECT id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts, title, sub, title_size, sub_size, created_at, updated_at FROM inknote_templates WHERE user_id = ?1 ORDER BY created_at, id`).bind(userId).all<Row>(),
    env.DB.prepare(`SELECT id, note_id, title, duration_ms, audio_asset_id, timeline_key, peaks, created_at FROM inknote_recordings WHERE user_id = ?1 ORDER BY created_at, id`).bind(userId).all<Row>(),
    env.DB.prepare(`SELECT id, note_id, page_id, kind, filename, mime, size, sha256, object_key, width, height, storage, created_at FROM inknote_assets WHERE user_id = ?1 ORDER BY created_at, id`).bind(userId).all<Row>(),
    env.DB.prepare(`SELECT config FROM inknote_settings WHERE user_id = ?1`).bind(userId).first<{ config: string }>(),
  ])
  if (subjects.results.length === 0 && notes.results.length === 0 && templates.results.length === 0 && assets.results.length === 0 && recordings.results.length === 0) return null

  let budget = INKNOTE_BACKUP_ASSET_BUDGET
  const missingAssets: string[] = []
  const backedAssets: BackupAsset[] = []
  for (const row of assets.results) {
    const size = Number(row.size)
    const storage = row.storage === 'kv' ? 'kv' : 'r2'
    const base = {
      id: String(row.id),
      noteId: row.note_id === null ? null : String(row.note_id),
      pageId: row.page_id === null ? null : String(row.page_id),
      kind: String(row.kind) as InknoteAssetKind,
      filename: String(row.filename),
      mime: String(row.mime),
      size,
      sha256: String(row.sha256),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      createdAt: Number(row.created_at),
    }
    if (size > budget) { missingAssets.push(base.id); continue }
    const object = await readStorage(env, storage, String(row.object_key))
    if (!object) { missingAssets.push(base.id); continue }
    budget -= object.length
    backedAssets.push({ ...base, size: object.length, data: bytesToBase64(object) })
  }

  const backedRecordings: Row[] = []
  for (const row of recordings.results) {
    let events: unknown[] = []
    if (env.FILES) {
      const object = await env.FILES.get(String(row.timeline_key))
      if (object) {
        try {
          const value = await object.json() as unknown
          if (Array.isArray(value)) events = value
        } catch { events = [] }
      }
    }
    backedRecordings.push({
      id: String(row.id),
      noteId: String(row.note_id),
      title: String(row.title),
      durationMs: Number(row.duration_ms),
      audioAssetId: String(row.audio_asset_id),
      peaks: safeJson(String(row.peaks), []),
      createdAt: Number(row.created_at),
      events,
    })
  }

  const document: InknoteBackupDocument = {
    format: INKNOTE_BACKUP_FORMAT,
    version: INKNOTE_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    subjects: subjects.results,
    notebooks: notebooks.results,
    notes: notes.results,
    pages: pages.results,
    templates: templates.results,
    recordings: backedRecordings,
    assets: backedAssets,
    missingAssets,
    settings: settings ? safeJson(settings.config, {}) : null,
  }
  return JSON.stringify(document)
}

async function readStorage(env: Env, storage: AttachmentObjectStorage, key: string): Promise<Uint8Array | null> {
  if (storage === 'r2') {
    if (!env.FILES) return null
    const object = await env.FILES.get(key)
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }
  if (!env.FILES_KV) return null
  const value = await env.FILES_KV.get(key, 'arrayBuffer')
  return value ? new Uint8Array(value) : null
}

function safeJson(value: string, fallback: unknown): unknown {
  try { return JSON.parse(value) as unknown } catch { return fallback }
}

export interface InknoteRestoreSummary {
  subjects: number
  notebooks: number
  notes: number
  pages: number
  templates: number
  recordings: number
  assets: number
  missingAssets: string[]
}

export async function applyBackupInknote(env: Env, userId: string, source: string): Promise<InknoteRestoreSummary> {
  let value: unknown
  try { value = JSON.parse(source) as unknown } catch { throw ApiError.badRequest('The Inknote backup is not valid JSON') }
  const row = record(value)
  if (!row || row.format !== INKNOTE_BACKUP_FORMAT || row.version !== INKNOTE_BACKUP_VERSION) {
    throw ApiError.badRequest('The Inknote backup has an unsupported format')
  }
  const subjects = rows(row.subjects, MAX_SUBJECTS, 'subjects')
  const notebooks = rows(row.notebooks, MAX_NOTEBOOKS, 'notebooks')
  const notes = rows(row.notes, MAX_NOTES, 'notes')
  const pages = rows(row.pages, MAX_PAGES, 'pages')
  const templates = rows(row.templates, MAX_TEMPLATES, 'templates')
  const recordings = rows(row.recordings, MAX_RECORDINGS, 'recordings')
  const assets = rows(row.assets, MAX_ASSETS, 'assets') as unknown as BackupAsset[]
  const missingAssets = Array.isArray(row.missingAssets)
    ? row.missingAssets.filter((entry): entry is string => typeof entry === 'string' && isValidId(entry))
    : []

  const storage = selectAttachmentStorage(env)
  const objects: { key: string; bytes: Uint8Array; filename: string; mime: string; sha256: string; id: string }[] = []
  const assetStatements: D1PreparedStatement[] = []
  let restoredAssets = 0
  for (const raw of assets) {
    const assetId = id(raw.id)
    if (typeof raw.kind !== 'string' || !isInknoteAssetKind(raw.kind)) throw ApiError.badRequest('The Inknote backup has an invalid asset kind')
    const kind = raw.kind
    const filename = text(raw.filename, 255)
    const mime = text(raw.mime, 255)
    const data = typeof raw.data === 'string' ? raw.data : null
    if (!data) continue
    if (!storage) throw ApiError.badRequest('This instance has no attachment storage and cannot restore Inknote assets')
    const bytes = base64ToBytes(data)
    if (bytes.byteLength > 25 * 1024 * 1024) throw ApiError.badRequest('The Inknote backup has an asset over 25 MB')
    const key = inknoteAssetObjectKey(kind, userId, assetId, mime, filename)
    const sha256 = await sha256Hex(bytes)
    objects.push({ key, bytes, filename, mime, sha256, id: assetId })
    assetStatements.push(env.DB.prepare(
      `INSERT OR REPLACE INTO inknote_assets (user_id, id, note_id, page_id, kind, filename, mime, size, sha256, object_key, width, height, storage, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).bind(
      userId, assetId, optionalId(raw.noteId), optionalId(raw.pageId), kind, filename, mime,
      bytes.byteLength, sha256, key, optionalInteger(raw.width, 0, 100_000), optionalInteger(raw.height, 0, 100_000), storage, integer(raw.createdAt, 0, Number.MAX_SAFE_INTEGER),
    ))
    restoredAssets += 1
  }
  for (const object of objects) {
    await putAttachmentObject(env, storage!, object.key, object.bytes, {
      userId,
      objectId: object.id,
      kind: 'attachment',
      filename: object.filename,
      mime: object.mime,
      sha256: object.sha256,
    })
  }

  const statements: D1PreparedStatement[] = []
  for (const entry of subjects) {
    statements.push(env.DB.prepare('INSERT OR REPLACE INTO inknote_subjects (user_id, id, name, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(userId, id(entry.id), text(entry.name, 200), integer(entry.position, 0, 100_000), Date.now(), Date.now()))
  }
  for (const entry of notebooks) {
    statements.push(env.DB.prepare('INSERT OR REPLACE INTO inknote_notebooks (user_id, id, subject_id, name, cover_color, emoji, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(userId, id(entry.id), id(entry.subject_id), text(entry.name, 200), text(entry.cover_color, 32), text(entry.emoji, 16), integer(entry.position, 0, 100_000), Date.now(), Date.now()))
  }
  for (const entry of notes) {
    const paper = sanitizePaper({ style: entry.paper_style, color: entry.paper_color, spacing: entry.paper_spacing })
    statements.push(env.DB.prepare(`INSERT OR REPLACE INTO inknote_notes (user_id, id, notebook_id, title, title_key, paper_style, paper_color, paper_spacing, page_width, page_height, content_width, content_height, color_tag, pinned, page_count, content_bytes, cover_asset_id, rev, created_at, updated_at, deleted_at)
       VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`)
      .bind(
        userId, id(entry.id), id(entry.notebook_id), text(entry.title, 512), paper.style, paper.color, paper.spacing,
        integer(entry.page_width, 200, 4000), integer(entry.page_height, 200, 4000), integer(entry.content_width, 1, 8000), integer(entry.content_height, 1, 8000),
        entry.color_tag === null ? null : text(entry.color_tag, 32), entry.pinned ? 1 : 0, integer(entry.page_count, 0, 500), integer(entry.content_bytes, 0, Number.MAX_SAFE_INTEGER),
        optionalId(entry.cover_asset_id), integer(entry.rev, 0, Number.MAX_SAFE_INTEGER), integer(entry.created_at, 0, Number.MAX_SAFE_INTEGER),
        integer(entry.updated_at, 0, Number.MAX_SAFE_INTEGER), optionalInteger(entry.deleted_at, 0, Number.MAX_SAFE_INTEGER),
      ))
  }
  const pageStatements: D1PreparedStatement[] = []
  for (const entry of pages) {
    const rawContent = typeof entry.content === 'string' ? entry.content : ''
    const safe = sanitizePageForSave(rawContent)
    if (!safe.ok) throw ApiError.badRequest('The Inknote backup has an invalid page')
    const content = serializePageContent(safe.result.content)
    pageStatements.push(env.DB.prepare('INSERT OR REPLACE INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(userId, id(entry.id), id(entry.note_id), integer(entry.position, 0, 100_000), content, extractPageText(safe.result.content), integer(entry.rev, 0, Number.MAX_SAFE_INTEGER), Date.now(), integer(entry.updated_at, 0, Number.MAX_SAFE_INTEGER)))
  }
  for (const entry of templates) {
    const paper = sanitizePaper({ style: entry.paper_style, color: entry.paper_color, spacing: entry.paper_spacing })
    const texts = Array.isArray(entry.texts) ? entry.texts : []
    statements.push(env.DB.prepare(`INSERT OR REPLACE INTO inknote_templates (user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id, texts, title, sub, title_size, sub_size, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
      .bind(userId, id(entry.id), text(entry.name, 60), paper.style, paper.color, paper.spacing, optionalId(entry.bg_asset_id), JSON.stringify(texts), text(entry.title, 60), text(entry.sub, 60), integer(entry.title_size, 8, 96), integer(entry.sub_size, 8, 96), integer(entry.created_at, 0, Number.MAX_SAFE_INTEGER), integer(entry.updated_at, 0, Number.MAX_SAFE_INTEGER)))
  }
  statements.push(...assetStatements)
  for (let offset = 0; offset < statements.length; offset += BATCH) {
    await env.DB.batch(statements.slice(offset, offset + BATCH))
  }
  // A page can be nearly 1.8 MB; one statement at a time keeps a restore inside D1's batch payload.
  for (const statement of pageStatements) await statement.run()

  let restoredRecordings = 0
  if (env.FILES) {
    for (const entry of recordings) {
      const recordingId = id(entry.id)
      const key = `inknote/txt/${userId}/recordings/${recordingId}.json`
      const events = Array.isArray(entry.events) ? entry.events : []
      await env.FILES.put(key, JSON.stringify(events), { httpMetadata: { contentType: 'application/json' }, customMetadata: { userId, objectId: recordingId, kind: 'recording-timeline' } })
      await env.DB.prepare('INSERT OR REPLACE INTO inknote_recordings (user_id, id, note_id, title, duration_ms, audio_asset_id, timeline_key, peaks, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
        .bind(userId, recordingId, id(entry.noteId), text(entry.title, 200), integer(entry.durationMs, 0, INKNOTE_LIMITS.recordingMaxMs), id(entry.audioAssetId), key, JSON.stringify(Array.isArray(entry.peaks) ? entry.peaks : []), integer(entry.createdAt, 0, Number.MAX_SAFE_INTEGER))
        .run()
      restoredRecordings += 1
    }
  }

  if (row.settings) {
    const config = sanitizeInknoteSettings(row.settings)
    await env.DB.prepare('INSERT OR REPLACE INTO inknote_settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)')
      .bind(userId, JSON.stringify(config), Date.now()).run()
  }

  return {
    subjects: subjects.length,
    notebooks: notebooks.length,
    notes: notes.length,
    pages: pages.length,
    templates: templates.length,
    recordings: restoredRecordings,
    assets: restoredAssets,
    missingAssets,
  }
}

