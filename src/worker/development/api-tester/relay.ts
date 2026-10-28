import { Hono } from 'hono'
import { isBlockedTarget } from '@shared/ai-proxy-guard'
import {
  MAX_PROXY_REDIRECTS,
  MAX_PROXY_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  PROXY_RATE_LIMIT,
} from '@shared/development/api-tester/limits'
import { PROXY_JSON_LIMIT, ProxyRequestSchema } from '@shared/development/api-tester/schemas'
import type { HttpMethod, ProxyRequest, ProxyResponse } from '@shared/development/api-tester/types'
import type { AppBindings, Env } from '../../env'
import { toBase64 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../../lib/throttle'
import { readOwnedFileBytes } from './files'

export const relayRoutes = new Hono<AppBindings>()

/**
 * The headers a relay must never forward.
 *
 * `host` and `content-length` describe the request this worker is making, not the one the user
 * composed, and the rest belong to the connection between two hops rather than to the call itself.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/** Credentials that belong to one origin, so a cross-origin redirect must not carry them along. */
const CROSS_ORIGIN_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const

/** C0 controls other than horizontal tab, and DEL: a header value carrying one is a header injection. */
const HEADER_CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function parseProxyRequest(raw: unknown): ProxyRequest {
  const result = ProxyRequestSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'body'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return result.data
}

/**
 * The URL a relay may call: an absolute http(s) address, without embedded credentials, whose host
 * is not a literal private or internal address.
 *
 * Redirect targets go through the same check on every hop, which is why this takes an already
 * parsed URL as well as text.
 */
function assertTargetUrl(value: string | URL): URL {
  let url: URL
  try {
    url = value instanceof URL ? value : new URL(value)
  } catch {
    throw new ApiError(400, 'bad_request', 'invalid_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'bad_request', 'invalid_url')
  }
  if (url.username || url.password) {
    throw new ApiError(400, 'bad_request', 'invalid_url')
  }
  if (isBlockedTarget(url.hostname)) {
    throw new ApiError(403, 'apitester_blocked_target', 'blocked_target')
  }
  return url
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return MIN_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)))
}

function buildRequestHeaders(input: ProxyRequest['headers']): Headers {
  const headers = new Headers()
  for (const header of input) {
    const key = header.key.trim().toLowerCase()
    if (!key || HOP_BY_HOP_HEADERS.has(key)) continue
    if (HEADER_CONTROL_CHARS.test(header.key) || HEADER_CONTROL_CHARS.test(header.value)) {
      throw ApiError.badRequest(`Invalid header: ${header.key}`)
    }
    // Header names are case-insensitive, so a repeated user header keeps the last value.
    headers.set(key, header.value)
  }
  return headers
}

async function resolveRequestBody(env: Env, userId: string, input: ProxyRequest): Promise<string | Uint8Array | undefined> {
  if (input.bodyFileId && input.body !== undefined) {
    throw ApiError.badRequest('body and bodyFileId are mutually exclusive')
  }
  if (input.method === 'GET' || input.method === 'HEAD') return undefined
  if (input.bodyFileId) return readOwnedFileBytes(env, userId, input.bodyFileId)
  return input.body
}

function parseSetCookie(value: string): ProxyResponse['cookies'][number] | null {
  const parts = value.split(';')
  const pair = parts[0]?.trim() ?? ''
  const separator = pair.indexOf('=')
  if (separator <= 0) return null
  const cookie: ProxyResponse['cookies'][number] = {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  }
  for (const attribute of parts.slice(1)) {
    const trimmed = attribute.trim()
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const name = trimmed.slice(0, index).trim().toLowerCase()
    const attributeValue = trimmed.slice(index + 1).trim()
    if (name === 'domain') cookie.domain = attributeValue
    if (name === 'path') cookie.path = attributeValue
  }
  return cookie
}

/** The fallback split for runtimes without `Headers.getSetCookie`, where one string holds every cookie. */
function splitCombinedSetCookie(value: string | null): string[] {
  if (!value) return []
  return value.split(/,(?=\s*[^;,=\s]+=)/)
}

function readCookies(headers: Headers): ProxyResponse['cookies'] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  const values =
    typeof withGetter.getSetCookie === 'function'
      ? withGetter.getSetCookie() ?? []
      : splitCombinedSetCookie(headers.get('set-cookie'))
  const cookies: ProxyResponse['cookies'] = []
  for (const value of values) {
    const parsed = parseSetCookie(value)
    if (parsed) cookies.push(parsed)
  }
  return cookies
}

function isTextContentType(contentType: string): boolean {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!mime) return true
  if (mime.startsWith('text/')) return true
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return true
  if (mime.includes('json') || mime.includes('xml')) return true
  return (
    mime === 'application/javascript' ||
    mime === 'application/x-javascript' ||
    mime === 'application/ecmascript' ||
    mime === 'application/x-www-form-urlencoded' ||
    mime === 'application/graphql' ||
    mime === 'application/sql' ||
    mime === 'application/yaml' ||
    mime === 'application/x-yaml' ||
    mime === 'application/x-sh'
  )
}

function responseHeaders(headers: Headers): ProxyResponse['headers'] {
  return Array.from(headers.entries(), ([key, value]) => ({ key, value }))
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The redirect's own payload is never read; a cancel that itself rejects changes nothing here.
  }
}

interface BodyRead {
  bytes: Uint8Array | null
  size: number
  tooLarge: boolean
}

