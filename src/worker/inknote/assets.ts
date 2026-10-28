/**
 * Inknote's binary assets: object keys, upload validation, reference scans and the cleanup queue.
 *
 * Page JSON stays in D1; only bytes live in R2/KV. Every object key is generated here from an id the
 * server made, and every row query binds `user_id`, because a filename or note id supplied by a
 * client must never be able to name another account's object.
 */
import {
  INKNOTE_ASSET_ID_RE,
  INKNOTE_ASSET_URL_PREFIX,
  INKNOTE_LIMITS,
} from '@shared/inknote/constants'
import type { InknoteAsset, InknoteAssetKind } from '@shared/inknote/types'
import {
  attachmentQuotaBytesForEnv,
  deleteAttachmentObjects,
  hasAttachmentStorage,
  putAttachmentObject,
  selectAttachmentStorage,
} from '../attachments/backend'
import type { AttachmentObjectStorage } from '../attachments/keys'
import { attachmentBytesUsed, sanitizeAttachmentFilename, withAttachmentQuotaLease } from '../attachments/storage'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  extensionFor,
  readImageSize,
  safeAttachmentMime,
} from '../lib/image'

const IMAGE_MAX_PIXELS = 40_000_000
const CLEANUP_BATCH = 100

const ASSET_KINDS: readonly InknoteAssetKind[] = [
  'image',
  'background',
  'cover',
  'audio',
  'pdf',
  'attachment',
  'template',
]
const IMAGE_KINDS = new Set<InknoteAssetKind>(['image', 'background', 'cover', 'template'])

/** Reported audio types browsers actually record, mapped to the type the asset is served as. */
const AUDIO_MIME = new Map<string, string>([
  ['audio/webm', 'audio/webm'],
  ['audio/ogg', 'audio/ogg'],
  ['audio/mp4', 'audio/mp4'],
  ['audio/m4a', 'audio/mp4'],
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/mpeg', 'audio/mpeg'],
  ['audio/mp3', 'audio/mpeg'],
  ['audio/wav', 'audio/wav'],
  ['audio/wave', 'audio/wav'],
  ['audio/x-wav', 'audio/wav'],
])

export interface InknoteAssetRow {
  user_id: string
  id: string
  note_id: string | null
  page_id: string | null
  kind: InknoteAssetKind
  filename: string
  mime: string
  size: number
  sha256: string
  object_key: string
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  created_at: number
}

export interface PersistedInknoteAsset {
  id: string
  userId: string
  noteId: string | null
  pageId: string | null
  kind: InknoteAssetKind
  filename: string
  mime: string
  size: number
  sha256: string
  objectKey: string
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  createdAt: number
}

export interface PersistInknoteAssetInput {
  userId: string
  kind: InknoteAssetKind
  noteId?: string | null
  pageId?: string | null
  filename: string
  reportedMime: string
  bytes: Uint8Array
  createdAt?: number
  /** Supplied by tests and imports; ordinary uploads get a fresh server-side id. */
  id?: string
}

export interface InknoteAssetObjectRef {
  id: string
  objectKey: string
  storage: AttachmentObjectStorage
}

export interface InknoteCleanupTarget {
  objectKey: string
  storage: AttachmentObjectStorage
}

export function isInknoteAssetKind(value: unknown): value is InknoteAssetKind {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value)
}

/**
 * The object key for one asset. `cover` uses the note id as its id so the key is fixed and a new
 * cover replaces the bytes the previous upload left there.
 */
export function inknoteAssetObjectKey(
  kind: InknoteAssetKind,
  userId: string,
  id: string,
  mime: string,
  filename: string,
): string {
  if (kind === 'cover') return `inknote/images/${userId}/covers/${id}.jpg`
  const folder = kind === 'audio'
    ? 'audio'
    : kind === 'pdf'
      ? 'pdf'
      : kind === 'attachment'
        ? 'attachments'
        : kind === 'template'
          ? 'templates'
          : 'images'
  const extension = kind === 'pdf' ? 'pdf' : extensionFor(mime, filename)
  return `inknote/${folder}/${userId}/${id}.${extension}`
}

export function inknoteAssetDto(row: InknoteAssetRow): InknoteAsset {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    url: `${INKNOTE_ASSET_URL_PREFIX}${row.id}`,
    createdAt: row.created_at,
  }
}

