import type { ImgbedFile } from '@shared/imgbed/model'
import type { ImgbedAccessSettings } from '@shared/imgbed/settings'

export const IMGBED_INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
  'text/plain',
])
export const IMGBED_ATTACHMENT_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml',
  'application/javascript', 'text/javascript',
])

function fileNameHeader(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `filename="${encoded}"; filename*=UTF-8''${encoded}`
}

export function imgbedContentDisposition(fileType: string, fileName: string, download: boolean): string {
  const inline = IMGBED_INLINE_TYPES.has(fileType) || fileType.startsWith('video/') || fileType.startsWith('audio/') || fileType === 'image/svg+xml'
  return `${download || IMGBED_ATTACHMENT_TYPES.has(fileType) || !inline ? 'attachment' : 'inline'}; ${fileNameHeader(fileName)}`
}

export function imgbedResponseHeaders(
  file: Pick<ImgbedFile, 'fileType' | 'fileName'>,
  options: { admin?: boolean; download?: boolean; cacheControl?: string } = {},
): Headers {
  const headers = new Headers()
  headers.set('Content-Type', IMGBED_ATTACHMENT_TYPES.has(file.fileType) ? 'text/plain' : file.fileType || 'application/octet-stream')
  headers.set('Content-Disposition', imgbedContentDisposition(file.fileType, file.fileName, options.download === true))
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Vary', 'Range')
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', options.cacheControl ?? (options.admin ? 'private, max-age=60' : 'public, max-age=60'))
  if (file.fileType === 'image/svg+xml') {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
  }
  return headers
}

export interface ImgbedTransformPolicy {
  requested: boolean
  width?: number
  height?: number
  fit?: string
  fallback: boolean
}

export type ImgbedTransformDecision =
  | { ok: true; policy: ImgbedTransformPolicy }
  | { ok: false; status: 400 | 403 | 415; message: string }

const IMGBED_TRANSFORM_FITS = new Set(['scale-down', 'contain', 'cover', 'crop', 'pad'])
const IMGBED_TRANSFORM_MAX_DIMENSION = 4096

function parseAllowedSizes(raw: string): { width: number | 'auto'; height: number | 'auto' }[] {
  return String(raw ?? '').split(',').map((entry) => {
    const match = /^\s*(auto|\d{1,5})\s*[x×]\s*(auto|\d{1,5})\s*$/i.exec(entry)
    if (!match) return null
    const width = match[1]!.toLowerCase() === 'auto' ? 'auto' as const : Number(match[1])
    const height = match[2]!.toLowerCase() === 'auto' ? 'auto' as const : Number(match[2])
    if (width !== 'auto' && (width < 1 || width > IMGBED_TRANSFORM_MAX_DIMENSION)) return null
    if (height !== 'auto' && (height < 1 || height > IMGBED_TRANSFORM_MAX_DIMENSION)) return null
    return { width, height }
  }).filter((entry): entry is { width: number | 'auto'; height: number | 'auto' } => entry !== null)
}

export function imgbedTransformPolicy(search: URLSearchParams, access: ImgbedAccessSettings): ImgbedTransformDecision {
  const rawWidth = search.get('width')
  const rawHeight = search.get('height')
  const rawFit = search.get('fit')
  const requested = Boolean(rawWidth || rawHeight || rawFit)
  if (!requested) return { ok: true, policy: { requested: false, fallback: false } }
  if (!access.imageTransformEnabled) return { ok: false, status: 403, message: 'Image transformation is disabled' }
  const width = rawWidth ? Number(rawWidth) : undefined
  const height = rawHeight ? Number(rawHeight) : undefined
  if ((width !== undefined && (!Number.isInteger(width) || width < 1 || width > IMGBED_TRANSFORM_MAX_DIMENSION))
    || (height !== undefined && (!Number.isInteger(height) || height < 1 || height > IMGBED_TRANSFORM_MAX_DIMENSION))) {
    return { ok: false, status: 400, message: 'Image dimensions are out of range' }
  }
  const fit = rawFit ?? undefined
  if (fit && !IMGBED_TRANSFORM_FITS.has(fit)) return { ok: false, status: 400, message: 'Unsupported image fit' }
  if (fit && (!width || !height)) return { ok: false, status: 400, message: 'fit requires both width and height' }
  const allowed = parseAllowedSizes(access.imageTransformAllowedSizes)
  const matches = (value: number | undefined, entry: number | 'auto'): boolean => value === undefined ? entry === 'auto' : entry === value
  if (allowed.length && !allowed.some((entry) => matches(width, entry.width) && matches(height, entry.height))) {
    return { ok: false, status: 403, message: 'This image size is not allowed' }
  }
  return { ok: true, policy: { requested: true, width, height, fit, fallback: search.get('fallback') === 'original' } }
}

export function imgbedTransformHeaders(base: Headers, transformed: Response, policy: ImgbedTransformPolicy): Headers {
  const headers = new Headers(base)
  const contentType = transformed.headers.get('content-type')
  const contentLength = transformed.headers.get('content-length')
  headers.delete('Content-Range')
  if (contentType) headers.set('Content-Type', contentType)
  if (contentLength) headers.set('Content-Length', contentLength)
  const etag = base.get('ETag')
  if (etag) {
    const stamp = `${policy.width ?? 'auto'}x${policy.height ?? 'auto'}${policy.fit ? `-${policy.fit}` : ''}`
    headers.set('ETag', `${etag.replace(/"$/, '')}-${stamp}"`)
  }
  return headers
}
