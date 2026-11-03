/**
 * One answer for "give me these bytes".
 *
 * Four routes hand out the same objects — the live file, a distributed file, an old version, and a
 * file shared into another account — and each used to assemble its own status line, entity tag,
 * disposition and range headers. That is how they drifted: one route advertised `Accept-Ranges`
 * while another served ranges without saying so, and only two of them honoured `If-None-Match`.
 */
import { contentDisposition, parseByteRange } from '../lib/http-range'

/** The row-shaped facts a content response is built from, whatever table the row came out of. */
export interface ContentDescriptor {
  /** Used for the fallback entity tag when the row stores none. */
  id: string
  size: number
  mime: string
  name: string
  etag: string | null
  lastModified: number
}

export type ContentPlan =
  /** A reply that needs no bytes: 304, 416, or a HEAD whose caller has nothing to verify. */
  | { kind: 'respond'; response: Response }
  /** A HEAD: the caller may still confirm the object exists, then answer with these headers. */
  | { kind: 'head'; status: 200 | 206; headers: Headers }
  /** Bytes to fetch at `offset` for `length`, then answer with these headers. */
  | { kind: 'serve'; status: 200 | 206; headers: Headers; offset: number; length: number }

const NO_STORE = 'private, no-store'

export function entityTagOf(file: Pick<ContentDescriptor, 'id' | 'size' | 'etag'>): string {
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

export function planContentResponse(input: {
  method: string
  rangeHeader: string | null | undefined
  ifNoneMatch: string | null | undefined
  download: boolean
  file: ContentDescriptor
  /** Content-addressed rows pass a long-lived cache; anything else stays `private, no-store`. */
  cacheControl?: string
}): ContentPlan {
  const file = input.file
  const cacheControl = input.cacheControl ?? NO_STORE
  const etag = entityTagOf(file)
  if (input.ifNoneMatch && matchesEntityTag(input.ifNoneMatch, etag)) {
    return {
      kind: 'respond',
      response: new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } }),
    }
  }

  const mime = file.mime || 'application/octet-stream'
  const disposition = contentDisposition(mime, file.name)
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Disposition': input.download ? disposition.replace(/^inline/, 'attachment') : disposition,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(file.lastModified).toUTCString(),
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  })

  const range = input.rangeHeader ? parseByteRange(input.rangeHeader, file.size) : null
  if (range === 'invalid') {
    // Nothing is being handed over, so the disposition goes and only the shape of the file stays.
    headers.set('Content-Range', `bytes */${file.size}`)
    headers.delete('Content-Disposition')
    return { kind: 'respond', response: new Response(null, { status: 416, headers }) }
  }

  const offset = range ? range.start : 0
  const length = range ? range.end - range.start + 1 : file.size
  headers.set('Content-Length', String(length))
  if (range) headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${file.size}`)
  const status: 200 | 206 = range ? 206 : 200
  if (input.method === 'HEAD') return { kind: 'head', status, headers }
  return { kind: 'serve', status, headers, offset, length }
}

/** The HEAD a caller answers after it has confirmed the object is really there. */
export function headResponse(plan: Extract<ContentPlan, { kind: 'head' }>): Response {
  return new Response(null, { status: plan.status, headers: plan.headers })
}
