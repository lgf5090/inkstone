import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import type { ImgbedFile } from '@shared/imgbed/model'
import { getFile, getSettingsGroup } from './store'
import { parseSecuritySettings } from '@shared/imgbed/settings'
import { listResolvedChannels } from './channels'
import { getWholeFile } from './storage'
import { fileAccessDecision } from './access'
import { optionalAdminActor } from './auth'
import { loadSession } from '../middleware/auth'
import { getDiscordAttachmentUrl, getTelegramContent } from './storage'

export const imgbedServeRoutes = new Hono<AppBindings>()

const BLOCKED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#111827"/><text x="50%" y="50%" fill="#f9fafb" font-family="sans-serif" font-size="28" text-anchor="middle">Blocked</text></svg>'
const WHITELIST_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1f2937"/><text x="50%" y="50%" fill="#f9fafb" font-family="sans-serif" font-size="28" text-anchor="middle">Whitelist enabled</text></svg>'

const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
  'application/pdf', 'text/plain',
])
const ATTACHMENT_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml',
  'application/javascript', 'text/javascript',
])

function denied(reason: 'blocked' | 'whitelist' | 'domain'): Response {
  const body = reason === 'whitelist' ? WHITELIST_SVG : BLOCKED_SVG
  return new Response(body, {
    status: 403,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function fileNameHeader(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `filename="${encoded}"; filename*=UTF-8''${encoded}`
}

function contentDisposition(fileType: string, fileName: string, download: boolean): string {
  const inline = INLINE_TYPES.has(fileType) || fileType.startsWith('video/') || fileType.startsWith('audio/') || fileType === 'image/svg+xml'
  return `${download || ATTACHMENT_TYPES.has(fileType) || !inline ? 'attachment' : 'inline'}; ${fileNameHeader(fileName)}`
}

function responseHeaders(file: ImgbedFile, admin: boolean, download: boolean): Headers {
  const headers = new Headers()
  headers.set('Content-Type', ATTACHMENT_TYPES.has(file.fileType) ? 'text/plain' : file.fileType || 'application/octet-stream')
  headers.set('Content-Disposition', contentDisposition(file.fileType, file.fileName, download))
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Vary', 'Range')
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', admin ? 'private, max-age=86400' : 'public, max-age=300')
  if (file.fileType === 'image/svg+xml') {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
  }
  return headers
}

async function resolveChannel(env: AppBindings['Bindings'], db: D1Database, file: ImgbedFile) {
  const channels = await listResolvedChannels(env, db, true)
  return channels.find((channel) => channel.type === file.source && channel.name === file.channelName)
    ?? null
}

async function chunkedResponse(file: ImgbedFile, channel: NonNullable<Awaited<ReturnType<typeof resolveChannel>>>, range: string | null, headers: Headers): Promise<Response | null> {
  if (!file.parts?.length) return null
  const chunks: Uint8Array[] = []
  for (const part of [...file.parts].sort((a, b) => a.index - b.index)) {
    let response: Response | null = null
    if (channel.type === 'telegram' && part.fileId) {
      response = await getTelegramContent(channel, part.fileId)
    } else if (channel.type === 'discord' && part.messageId) {
      response = await fetch(await getDiscordAttachmentUrl(channel, part.messageId))
    }
    if (!response?.ok) return null
    chunks.push(new Uint8Array(await response.arrayBuffer()))
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  let start = 0
  let end = total - 1
  let status = 200
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!match) return new Response('Range Not Satisfiable', { status: 416 })
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : total - 1
    if (start > end || start >= total) return new Response('Range Not Satisfiable', { status: 416 })
    status = 206
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
  }
  const output = new Uint8Array(end - start + 1)
  let cursor = 0
  let write = 0
  for (const chunk of chunks) {
    const chunkStart = cursor
    const chunkEnd = cursor + chunk.byteLength - 1
    if (chunkEnd >= start && chunkStart <= end) {
      const from = Math.max(0, start - chunkStart)
      const to = Math.min(chunk.byteLength, end - chunkStart + 1)
      output.set(chunk.subarray(from, to), write)
      write += to - from
    }
    cursor += chunk.byteLength
  }
  headers.set('Content-Length', String(output.byteLength))
  const etag = `"${file.createdAt}-${total}"`
  headers.set('ETag', etag)
  return new Response(output, { status, headers })
}

async function transformResponse(env: AppBindings['Bindings'], response: Response, fileType: string, search: URLSearchParams): Promise<Response> {
  const width = Number(search.get('width'))
  const height = Number(search.get('height'))
  const fit = search.get('fit')
  const fallback = search.get('fallback') === 'original'
  if (!width && !height && !fit) return response
  if (!env.IMAGES) return new Response('Image resizing is not configured', { status: 503 })
  if (fit && (!width || !height)) return new Response('fit requires both width and height', { status: 400 })
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(fileType)) {
    return fallback ? response : new Response('Unsupported image type for resizing', { status: 415 })
  }
  const clone = fallback ? response.clone() : null
  try {
    const images = env.IMAGES as unknown as {
      input(body: ReadableStream): { transform(options: Record<string, unknown>): { output(options: Record<string, unknown>): Promise<{ response(): Response }> } }
    }
    const output = await images.input(response.body as ReadableStream)
      .transform({ ...(width ? { width } : {}), ...(height ? { height } : {}), ...(fit ? { fit } : {}) })
      .output({ format: fileType })
    return output.response()
  } catch (error) {
    console.warn('[inkstone] image resize failed:', error)
    return clone ?? new Response('Image resizing failed', { status: 422 })
  }
}

imgbedServeRoutes.get('/file/*', handleFile)
imgbedServeRoutes.on('HEAD', '/file/*', handleFile)

async function handleFile(c: Context<AppBindings>): Promise<Response> {
  const raw = c.req.path.replace(/^\/imgbed\/file\//, '')
  let id: string
  try { id = decodeURIComponent(raw) } catch { return new Response('Bad file id', { status: 400 }) }
  if (!id || id.includes('..') || id.includes('\\') || /[\u0000-\u001f]/.test(id)) return new Response('Bad file id', { status: 400 })
  const db = c.env.DB
  const file = await getFile(db, id)
  if (!file) return new Response('File not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const security = parseSecuritySettings(await getSettingsGroup(db, 'security'))
  const url = new URL(c.req.url)
  const fromAdmin = url.searchParams.get('from') === 'admin'
  if (fromAdmin) await loadSession(c, async () => {})
  const adminActor = fromAdmin ? await optionalAdminActor(c) : null
  if (fromAdmin && !adminActor) return new Response('Admin authentication required', { status: 401, headers: { 'Cache-Control': 'no-store' } })
  const decision = fileAccessDecision({
    file, access: security.access,
    referer: c.req.header('referer') ?? null,
    requestHost: url.hostname,
    admin: Boolean(adminActor),
  })
  if (!decision.allowed) return denied(decision.reason ?? 'blocked')
  if (file.source === 'external') return Response.redirect(file.externalLink ?? '', 302)

  const channel = await resolveChannel(c.env, db, file)
  if (!channel) return new Response('Channel is not configured', { status: 503 })
  const headers = responseHeaders(file, Boolean(adminActor), url.searchParams.get('download') === '1')
  const range = c.req.header('range') ?? null
  if (file.isChunked) {
    const reconstructed = await chunkedResponse(file, channel, range, headers)
    if (!reconstructed) return new Response('Chunked file is incomplete', { status: 502 })
    if (c.req.method === 'HEAD') return new Response(null, { status: reconstructed.status, headers: reconstructed.headers })
    return reconstructed
  }
  const response = await getWholeFile(c.env, channel, file, range)
  if (!response) return new Response('File not found', { status: 404 })
  const etag = response.headers.get('etag') ?? `"${file.createdAt}-${file.sizeBytes}"`
  headers.set('ETag', etag)
  const inm = c.req.header('if-none-match')
  if (inm && inm === etag) {
    await response.body?.cancel().catch(() => {})
    return new Response(null, { status: 304, headers })
  }
  const contentRange = response.headers.get('content-range')
  const contentLength = response.headers.get('content-length')
  if (contentRange) headers.set('Content-Range', contentRange)
  if (contentLength) headers.set('Content-Length', contentLength)
  const transformed = await transformResponse(c.env, response, file.fileType, url.searchParams)
  if (transformed !== response) return transformed
  if (c.req.method === 'HEAD') {
    await response.body?.cancel().catch(() => {})
    return new Response(null, { status: response.status, headers })
  }
  return new Response(response.body, { status: response.status, headers })
}