async function readCappedBody(response: Response): Promise<BodyRead> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0), size: 0, tooLarge: false }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_PROXY_RESPONSE_BYTES) {
        try {
          await reader.cancel('response_too_large')
        } catch {
          // The payload is already refused; the reader is released below either way.
        }
        return { bytes: null, size: total, tooLarge: true }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, size: total, tooLarge: false }
}

function errorEnvelope(input: {
  error: string
  url: string
  redirected: boolean
  totalMs: number
  ttfbMs?: number
  status?: number
  statusText?: string
  headers?: ProxyResponse['headers']
  contentType?: string
  sizeBytes?: number
  cookies?: ProxyResponse['cookies']
}): ProxyResponse {
  const ttfbMs = input.ttfbMs ?? 0
  return {
    status: input.status ?? 0,
    statusText: input.statusText ?? '',
    headers: input.headers ?? [],
    contentType: input.contentType ?? '',
    sizeBytes: input.sizeBytes ?? 0,
    durationMs: input.totalMs,
    body: null,
    bodyB64: null,
    redirected: input.redirected,
    url: input.url,
    cookies: input.cookies ?? [],
    timing: { ttfbMs, downloadMs: Math.max(0, input.totalMs - ttfbMs), totalMs: input.totalMs },
    error: input.error,
  }
}

async function runProxy(input: ProxyRequest, body: string | Uint8Array | undefined): Promise<ProxyResponse> {
  const startedAt = performance.now()
  const signal = AbortSignal.timeout(clampTimeout(input.timeoutMs))
  let current = assertTargetUrl(input.url)
  let method: HttpMethod = input.method
  let currentBody = body
  let redirected = false
  let hops = 0
  const headers = buildRequestHeaders(input.headers)

  try {
    for (;;) {
      const response = await fetch(current.toString(), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : currentBody,
        redirect: 'manual',
        signal,
      })
      const ttfbAt = performance.now()
      const ttfbMs = Math.max(0, Math.round(ttfbAt - startedAt))

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        if (input.redirect === 'follow' && location) {
          if (hops >= MAX_PROXY_REDIRECTS) {
            await discardBody(response)
            const totalMs = Math.max(0, Math.round(performance.now() - startedAt))
            return errorEnvelope({
              error: 'too_many_redirects',
              url: current.toString(),
              redirected,
              totalMs,
              ttfbMs,
              status: 0,
              headers: responseHeaders(response.headers),
              contentType: response.headers.get('content-type') ?? '',
              cookies: readCookies(response.headers),
            })
          }

          let next: URL
          try {
            next = new URL(location, current)
          } catch {
            await discardBody(response)
            const totalMs = Math.max(0, Math.round(performance.now() - startedAt))
            return errorEnvelope({
              error: 'invalid_redirect',
              url: current.toString(),
              redirected,
              totalMs,
              ttfbMs,
              headers: responseHeaders(response.headers),
              contentType: response.headers.get('content-type') ?? '',
              cookies: readCookies(response.headers),
            })
          }
          // Every hop is judged again: a public host may redirect into the network this worker
          // can see but the caller cannot.
          try {
            assertTargetUrl(next)
          } catch (error) {
            await discardBody(response)
            throw error
          }

          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET'
            currentBody = undefined
          }
          if (next.origin !== current.origin) {
            for (const name of CROSS_ORIGIN_HEADERS) headers.delete(name)
          }

          hops += 1
          redirected = true
          current = next
          await discardBody(response)
          continue
        }
      }

      const headersOut = responseHeaders(response.headers)
      const contentType = response.headers.get('content-type') ?? ''
      const cookies = readCookies(response.headers)
      const read = await readCappedBody(response)
      const finishedAt = performance.now()
      const totalMs = Math.max(0, Math.round(finishedAt - startedAt))
      const downloadMs = Math.max(0, Math.round(finishedAt - ttfbAt))

      if (read.tooLarge || !read.bytes) {
        return {
          status: 0,
          statusText: '',
          headers: headersOut,
          contentType,
          sizeBytes: read.size,
          durationMs: totalMs,
          body: null,
          bodyB64: null,
          redirected,
          url: current.toString(),
          cookies,
          timing: { ttfbMs, downloadMs, totalMs },
          error: 'response_too_large',
        }
      }

      const text = isTextContentType(contentType)
      return {
        status: response.status,
        statusText: response.statusText,
        headers: headersOut,
        contentType,
        sizeBytes: read.size,
        durationMs: totalMs,
        body: text ? new TextDecoder().decode(read.bytes) : null,
        bodyB64: text ? null : toBase64(read.bytes),
        redirected,
        url: current.toString(),
        cookies,
        timing: { ttfbMs, downloadMs, totalMs },
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    const timedOut =
      signal.aborted ||
      (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    const failure = timedOut ? 'request_timeout' : 'upstream_unreachable'
    console.warn('[inkstone] API tester proxy request failed:', failure, current.hostname)
    return errorEnvelope({
      error: failure,
      url: current.toString(),
      redirected,
      totalMs: Math.max(0, Math.round(performance.now() - startedAt)),
    })
  }
}

relayRoutes.post('/proxy', async (c) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()

  await assertAttemptBudget(
    () =>
      consumeAttemptBudget(c.env.DB, [
        { key: `apitester-proxy:${userId}`, ...PROXY_RATE_LIMIT },
      ]),
    'Too many proxy requests',
  )

  const input = parseProxyRequest(await readJson<unknown>(c, PROXY_JSON_LIMIT))
  const body = await resolveRequestBody(c.env, userId, input)
  return c.json(await runProxy(input, body))
})
