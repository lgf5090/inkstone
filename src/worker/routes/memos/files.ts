import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import {
  hasAttachmentStorage,
  readAttachmentObject,
  readAttachmentObjectRange,
  readAttachmentObjectStream,
} from '../../attachments/backend'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { isProtectedReadable, isPubliclyReadable } from '../../memos/access'
import {
  memoAttachmentForFile,
  motionVideoForAttachment,
  shareVouchesForAttachment,
  type MemoAttachmentFileRow,
  type MemoAttachmentRow,
} from '../../memos/attachments'
import { isMemoInlineSafe } from '../../memos/media'
import { hashOpaqueToken } from '../../memos/tokens'

const SHARE_TOKEN_MAX_CHARS = 256
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

type FileAccess = 'owner' | 'share' | 'public' | 'protected'
type FileVariant = 'original' | 'thumb' | 'motion'
type ParsedRange = { start: number; end: number } | 'invalid' | null

export const memoFileRoutes = new Hono<AppBindings>()

memoFileRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw notFound()

  const row = await memoAttachmentForFile(c.env.DB, id)
  if (!row) throw notFound()

  const viewerId = c.get('userId') || null
  const access = await fileAccessForRow(c.env.DB, row, viewerId, c.req.query('share'))
  if (!access) throw notFound()

  const wantsMotion = c.req.query('motion') === '1'
  const wantsThumb = c.req.query('thumb') === '1'

  let objectRow: MemoAttachmentRow = row
  let objectKey = row.storage_key
  let contentType = row.mime
  let filename = row.filename
  let variant: FileVariant = 'original'

  if (wantsMotion) {
    const video = await motionVideoForAttachment(c.env.DB, row)
    if (!video) throw notFound()
    objectRow = video
    objectKey = video.storage_key
    contentType = video.mime
    filename = video.filename
    variant = 'motion'
  } else if (wantsThumb && row.thumbnail_key) {
    objectKey = row.thumbnail_key
    variant = 'thumb'
  }

  const etag = variant === 'thumb'
    ? `"${row.id}-thumb-${row.updated_at}"`
    : `"${objectRow.id}-${objectRow.updated_at}"`
  const cacheControl = cacheControlFor(access)
  const headers = new Headers({
    'Cache-Control': cacheControl,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  })
  if (variant !== 'thumb') headers.set('Accept-Ranges', 'bytes')

  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers })
  }

  if (!hasAttachmentStorage(c.env, objectRow.storage)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      `${objectRow.storage === 'r2' ? 'R2' : 'Workers KV'} attachment storage is not bound, so the attachment cannot be read`,
    )
  }

  const rangeHeader = c.req.header('range')
  if (rangeHeader && variant !== 'thumb') {
    const range = parseByteRange(rangeHeader, objectRow.size)
    if (range === 'invalid') {
      headers.set('Content-Range', `bytes */${objectRow.size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range) {
      const length = range.end - range.start + 1
      const bytes = objectRow.storage === 'r2'
        ? await readAttachmentObjectRange(c.env, objectRow.storage, objectKey, range.start, length)
        : sliceStoredObject(
            await readAttachmentObject(c.env, objectRow.storage, objectKey),
            range.start,
            range.end,
          )
      if (!bytes) throw notFound()
      headers.set('Content-Type', contentType)
      headers.set('Content-Disposition', contentDisposition(contentType, filename))
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${objectRow.size}`)
      headers.set('Content-Length', String(bytes.byteLength))
      return new Response(bytes as BodyInit, { status: 206, headers })
    }
  }

  const object = await readAttachmentObjectStream(c.env, objectRow.storage, objectKey)
  if (!object) throw notFound()
  if (variant === 'thumb') {
    contentType = object.metadata?.mime || mimeForThumbnailKey(objectKey) || 'application/octet-stream'
  }
  headers.set('Content-Type', contentType)
  headers.set('Content-Disposition', contentDisposition(contentType, filename))
  const objectSize = variant === 'thumb' ? object.size : objectRow.size
  if (objectSize !== null) headers.set('Content-Length', String(objectSize))
  return new Response(object.body as BodyInit, { headers })
})

async function fileAccessForRow(
  db: D1Database,
  row: MemoAttachmentFileRow,
  viewerId: string | null,
  shareToken: string | undefined,
): Promise<FileAccess | null> {
  if (viewerId && viewerId === row.user_id) return 'owner'
  if (!row.memo_id) return null

  if (shareToken && shareToken.length <= SHARE_TOKEN_MAX_CHARS) {
    const tokenHash = await hashOpaqueToken(shareToken)
    const now = Math.floor(Date.now() / 1000)
    if (await shareVouchesForAttachment(db, tokenHash, row.user_id, row.memo_id, now)) {
      return 'share'
    }
  }

  const visibility = row.memo_visibility
  const state = row.memo_state
  if (!visibility || !state) return null
  if (isProtectedReadable(viewerId, visibility, state)) return 'protected'
  if (isPubliclyReadable(visibility, state)) return 'public'
  return null
}

function cacheControlFor(access: FileAccess): string {
  return access === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store'
}

function contentDisposition(contentType: string, filename: string): string {
  return `${isMemoInlineSafe(contentType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeUriComponentExtras(filename)}`
}

function encodeUriComponentExtras(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function matchesETag(header: string, tag: string): boolean {
  const cleanTarget = tag.replace(/^W\//i, '').replace(/^"|"$/g, '')
  return header.split(',').some((item) => {
    const trimmed = item.trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
    return trimmed === '*' || trimmed === cleanTarget
  })
}

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

function mimeForThumbnailKey(key: string): string | null {
  const dot = key.lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_MIME_BY_EXTENSION[key.slice(dot + 1).toLowerCase()] ?? null
}

function notFound(): ApiError {
  return ApiError.notFound('Attachment not found')
}