export async function inknoteAssetById(
  db: D1Database,
  userId: string,
  id: string,
): Promise<InknoteAssetRow | null> {
  return await db.prepare(
    `SELECT user_id, id, note_id, page_id, kind, filename, mime, size, sha256,
            object_key, width, height, storage, created_at
       FROM inknote_assets WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<InknoteAssetRow>()
}

/** Every object a note claims, for a purge that wants to queue them together. */
export async function inknoteAssetKeysByNote(
  db: D1Database,
  userId: string,
  noteId: string,
): Promise<InknoteAssetObjectRef[]> {
  const { results } = await db.prepare(
    `SELECT id, object_key, storage FROM inknote_assets
      WHERE user_id = ?1 AND note_id = ?2 ORDER BY created_at, id`,
  ).bind(userId, noteId).all<{ id: string; object_key: string; storage: AttachmentObjectStorage }>()
  return (results ?? []).map((row) => ({
    id: row.id,
    objectKey: row.object_key,
    storage: row.storage,
  }))
}

export async function scheduleInknoteCleanup(
  db: D1Database,
  userId: string,
  targets: readonly InknoteCleanupTarget[],
  now = Date.now(),
): Promise<void> {
  const statements = targets
    .filter((target) => target.objectKey && (target.storage === 'r2' || target.storage === 'kv'))
    .map((target) => db.prepare(
      `INSERT OR IGNORE INTO inknote_cleanup (user_id, object_key, storage, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(userId, target.objectKey, target.storage, now))
  for (let offset = 0; offset < statements.length; offset += CLEANUP_BATCH) {
    await db.batch(statements.slice(offset, offset + CLEANUP_BATCH))
  }
}

/** Delete one row and queue its object; callers do the reference scan first. */
export async function deleteInknoteAsset(
  env: Env,
  userId: string,
  id: string,
): Promise<boolean> {
  const row = await inknoteAssetById(env.DB, userId, id)
  if (!row) return false
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM inknote_assets WHERE user_id = ?1 AND id = ?2`).bind(userId, id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO inknote_cleanup (user_id, object_key, storage, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(userId, row.object_key, row.storage, Date.now()),
  ])
  return Boolean(results[0]?.meta.changes)
}

/**
 * Whether a page, template, recording or note still names this asset.
 *
 * `instr` is used instead of `LIKE` so an id needs no escaping; a false positive only makes the
 * caller keep an asset that could have been pruned, which is the safe direction.
 */
export async function inknoteAssetIsReferenced(
  db: D1Database,
  userId: string,
  assetId: string,
): Promise<boolean> {
  const url = `${INKNOTE_ASSET_URL_PREFIX}${assetId}`
  const page = await db.prepare(
    `SELECT 1 AS hit FROM inknote_pages WHERE user_id = ?1 AND instr(content, ?2) > 0 LIMIT 1`,
  ).bind(userId, url).first<{ hit: number }>()
  if (page) return true
  const template = await db.prepare(
    `SELECT 1 AS hit FROM inknote_templates WHERE user_id = ?1 AND bg_asset_id = ?2 LIMIT 1`,
  ).bind(userId, assetId).first<{ hit: number }>()
  if (template) return true
  const recording = await db.prepare(
    `SELECT 1 AS hit FROM inknote_recordings WHERE user_id = ?1 AND audio_asset_id = ?2 LIMIT 1`,
  ).bind(userId, assetId).first<{ hit: number }>()
  if (recording) return true
  const cover = await db.prepare(
    `SELECT 1 AS hit FROM inknote_notes WHERE user_id = ?1 AND cover_asset_id = ?2 LIMIT 1`,
  ).bind(userId, assetId).first<{ hit: number }>()
  return Boolean(cover)
}

/** The set of asset ids the account still references outside `inknote_assets`. */
async function referencedAssetIds(db: D1Database, userId: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && INKNOTE_ASSET_ID_RE.test(value)) ids.add(value)
  }

  const pages = await db.prepare(
    `SELECT content FROM inknote_pages WHERE user_id = ?1`,
  ).bind(userId).all<{ content: string }>()
  const pattern = new RegExp(`${escapeRegExp(INKNOTE_ASSET_URL_PREFIX)}([0-9a-hjkmnp-tv-z]{26})`, 'g')
  for (const row of pages.results ?? []) {
    if (typeof row.content !== 'string') continue
    for (const match of row.content.matchAll(pattern)) add(match[1])
  }

  const templates = await db.prepare(
    `SELECT bg_asset_id FROM inknote_templates WHERE user_id = ?1 AND bg_asset_id IS NOT NULL`,
  ).bind(userId).all<{ bg_asset_id: string }>()
  for (const row of templates.results ?? []) add(row.bg_asset_id)

  const recordings = await db.prepare(
    `SELECT audio_asset_id FROM inknote_recordings WHERE user_id = ?1`,
  ).bind(userId).all<{ audio_asset_id: string }>()
  for (const row of recordings.results ?? []) add(row.audio_asset_id)

  const notes = await db.prepare(
    `SELECT cover_asset_id FROM inknote_notes WHERE user_id = ?1 AND cover_asset_id IS NOT NULL`,
  ).bind(userId).all<{ cover_asset_id: string }>()
  for (const row of notes.results ?? []) add(row.cover_asset_id)
  return ids
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Queue every asset no page, template, recording or cover still names.
 *
 * Ordinary saves never call this: undo, snapshots and a shared page all rely on an asset outliving
 * the reference that just disappeared from the current page JSON.
 */
export async function pruneInknoteAssets(
  env: Env,
  userId: string,
): Promise<{ removed: number; bytes: number }> {
  const referenced = await referencedAssetIds(env.DB, userId)
  const { results } = await env.DB.prepare(
    `SELECT id, size, object_key, storage FROM inknote_assets WHERE user_id = ?1 ORDER BY created_at, id`,
  ).bind(userId).all<{ id: string; size: number; object_key: string; storage: AttachmentObjectStorage }>()
  const stale = (results ?? []).filter((row) => !referenced.has(row.id))
  if (!stale.length) return { removed: 0, bytes: 0 }

  let bytes = 0
  const statements: D1PreparedStatement[] = []
  const now = Date.now()
  for (const row of stale) {
    bytes += Number(row.size) || 0
    statements.push(
      env.DB.prepare(`DELETE FROM inknote_assets WHERE user_id = ?1 AND id = ?2`).bind(userId, row.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO inknote_cleanup (user_id, object_key, storage, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(userId, row.object_key, row.storage, now),
    )
    if (statements.length >= CLEANUP_BATCH) {
      await env.DB.batch(statements.splice(0, statements.length))
    }
  }
  if (statements.length) await env.DB.batch(statements)
  return { removed: stale.length, bytes }
}

/** Delete queued objects best-effort; a failed storage keeps its row for the next drain. */
export async function drainInknoteCleanup(
  env: Env,
  userId?: string,
  limit = 200,
): Promise<{ processed: number; pending: boolean }> {
  const capped = Math.max(1, Math.min(500, Math.trunc(limit)))
  const statement = userId
    ? env.DB.prepare(
        `SELECT user_id, object_key, storage FROM inknote_cleanup
          WHERE user_id = ?1 ORDER BY created_at, object_key LIMIT ?2`,
      ).bind(userId, capped)
    : env.DB.prepare(
        `SELECT user_id, object_key, storage FROM inknote_cleanup
          ORDER BY created_at, object_key LIMIT ?1`,
      ).bind(capped)
  const { results } = await statement.all<{
    user_id: string
    object_key: string
    storage: AttachmentObjectStorage
  }>()
  const rows = results ?? []
  if (!rows.length) return { processed: 0, pending: await hasPendingCleanup(env.DB, userId) }

  const deleted: typeof rows = []
  for (const storage of ['r2', 'kv'] as const) {
    const keys = rows.filter((row) => row.storage === storage)
    if (!keys.length || !hasAttachmentStorage(env, storage)) continue
    try {
      await deleteAttachmentObjects(env, storage, keys.map((row) => row.object_key))
      deleted.push(...keys)
    } catch (error) {
      console.warn('[inkstone] Inknote asset cleanup will retry later:', error)
    }
  }

  for (let offset = 0; offset < deleted.length; offset += CLEANUP_BATCH) {
    await env.DB.batch(
      deleted.slice(offset, offset + CLEANUP_BATCH).map((row) =>
        env.DB.prepare(
          `DELETE FROM inknote_cleanup WHERE user_id = ?1 AND object_key = ?2`,
        ).bind(row.user_id, row.object_key),
      ),
    )
  }
  return { processed: deleted.length, pending: await hasPendingCleanup(env.DB, userId) }
}

async function hasPendingCleanup(db: D1Database, userId?: string): Promise<boolean> {
  const row = userId
    ? await db.prepare(`SELECT 1 AS pending FROM inknote_cleanup WHERE user_id = ?1 LIMIT 1`)
        .bind(userId).first<{ pending: number }>()
    : await db.prepare(`SELECT 1 AS pending FROM inknote_cleanup LIMIT 1`)
        .first<{ pending: number }>()
  return Boolean(row)
}

/** Check the note/page hint an upload carries; both must be this account's rows. */
export async function assertInknoteAssetTarget(
  db: D1Database,
  userId: string,
  kind: InknoteAssetKind,
  noteId: string | null,
  pageId: string | null,
): Promise<void> {
  if (kind === 'cover' && !noteId) throw ApiError.badRequest('A cover asset requires a noteId')
  if (noteId) {
    const note = await db.prepare(
      `SELECT 1 AS found FROM inknote_notes WHERE user_id = ?1 AND id = ?2`,
    ).bind(userId, noteId).first<{ found: number }>()
    if (!note) throw ApiError.badRequest('The associated note does not exist')
  }
  if (pageId) {
    const page = noteId
      ? await db.prepare(
          `SELECT 1 AS found FROM inknote_pages WHERE user_id = ?1 AND note_id = ?2 AND id = ?3`,
        ).bind(userId, noteId, pageId).first<{ found: number }>()
      : await db.prepare(
          `SELECT 1 AS found FROM inknote_pages WHERE user_id = ?1 AND id = ?2`,
        ).bind(userId, pageId).first<{ found: number }>()
    if (!page) throw ApiError.badRequest('The associated page does not exist')
  }
}

interface ValidatedBytes {
  mime: string
  width: number | null
  height: number | null
}

function normalizeMime(value: string): string {
  return (value.split(';', 1)[0] ?? '').trim().toLowerCase()
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d
}

function validateBytes(
  kind: InknoteAssetKind,
  bytes: Uint8Array,
  reportedMime: string,
): ValidatedBytes {
  const reported = normalizeMime(reportedMime)
  if (reported === 'image/svg+xml' || looksLikeSvg(bytes)) {
    throw ApiError.badRequest('SVG files are not accepted')
  }

  if (kind === 'audio') {
    const mime = AUDIO_MIME.get(reported)
    if (!mime) throw ApiError.badRequest('The audio type is not supported')
    return { mime, width: null, height: null }
  }

  if (kind === 'pdf') {
    const mime = safeAttachmentMime(bytes, reportedMime)
    if (mime !== 'application/pdf' || !isPdf(bytes)) {
      throw ApiError.badRequest('The file is not a valid PDF')
    }
    return { mime, width: null, height: null }
  }

  const mime = safeAttachmentMime(bytes, reportedMime)
  if (mime === 'image/svg+xml') throw ApiError.badRequest('SVG files are not accepted')

  if (IMAGE_KINDS.has(kind)) {
    if (!mime.startsWith('image/')) throw ApiError.badRequest('The file is not a supported image')
    const dimensions = readImageSize(bytes, mime)
    if (mime === 'image/avif') {
      // AVIF dimensions are not parsed by the shared reader; the signature is the only check left.
      return { mime, width: null, height: null }
    }
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
      throw ApiError.badRequest('The image dimensions could not be read')
    }
    if (dimensions.width * dimensions.height > IMAGE_MAX_PIXELS) {
      throw ApiError.tooLarge('The image exceeds the 40 MP limit')
    }
    return { mime, width: dimensions.width, height: dimensions.height }
  }

  return { mime, width: null, height: null }
}

interface PreviousCover {
  row: InknoteAssetRow | null
  noteId: string | null
}

async function previousCover(
  db: D1Database,
  userId: string,
  id: string,
): Promise<PreviousCover> {
  const current = await inknoteAssetById(db, userId, id)
  const note = await db.prepare(
    `SELECT id, cover_asset_id FROM inknote_notes WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<{ id: string; cover_asset_id: string | null }>()
  if (!note?.cover_asset_id || note.cover_asset_id === id) {
    return { row: current, noteId: note?.id ?? null }
  }
  return { row: await inknoteAssetById(db, userId, note.cover_asset_id), noteId: note.id }
}

/**
 * Validate, store and record one upload.
 *
 * The bytes are written before the row so a failed insert can roll the object back; for a cover the
 * row is the fixed id (the note id), which is what makes re-uploading replace the same key.
 */
export async function persistInknoteAsset(
  env: Env,
  input: PersistInknoteAssetInput,
): Promise<PersistedInknoteAsset> {
  if (!isInknoteAssetKind(input.kind)) throw ApiError.badRequest('Unknown asset kind')
  if (input.bytes.byteLength > INKNOTE_LIMITS.assetMaxBytes) {
    throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  }
  const noteId = input.noteId ?? null
  const pageId = input.pageId ?? null
  const kind = input.kind
  const id = kind === 'cover' ? noteId : (input.id ?? newId())
  if (!id) throw ApiError.badRequest('A cover asset requires a noteId')

  await assertInknoteAssetTarget(env.DB, input.userId, kind, noteId, pageId)

  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before uploading files.',
    )
  }

  const validated = validateBytes(kind, input.bytes, input.reportedMime)
  const filename = sanitizeAttachmentFilename(input.filename || 'file')
  const sha256 = await sha256Hex(input.bytes)
  const objectKey = inknoteAssetObjectKey(kind, input.userId, id, validated.mime, filename)
  const createdAt = input.createdAt ?? Date.now()
  const ceiling = attachmentQuotaBytesForEnv(env)

  return await withAttachmentQuotaLease(env, input.userId, async (usedBytes) => {
    let previous: PreviousCover = { row: null, noteId: null }
    let replacedBytes = 0
    if (kind === 'cover') {
      previous = await previousCover(env.DB, input.userId, id)
      if (previous.row) replacedBytes += previous.row.size
      const same = await inknoteAssetById(env.DB, input.userId, id)
      if (same && same.id !== previous.row?.id) replacedBytes += same.size
    }
    if (usedBytes - replacedBytes + input.bytes.byteLength > ceiling) {
      throw ApiError.tooLarge('The account attachment quota has been reached')
    }

    await putAttachmentObject(env, storage, objectKey, input.bytes, {
      userId: input.userId,
      objectId: id,
      kind: 'attachment',
      filename,
      mime: validated.mime,
      sha256,
    })

    const insert = env.DB.prepare(
      `INSERT INTO inknote_assets (
         user_id, id, note_id, page_id, kind, filename, mime, size, sha256,
         object_key, width, height, storage, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(user_id, id) DO UPDATE SET
         note_id = excluded.note_id,
         page_id = excluded.page_id,
         kind = excluded.kind,
         filename = excluded.filename,
         mime = excluded.mime,
         size = excluded.size,
         sha256 = excluded.sha256,
         object_key = excluded.object_key,
         width = excluded.width,
         height = excluded.height,
         storage = excluded.storage,
         created_at = excluded.created_at`,
    ).bind(
      input.userId,
      id,
      noteId,
      pageId,
      kind,
      filename,
      validated.mime,
      input.bytes.byteLength,
      sha256,
      objectKey,
      validated.width,
      validated.height,
      storage,
      createdAt,
    )

    const statements: D1PreparedStatement[] = [insert]
    if (kind === 'cover') {
      statements.push(env.DB.prepare(
        `UPDATE inknote_notes SET cover_asset_id = ?3 WHERE user_id = ?1 AND id = ?2`,
      ).bind(input.userId, noteId, id))
      if (previous.row && previous.row.id !== id) {
        statements.push(env.DB.prepare(
          `DELETE FROM inknote_assets WHERE user_id = ?1 AND id = ?2`,
        ).bind(input.userId, previous.row.id))
        // The cover key is shared, so only a different backend's old object is safe to queue.
        if (previous.row.storage !== storage) {
          statements.push(env.DB.prepare(
            `INSERT OR IGNORE INTO inknote_cleanup (user_id, object_key, storage, created_at)
             VALUES (?1, ?2, ?3, ?4)`,
          ).bind(input.userId, previous.row.object_key, previous.row.storage, Date.now()))
        }
      }
    }

    try {
      await env.DB.batch(statements)
    } catch (error) {
      try {
        await deleteAttachmentObjects(env, storage, [objectKey])
      } catch (cleanupError) {
        await scheduleInknoteCleanup(env.DB, input.userId, [{ objectKey, storage }])
          .catch((queueError) => { console.warn('[inkstone] Asset cleanup queue write failed after a rollback:', queueError) })
        console.warn('[inkstone] Inknote asset cleanup after a write rollback will retry later:', cleanupError)
      }
      throw error
    }

    return {
      id,
      userId: input.userId,
      noteId,
      pageId,
      kind,
      filename,
      mime: validated.mime,
      size: input.bytes.byteLength,
      sha256,
      objectKey,
      width: validated.width,
      height: validated.height,
      storage,
      createdAt,
    }
  })
}

/** The quota figure the upload route reports to the client, kept beside the enforcement. */
export async function inknoteAssetBytesUsed(db: D1Database, userId: string): Promise<number> {
  return await attachmentBytesUsed(db, userId)
}
