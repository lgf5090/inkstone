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
