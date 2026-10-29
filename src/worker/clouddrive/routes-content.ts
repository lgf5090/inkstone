/**
 * Authenticated file content for the primary R2 mount.
 *
 * One resolver decides whether a file is visible to the caller; the byte response, the Range
 * handling and the thumbnail all use that answer instead of their own SQL. The body of a live file
 * is immutable (an id is never reused), so the authenticated cache policy can be a long one.
 *
 * `GET /download/zip` is deliberately a 501 for now: a streaming archive needs its own size/item
 * limits and testing, and answering with a fake empty zip would hide that it is not implemented.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { contentDisposition, parseByteRange } from '../lib/http-range'

export const clouddriveContentRoutes = new Hono<AppBindings>()

const AUTHENTICATED_CACHE = 'private, max-age=31536000, immutable'
const THUMBNAIL_CACHE = 'private, max-age=86400'
const THUMBNAIL_WIDTHS = new Set([160, 320, 640, 1280])

interface FileRow {
  id: string
  name: string
  kind: string
  category: string
  mime: string
  size: number
  etag: string | null
  storage_kind: string
  storage_key: string | null
  uploaded_at: number
  modified_at: number
}

interface ImagesBindingLike {
  input(body: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: Record<string, unknown>): Promise<{ response(): Response }>
    }
  }
}

function requireUserId(c: Context<AppBindings>): string {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

async function findLiveFile(c: Context<AppBindings>, userId: string, id: string): Promise<FileRow> {
  const row = await c.env.DB.prepare(
    `SELECT id, name, kind, category, mime, size, etag, storage_kind, storage_key, uploaded_at, modified_at
       FROM CloudDrive_files
      WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(userId, id).first<FileRow>()
  if (!row || row.kind !== 'file') throw ApiError.notFound('File not found')
  return row
}

function entityTagOf(file: FileRow): string {
  const raw = (file.etag ?? `${file.id}-${file.size}`).replace(/^W\//i, '').replace(/^"|"$/g, '')
  return `"${raw}"`
}

function matchesEntityTag(header: string, etag: string): boolean {
  const target = etag.replace(/^W\//i, '').replace(/^"|"$/g, '')
  return header.split(',').some((item) => {
    const trimmed = item.trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
    return trimmed === '*' || trimmed === target
  })
}

function dispositionOf(mime: string, name: string, download: boolean): string {
  const value = contentDisposition(mime, name)
  return download ? value.replace(/^inline;/, 'attachment;') : value
}

function baseHeaders(file: FileRow, download: boolean): Headers {
  const headers = new Headers({
    'Content-Type': file.mime || 'application/octet-stream',
    'Content-Disposition': dispositionOf(file.mime, file.name, download),
    'Accept-Ranges': 'bytes',
    'ETag': entityTagOf(file),
    'Last-Modified': new Date(file.uploaded_at).toUTCString(),
    'Cache-Control': AUTHENTICATED_CACHE,
    'X-Content-Type-Options': 'nosniff',
  })
  return headers
}

function notSatisfiable(file: FileRow): Response {
  const headers = baseHeaders(file, true)
  headers.set('Content-Range', `bytes */${file.size}`)
  headers.delete('Content-Disposition')
  return new Response(null, { status: 416, headers })
}

async function requireBucket(c: Context<AppBindings>): Promise<R2Bucket> {
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  return bucket
}

clouddriveContentRoutes.on(['GET', 'HEAD'], '/files/:id/content', async (c) => {
  const userId = requireUserId(c)
  const file = await findLiveFile(c, userId, c.req.param('id'))
  if (file.storage_kind !== 'r2' || !file.storage_key) {
    throw new ApiError(503, 'clouddrive_mount_unavailable', 'This file is not on the primary mount')
  }
  const bucket = await requireBucket(c)
  const download = c.req.query('download') === '1'
  const etag = entityTagOf(file)

  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && matchesEntityTag(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { 'ETag': etag, 'Cache-Control': AUTHENTICATED_CACHE },
    })
  }

  const rangeHeader = c.req.header('range')
  const range = rangeHeader ? parseByteRange(rangeHeader, file.size) : null
  if (range === 'invalid') return notSatisfiable(file)
  const headers = baseHeaders(file, download)

  if (c.req.method === 'HEAD') {
    const object = await bucket.head(file.storage_key)
    if (!object) throw ApiError.notFound('File data is missing')
    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
      headers.set('Content-Length', String(range.end - range.start + 1))
      return new Response(null, { status: 206, headers })
    }
    headers.set('Content-Length', String(file.size))
    return new Response(null, { status: 200, headers })
  }

  const object = await bucket.get(
    file.storage_key,
    range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
  )
  if (!object) throw ApiError.notFound('File data is missing')

  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    return new Response(object.body, { status: 206, headers })
  }
  headers.set('Content-Length', String(file.size))
  return new Response(object.body, { status: 200, headers })
})

clouddriveContentRoutes.get('/files/:id/thumbnail', async (c) => {
  const userId = requireUserId(c)
  const widthParam = c.req.query('w') ?? '320'
  const width = Number(widthParam)
  if (!THUMBNAIL_WIDTHS.has(width)) throw ApiError.badRequest('w must be one of 160, 320, 640 or 1280')

  const file = await findLiveFile(c, userId, c.req.param('id'))
  if (!file.mime.startsWith('image/')) throw ApiError.badRequest('Only images have thumbnails')
  if (file.storage_kind !== 'r2' || !file.storage_key) {
    throw new ApiError(503, 'clouddrive_mount_unavailable', 'This file is not on the primary mount')
  }
  const bucket = await requireBucket(c)

  const fallbackHeaders = (): Headers => new Headers({
    'Content-Type': file.mime,
    'Content-Length': String(file.size),
    'ETag': entityTagOf(file),
    'Cache-Control': THUMBNAIL_CACHE,
    'X-Content-Type-Options': 'nosniff',
    'X-CloudDrive-Thumbnail': 'fallback',
  })

  // SVG is not a bitmap Image Resizing can decode; every other image is tried and falls back below.
  if (!c.env.IMAGES || file.mime === 'image/svg+xml') {
    const object = await bucket.get(file.storage_key)
    if (!object) throw ApiError.notFound('File data is missing')
    return new Response(object.body, { headers: fallbackHeaders() })
  }

  const object = await bucket.get(file.storage_key)
  if (!object) throw ApiError.notFound('File data is missing')
  try {
    const images = c.env.IMAGES as unknown as ImagesBindingLike
    const output = await images.input(object.body as ReadableStream)
      .transform({ width })
      .output({ format: 'image/webp' })
    const transformed = output.response()
    if (!transformed.ok) throw new Error(`image resizing answered ${transformed.status}`)
    const headers = new Headers(transformed.headers)
    headers.set('Cache-Control', THUMBNAIL_CACHE)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(transformed.body, { status: transformed.status, headers })
  } catch (error) {
    // Image Resizing refuses formats/corrupt files it cannot decode; the honest thumbnail is then
    // the original object, marked as a fallback rather than pretending a resize happened.
    console.warn('[inkstone] CloudDrive thumbnail resize failed; serving the original:', error)
    const original = await bucket.get(file.storage_key)
    if (!original) throw ApiError.notFound('File data is missing')
    return new Response(original.body, { headers: fallbackHeaders() })
  }
})

clouddriveContentRoutes.on(['GET', 'POST'], '/download/zip', () => new Response(
  JSON.stringify({ error: { code: 'not_implemented', message: 'Streaming zip downloads are not available yet' } }),
  {
    status: 501,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  },
))
