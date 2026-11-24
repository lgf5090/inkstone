/**
 * Snapshot, version and asset routes for the office app.
 *
 * Snapshots are stored as immutable JSON revisions in R2 and pointed at by `office_file.rev`; the
 * conditional update on `baseRev` is what makes two editors on the same file a 409 instead of one
 * silently overwriting the other. Assets are content-addressed binaries with a sniffed MIME type;
 * the declared `Content-Type` never outranks the bytes.
 *
 * PDF snapshots may embed tens of megabytes of raw PDF, so their request body is checked for size,
 * UTF-8 validity and the envelope's first/last characters instead of a full `JSON.parse`. Every
 * other product is small enough to parse, and parsing is what validates it.
 */
import { Hono, type Context } from 'hono'
import {
  OFFICE_LIMITS,
  isOfficeAssetId,
  officeAssetKey,
  officeSnapshotKey,
  officeSnapshotLimit,
  type OfficeFileType,
} from '@shared/office/constants'
import type { OfficeAsset, OfficeSnapshot } from '@shared/office/model'
import { utf8ByteLength } from '@shared/text-utils'
import type { AppBindings, Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { officeBytesExceeded } from '@shared/office/quota'
import { isValidId } from '../lib/id'
import { readBytesWithinLimit, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  OfficeStore,
  toOfficeVersionSummary,
  type OfficeAssetRow,
  type OfficeFileRow,
} from '../office/store'
import {
  OFFICE_ASSET_CACHE_CONTROL,
  deleteOfficeObjects,
  discardOfficeObjects,
  isOfficeAssetNameAllowed,
  officeAssetDisposition,
  officeSnapshotExists,
  putOfficeAsset,
  putOfficeSnapshot,
  readOfficeAsset,
  readOfficeSnapshot,
  requireOfficeBucket,
  resolveOfficeAssetMime,
  sanitizeOfficeAssetName,
  sniffOfficeAssetMime,
} from '../office/storage'

type Ctx = Context<AppBindings>

/** Envelope keys (`baseRev`) beyond the snapshot itself; the body ceiling sits a little above 10 MB. */
const SNAPSHOT_ENVELOPE_BYTES = 64 * 1024
/** The prefix a PDF envelope is parsed from without materializing the snapshot. */
const PDF_ENVELOPE_PREFIX = 256

export const officeContentRoutes = new Hono<AppBindings>()

officeContentRoutes.use('*', requireAuth)

function store(c: Ctx): OfficeStore {
  return new OfficeStore(c.env.DB, c.get('userId'))
}

function fileIdParam(c: Ctx): string {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  return id
}

function unsupportedAsset(message: string): ApiError {
  return new ApiError(415, 'bad_request', message)
}

function isSnapshotObject(value: unknown): value is OfficeSnapshot {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the `{ baseRev, snapshot }` envelope and return the snapshot text that will be stored.
 *
 * For PDFs only the envelope head is read as a pattern: the body is known to be valid UTF-8 JSON
 * text bounded by braces, and the snapshot is the raw slice between `"snapshot":` and the envelope's
 * closing brace. Our client writes the keys in that order (`{"baseRev":N,"snapshot":{...}}`); the
 * pattern states that requirement instead of parsing 50 MB to discover it.
 */
async function readSnapshotPayload(
  c: Ctx,
  type: OfficeFileType,
): Promise<{ baseRev: number; text: string; size: number }> {
  const limit = officeSnapshotLimit(type)
  if (type !== 'pdfs') {
    const body = await readJson<{ baseRev?: unknown; snapshot?: unknown }>(
      c,
      limit + SNAPSHOT_ENVELOPE_BYTES,
    )
    if (typeof body.baseRev !== 'number' || !Number.isInteger(body.baseRev) || body.baseRev < 0) {
      throw ApiError.badRequest('baseRev must be a non-negative integer')
    }
    if (!isSnapshotObject(body.snapshot)) {
      throw ApiError.badRequest('snapshot must be a JSON object')
    }
    const text = JSON.stringify(body.snapshot)
    const size = utf8ByteLength(text)
    if (size > limit) throw ApiError.tooLarge('The snapshot is too large')
    return { baseRev: body.baseRev, text, size }
  }

  const bytes = await readBytesWithinLimit(c.req.raw.body, limit)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw ApiError.badRequest('The PDF snapshot body is not valid UTF-8')
  }
  const envelope = parsePdfSnapshotEnvelope(text)
  if (!envelope) {
    throw ApiError.badRequest('A PDF snapshot body must be {"baseRev":N,"snapshot":{...}}')
  }
  const size = utf8ByteLength(envelope.snapshotText)
  if (size > limit) throw ApiError.tooLarge('The snapshot is too large')
  return { baseRev: envelope.baseRev, text: envelope.snapshotText, size }
}

function parsePdfSnapshotEnvelope(text: string): { baseRev: number; snapshotText: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  const head = /^\s*\{\s*"baseRev"\s*:\s*(\d{1,15})\s*,\s*"snapshot"\s*:\s*/.exec(
    text.slice(0, PDF_ENVELOPE_PREFIX),
  )
  if (!head) return null
  const baseRev = Number(head[1])
  if (!Number.isSafeInteger(baseRev)) return null
  const start = head[0].length
  const end = text.lastIndexOf('}')
  if (end <= start) return null
  const snapshotText = text.slice(start, end).trim()
  if (!snapshotText.startsWith('{') || !snapshotText.endsWith('}')) return null
  return { baseRev, snapshotText }
}

/**
 * Move the file pointer to a freshly written revision.
 *
 * The R2 object is written first so the conditional update never publishes a key that does not
 * exist. A lost race (or a file deleted underneath) removes the orphan and answers 409/404.
 */
async function writeSnapshot(
  c: Ctx,
  s: OfficeStore,
  file: OfficeFileRow,
  baseRev: number,
  text: string,
  size: number,
): Promise<{ rev: number; size: number; updatedAt: number }> {
  const rev = baseRev + 1
  const key = officeSnapshotKey(c.get('userId'), file.id, rev)
  // A revision object is immutable. If this one already exists the file's pointer is at or past
  // it, so this write lost the race before it began: refuse instead of overwriting a kept version.
  if (await officeSnapshotExists(c.env, key)) {
    const current = await s.fileRow(file.id)
    if (current && current.rev >= rev) {
      throw new ApiError(
        409,
        'conflict',
        'The file was changed elsewhere. Reload and try again',
        { currentRev: current.rev },
      )
    }
  }
  const contentHash = await sha256Hex(text)
  await putOfficeSnapshot(c.env, key, text)
  const now = Date.now()
  const result = await s.saveSnapshot({
    fileId: file.id,
    baseRev,
    rev,
    snapshotKey: key,
    size,
    contentHash,
    now,
  })
  if (!result.applied) {
    const current = await s.fileRow(file.id)
    // The object this write created is only garbage when nothing points at it; a concurrent
    // winner that committed the same revision keeps its object.
    if (!current || current.deleted_at !== null) {
      await discardOfficeObjects(c.env, [key])
      throw ApiError.notFound('File not found')
    }
    if (current.snapshot_key !== key) await discardOfficeObjects(c.env, [key])
    throw new ApiError(
      409,
      'conflict',
      'The file was changed elsewhere. Reload and try again',
      { currentRev: current.rev },
    )
  }
  await trimVersions(c.env, s, file.id)
  return { rev, size, updatedAt: now }
}

/**
 * Drop revisions past the per-file cap.
 *
 * Objects are deleted before their rows: a deleted object with a surviving row is a listed version
 * that cannot open, while a surviving object with no row is unreachable garbage. When R2 refuses,
 * the rows are kept and the next save retries the trim.
 */
async function trimVersions(env: Env, s: OfficeStore, fileId: string): Promise<void> {
  const keys = await s.versionKeysBeyond(fileId, OFFICE_LIMITS.versionsPerFile)
  if (!keys.length) return
  try {
    await deleteOfficeObjects(env, keys)
  } catch (error) {
    console.warn('[inkstone] Office version trim could not delete old objects; rows kept:', error)
    return
  }
  await s.deleteVersionsBeyond(fileId, OFFICE_LIMITS.versionsPerFile)
}

function toOfficeAsset(row: OfficeAssetRow): OfficeAsset {
  return {
    id: row.id,
    url: `/api/office/assets/${row.id}`,
    mime: row.mime,
    size: row.size,
    name: row.name,
  }
}

// ------------------------------------------------------------- snapshots

officeContentRoutes.get('/usage', async (c) => {
  const s = store(c)
  const [files, bytes] = await Promise.all([s.countFiles(), s.sumBytes()])
  return c.json({
    usage: { files, bytes },
    limits: { files: OFFICE_LIMITS.filesPerUser, bytes: OFFICE_LIMITS.bytesPerUser },
  })
})

officeContentRoutes.get('/files/:id/snapshot', async (c) => {
  const s = store(c)
  const file = await s.fileRow(fileIdParam(c))
  if (!file) throw ApiError.notFound('File not found')
  if (!file.snapshot_key || file.rev === 0) {
    return c.json({ rev: 0, snapshot: null, updatedAt: file.updated_at })
  }
  const text = await readOfficeSnapshot(c.env, file.snapshot_key)
  if (text === null) throw ApiError.notFound('The file snapshot is missing from storage')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError(500, 'internal', 'The stored snapshot is not valid JSON')
  }
  if (!isSnapshotObject(parsed)) {
    throw new ApiError(500, 'internal', 'The stored snapshot is not a JSON object')
  }
  return c.json({ rev: file.rev, snapshot: parsed, updatedAt: file.updated_at })
})

/** Refuses a write that would push the account past its Office storage ceiling. */
async function assertOfficeBytesRoom(s: OfficeStore, incoming: number, replacing = 0): Promise<void> {
  const used = await s.sumBytes()
  if (!officeBytesExceeded(used, incoming, replacing)) return
  throw new ApiError(
    403,
    'office_quota_exceeded',
    `Office storage is full: ${used} of ${OFFICE_LIMITS.bytesPerUser} bytes are in use`,
  )
}

officeContentRoutes.put('/files/:id/snapshot', async (c) => {
  const s = store(c)
  const file = await s.fileRow(fileIdParam(c))
  if (!file) throw ApiError.notFound('File not found')
  if (file.deleted_at !== null) throw ApiError.notFound('File not found')
  // Check the binding before a possibly large body is read.
  requireOfficeBucket(c.env)
  const payload = await readSnapshotPayload(c, file.type)
  // The file's own bytes are replaced, not added: a save may grow it, never spend them twice.
  await assertOfficeBytesRoom(s, payload.size, file.size)
  const result = await writeSnapshot(c, s, file, payload.baseRev, payload.text, payload.size)
  return c.json(result)
})

// -------------------------------------------------------------- versions

officeContentRoutes.get('/files/:id/versions', async (c) => {
  const s = store(c)
  const file = await s.fileRow(fileIdParam(c))
  if (!file) throw ApiError.notFound('File not found')
  const versions = await s.listVersions(file.id)
  return c.json({ versions: versions.map(toOfficeVersionSummary) })
})

officeContentRoutes.post('/files/:id/versions/:rev/restore', async (c) => {
  const s = store(c)
  const file = await s.liveFileRow(fileIdParam(c))
  if (!file) throw ApiError.notFound('File not found')
  const revParam = c.req.param('rev') ?? ''
  if (!/^\d{1,15}$/.test(revParam)) throw ApiError.badRequest('rev must be a positive integer')
  const rev = Number(revParam)
  if (rev < 1) throw ApiError.badRequest('rev must be a positive integer')
  const version = await s.versionRow(file.id, rev)
  if (!version) throw ApiError.notFound('Version not found')
  const text = await readOfficeSnapshot(c.env, version.object_key)
  if (text === null) throw ApiError.notFound('The version snapshot is missing from storage')
  requireOfficeBucket(c.env)
  const size = utf8ByteLength(text)
  const result = await writeSnapshot(c, s, file, file.rev, text, size)
  return c.json({ rev: result.rev })
})

// ---------------------------------------------------------------- assets

officeContentRoutes.post('/assets', async (c) => {
  requireOfficeBucket(c.env)
  const bytes = await readBytesWithinLimit(c.req.raw.body, OFFICE_LIMITS.assetBytes)
  if (!bytes.length) throw ApiError.badRequest('The uploaded asset is empty')
  const declared = c.req.header('Content-Type') ?? null
  const sniffed = sniffOfficeAssetMime(bytes)
  if (!sniffed) throw unsupportedAsset('This asset type is not supported')
  const mime = resolveOfficeAssetMime(declared, sniffed)
  if (!mime) throw unsupportedAsset('The declared Content-Type does not match the uploaded bytes')
  const name = sanitizeOfficeAssetName(c.req.header('X-Office-Name'), mime)
  if (!isOfficeAssetNameAllowed(name)) throw unsupportedAsset('This file type is not allowed')

  const userId = c.get('userId')
  const sha256 = await sha256Hex(bytes)
  const s = store(c)
  const now = Date.now()
  const existing = await s.assetRow(sha256)
  if (existing) {
    const row = await s.insertAsset({
      id: existing.id,
      name: existing.name,
      mime: existing.mime,
      size: existing.size,
      objectKey: existing.object_key,
      now,
    })
    return c.json(toOfficeAsset(row))
  }

  await assertOfficeBytesRoom(s, bytes.length)
  const key = officeAssetKey({ userId, sha256, mime })
  if (!key) throw unsupportedAsset('This asset type is not supported')
  await putOfficeAsset(c.env, key, bytes, mime)
  const row = await s.insertAsset({
    id: sha256,
    name,
    mime,
    size: bytes.byteLength,
    objectKey: key,
    now,
  })
  return c.json(toOfficeAsset(row), 201)
})

officeContentRoutes.get('/assets/:id', async (c) => {
  const id = c.req.param('id') ?? ''
  if (!isOfficeAssetId(id)) throw ApiError.notFound('Asset not found')
  const row = await store(c).assetRow(id)
  if (!row) throw ApiError.notFound('Asset not found')
  const object = await readOfficeAsset(c.env, row.object_key)
  if (!object) throw ApiError.notFound('The asset bytes are missing from storage')
  const headers = new Headers({
    'Content-Type': row.mime,
    'Content-Length': String(object.size),
    'Cache-Control': OFFICE_ASSET_CACHE_CONTROL,
    'Content-Disposition': officeAssetDisposition(row.mime, row.name),
    'X-Content-Type-Options': 'nosniff',
  })
  if (object.httpEtag) headers.set('ETag', object.httpEtag)
  return new Response(object.body as ReadableStream, { headers })
})