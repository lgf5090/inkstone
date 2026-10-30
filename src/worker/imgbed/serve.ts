import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import type { ImgbedFile, ImgbedPart } from '@shared/imgbed/model'
import { getFileRow, getSettingsGroup, rowToFile } from './store'
import { parseSecuritySettings } from '@shared/imgbed/settings'
import { getResolvedChannel } from './channels'
import type { ImgbedChannelType } from '@shared/imgbed/model'
import { getWholeFile } from './storage'
import { fileAccessDecision } from './access'
import { optionalAdminActor } from './auth'
import { loadSession } from '../middleware/auth'
import { getDiscordAttachmentUrl, getTelegramContent } from './storage'
import { imgbedResponseHeaders, imgbedTransformHeaders, imgbedTransformPolicy, type ImgbedTransformPolicy } from './file-headers'

export const imgbedServeRoutes = new Hono<AppBindings>()

const BLOCKED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#111827"/><text x="50%" y="50%" fill="#f9fafb" font-family="sans-serif" font-size="28" text-anchor="middle">Blocked</text></svg>'
const WHITELIST_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1f2937"/><text x="50%" y="50%" fill="#f9fafb" font-family="sans-serif" font-size="28" text-anchor="middle">Whitelist enabled</text></svg>'

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

async function resolveChannel(env: AppBindings['Bindings'], db: D1Database, file: ImgbedFile) {
  return getResolvedChannel(env, db, file.source as ImgbedChannelType, file.channelName)
}

async function fetchChunkPart(channel: NonNullable<Awaited<ReturnType<typeof resolveChannel>>>, part: ImgbedPart): Promise<Response | null> {
  if (channel.type === 'telegram' && part.fileId) return getTelegramContent(channel, part.fileId)
  if (channel.type === 'discord' && part.messageId) return fetch(await getDiscordAttachmentUrl(channel, part.messageId))
  return null
}

function parseByteRange(value: string, total: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : total - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return null
  return { start, end: Math.min(end, total - 1) }
}

async function chunkedResponse(file: ImgbedFile, channel: NonNullable<Awaited<ReturnType<typeof resolveChannel>>>, range: string | null, headers: Headers): Promise<Response | null> {
  const parts = [...(file.parts ?? [])].sort((a, b) => a.index - b.index)
  if (!parts.length) return null
  const total = parts.reduce((sum, part) => sum + Number(part.size ?? 0), 0)
  headers.set('ETag', `"${file.createdAt}-${total}"`)
  if (range) {
    const parsed = parseByteRange(range, total)
    if (!parsed) return new Response('Range Not Satisfiable', { status: 416 })
    const chunks: Uint8Array[] = []
    let cursor = 0
    for (const part of parts) {
      const size = Number(part.size ?? 0)
      const partStart = cursor
      const partEnd = cursor + size - 1
      if (partEnd >= parsed.start && partStart <= parsed.end) {
        const response = await fetchChunkPart(channel, part)
        if (!response?.ok) return null
        const bytes = new Uint8Array(await response.arrayBuffer())
        const from = Math.max(0, parsed.start - partStart)
        const to = Math.min(bytes.byteLength, parsed.end - partStart + 1)
        chunks.push(bytes.subarray(from, to))
      }
      cursor += size
    }
    const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
    headers.set('Content-Range', `bytes ${parsed.start}-${parsed.end}/${total}`)
    headers.set('Content-Length', String(output.byteLength))
    return new Response(output, { status: 206, headers })
  }
  headers.set('Content-Length', String(total))
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        const response = await fetchChunkPart(channel, part)
        if (!response?.ok) { controller.error(new Error('Chunked part unavailable')); return }
        controller.enqueue(new Uint8Array(await response.arrayBuffer()))
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers })
}

async function transformResponse(
  env: AppBindings['Bindings'],
  response: Response,
  fileType: string,
  policy: ImgbedTransformPolicy,
  headers: Headers,
  head: boolean,
): Promise<Response> {
  if (!env.IMAGES) return new Response('Image resizing is not configured', { status: 503 })
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(fileType)) {
    return policy.fallback ? new Response(head ? null : response.body, { status: response.status, headers }) : new Response('Unsupported image type for resizing', { status: 415 })
  }
  const fallback = policy.fallback ? response.clone() : null
  try {
    const images = env.IMAGES as unknown as {
      input(body: ReadableStream): { transform(options: Record<string, unknown>): { output(options: Record<string, unknown>): Promise<{ response(): Response }> } }
    }
    const output = await images.input(response.body as ReadableStream)
      .transform({ ...(policy.width ? { width: policy.width } : {}), ...(policy.height ? { height: policy.height } : {}), ...(policy.fit ? { fit: policy.fit } : {}) })
      .output({ format: fileType })
    const transformed = output.response()
    const merged = imgbedTransformHeaders(headers, transformed, policy)
    return new Response(head ? null : transformed.body, { status: transformed.status, headers: merged })
  } catch (error) {
    console.warn('[inkstone] image resize failed:', error)
    return fallback ?? new Response('Image resizing failed', { status: 422 })
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
  const row = await getFileRow(db, id)
  if (!row) return new Response('File not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const file = rowToFile(row)
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
    fetchDest: c.req.header('sec-fetch-dest') ?? null,
  })
  if (!decision.allowed) return denied(decision.reason ?? 'blocked')
  if (file.source === 'external') return Response.redirect(file.externalLink ?? '', 302)
  const transform = imgbedTransformPolicy(url.searchParams, security.access)
  if (!transform.ok) return new Response(transform.message, { status: transform.status, headers: { 'Cache-Control': 'no-store' } })
  const range = c.req.header('range') ?? null
  if (transform.policy.requested && range) return new Response('Image transformation cannot be combined with a range request', { status: 400, headers: { 'Cache-Control': 'no-store' } })

  const channel = await resolveChannel(c.env, db, file)
  if (!channel) return new Response('Channel is not configured', { status: 503 })
  const headers = imgbedResponseHeaders(file, { admin: Boolean(adminActor), download: url.searchParams.get('download') === '1' })
  if (file.isChunked) {
    const reconstructed = await chunkedResponse(file, channel, range, headers)
    if (!reconstructed) return new Response('Chunked file is incomplete', { status: 502 })
    if (transform.policy.requested) {
      const transformed = await transformResponse(c.env, reconstructed, file.fileType, transform.policy, reconstructed.headers, c.req.method === 'HEAD')
      if (transformed !== reconstructed) return transformed
    }
    if (c.req.method === 'HEAD') {
      await reconstructed.body?.cancel().catch(() => {})
      return new Response(null, { status: reconstructed.status, headers: reconstructed.headers })
    }
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
  if (transform.policy.requested) {
    const transformed = await transformResponse(c.env, response, file.fileType, transform.policy, headers, c.req.method === 'HEAD')
    if (transformed !== response) return transformed
  }
  if (c.req.method === 'HEAD') {
    await response.body?.cancel().catch(() => {})
    return new Response(null, { status: response.status, headers })
  }
  return new Response(response.body, { status: response.status, headers })
}
