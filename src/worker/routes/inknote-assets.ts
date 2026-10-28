/** HTTP surface for Inknote assets: upload, owner-only reads with Range, delete and prune. */
import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { InknoteAsset } from '@shared/inknote/types'
import {
  hasAttachmentStorage,
  readAttachmentObject,
  readAttachmentObjectRange,
  readAttachmentObjectStream,
} from '../attachments/backend'
import type { AppBindings } from '../env'
import {
  deleteInknoteAsset,
  drainInknoteCleanup,
  inknoteAssetById,
  inknoteAssetIsReferenced,
  isInknoteAssetKind,
  listInknoteAssets,
  persistInknoteAsset,
  pruneInknoteAssets,
} from '../inknote/assets'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'

const OWNER_CACHE = 'private, max-age=31536000, immutable'
const INLINE_PREFIXES = ['image/', 'audio/'] as const

export const inknoteAssetsRoutes = new Hono<AppBindings>()

inknoteAssetsRoutes.use('*', requireAuth)

inknoteAssetsRoutes.post('/assets', async (c) => {
  const userId = c.get('userId')
  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
    key: `inknote-asset-upload:${userId}`,
    maxAttempts: LIMITS.attachmentUploadsPerHour,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  }]), 'Too many uploads')

  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')
  if (!isInknoteAssetKind(form.get('kind'))) throw ApiError.badRequest('Unknown asset kind')

  const rawNoteId = form.get('noteId')
  const noteId = typeof rawNoteId === 'string' && rawNoteId ? rawNoteId : null
  if (noteId && !isValidId(noteId)) throw ApiError.badRequest('Invalid noteId')
  const rawPageId = form.get('pageId')
  const pageId = typeof rawPageId === 'string' && rawPageId ? rawPageId : null
  if (pageId && !isValidId(pageId)) throw ApiError.badRequest('Invalid pageId')
  if (file.size > LIMITS.attachmentMaxBytes) throw ApiError.tooLarge('The file exceeds the 25 MB limit')

  const stored = await persistInknoteAsset(c.env, {
    userId,
    kind: form.get('kind') as InknoteAsset['kind'],
    noteId,
    pageId,
    filename: file.name || 'file',
    reportedMime: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })

  return c.json<InknoteAsset>({
    id: stored.id,
    kind: stored.kind,
    filename: stored.filename,
    mime: stored.mime,
    size: stored.size,
    width: stored.width,
    height: stored.height,
    url: `/api/inknote/assets/${stored.id}`,
    createdAt: stored.createdAt,
  }, 201)
})

inknoteAssetsRoutes.post('/assets/prune', async (c) => {
  const userId = c.get('userId')
  const result = await pruneInknoteAssets(c.env, userId)
  await drainInknoteCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Inknote asset cleanup will retry later:', error)
  })
  return c.json(result)
})

inknoteAssetsRoutes.get('/assets', async (c) => {
  const noteId = c.req.query('noteId')
  if (!noteId || !isValidId(noteId)) throw ApiError.badRequest('noteId is required')
  const kind = c.req.query('kind')
  if (kind && !isInknoteAssetKind(kind)) throw ApiError.badRequest('Unknown asset kind')
  return c.json({ assets: await listInknoteAssets(c.env.DB, c.get('userId'), { noteId, kind: kind ? kind as InknoteAsset['kind'] : null }) })
})

inknoteAssetsRoutes.get('/assets/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Asset not found')
  const row = await inknoteAssetById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('Asset not found')

  const etag = `"${row.sha256}"`
  const headers = new Headers({
    'Cache-Control': OWNER_CACHE,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  })

  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers })
  }

  if (!hasAttachmentStorage(c.env, row.storage)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      `${row.storage === 'r2' ? 'R2' : 'Workers KV'} attachment storage is not bound, so the asset cannot be read`,
    )
  }

  const rangeHeader = c.req.header('range')
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, row.size)
    if (range === 'invalid') {
      headers.set('Content-Range', `bytes */${row.size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range) {
      const length = range.end - range.start + 1
      const bytes = row.storage === 'r2'
        ? await readAttachmentObjectRange(c.env, row.storage, row.object_key, range.start, length)
        : sliceStoredObject(
            await readAttachmentObject(c.env, row.storage, row.object_key),
            range.start,
            range.end,
          )
      if (!bytes) throw ApiError.notFound('Asset data is missing')
      headers.set('Content-Type', row.mime)
      headers.set('Content-Disposition', contentDisposition(row.mime, row.filename))
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${row.size}`)
      headers.set('Content-Length', String(bytes.byteLength))
      return new Response(bytes as BodyInit, { status: 206, headers })
    }
  }

  const object = await readAttachmentObjectStream(c.env, row.storage, row.object_key)
  if (!object) throw ApiError.notFound('Asset data is missing')
  headers.set('Content-Type', row.mime)
  headers.set('Content-Disposition', contentDisposition(row.mime, row.filename))
  headers.set('Content-Length', String(row.size))
  return new Response(object.body as BodyInit, { headers })
})

inknoteAssetsRoutes.delete('/assets/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Asset not found')
  const row = await inknoteAssetById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('Asset not found')
  if (await inknoteAssetIsReferenced(c.env.DB, userId, id)) {
    throw ApiError.conflict('The asset is still used by a page, template, recording or cover')
  }
  if (!(await deleteInknoteAsset(c.env, userId, id))) throw ApiError.notFound('Asset not found')
  await drainInknoteCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Inknote asset cleanup will retry later:', error)
  })
  return c.json({ ok: true })
})

function contentDisposition(mime: string, filename: string): string {
  const inline = INLINE_PREFIXES.some((prefix) => mime.startsWith(prefix)) || mime === 'application/pdf'
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`
}

function matchesETag(header: string, tag: string): boolean {
  const target = tag.replace(/^W\//i, '').replace(/^"|"$/g, '')
  return header.split(',').some((item) => {
    const trimmed = item.trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
    return trimmed === '*' || trimmed === target
  })
}

type ParsedRange = { start: number; end: number } | 'invalid' | null

function parseByteRange(header: string, size: number): ParsedRange {
  if (!header.startsWith('bytes=')) return null
  const spec = header.slice(6).trim()
  if (!spec || spec.includes(',')) return 'invalid'
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (!match) return 'invalid'
  const startRaw = match[1]!
  const endRaw = match[2]!
  if (!startRaw && !endRaw) return 'invalid'
  if (!startRaw) {
    const suffix = Number(endRaw)
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startRaw)
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid'
  const end = endRaw ? Number(endRaw) : size - 1
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function sliceStoredObject(bytes: Uint8Array | null, start: number, end: number): Uint8Array | null {
  if (!bytes) return null
  const slice = bytes.subarray(start, end + 1)
  return slice.byteLength ? slice : null
}
