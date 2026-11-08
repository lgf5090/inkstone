import { Hono } from 'hono'
import { isBlockedTarget } from '@shared/ai-proxy-guard'
import {
  MAX_MULTIPART_BYTES,
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
import { readCappedBody } from './body'
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

/**
 * Redirects are followed automatically only while they stay on the origin the user named.
 *
 * A cross-origin hop is a new destination chosen by the upstream, so the relay stops there and
 * returns the 30x response (with `Location`) instead of forwarding the user's headers, credentials
 * or body to a target they did not configure. The caller can then decide to request that URL
 * explicitly.
 */

/** C0 controls other than horizontal tab, and DEL: a header value carrying one is a header injection. */
const HEADER_CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** The charset parameter of a media type, if it names one. */
function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
  return match?.[1]?.trim() || null
}

/**
 * Decodes text with the charset the response declares, falling back to UTF-8 when the label is
 * absent or unknown. The previous fixed UTF-8 decoder turned every GBK/Shift_JIS response into
 * mojibake even though the upstream had said what it was.
 */
function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = charsetOf(contentType)
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      console.warn('[inkstone] API tester response used an unsupported charset:', charset)
    }
  }
  return new TextDecoder().decode(bytes)
}

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

async function resolveRequestBody(
  env: Env,
  userId: string,
  input: ProxyRequest,
): Promise<string | Uint8Array | FormData | undefined> {
  if (input.bodyFileId && input.body !== undefined) {
    throw ApiError.badRequest('body and bodyFileId are mutually exclusive')
  }
  if (input.method === 'GET' || input.method === 'HEAD') return undefined
  if (input.multipart) {
    const form = new FormData()
    let total = 0
    for (const field of input.multipart) {
      if (field.isFile) {
        if (!field.fileId) throw ApiError.badRequest('A multipart file field is missing its file id')
        const bytes = await readOwnedFileBytes(env, userId, field.fileId)
        total += bytes.byteLength
        if (total > MAX_MULTIPART_BYTES) {
          throw new ApiError(413, 'payload_too_large', `Multipart bodies are limited to ${MAX_MULTIPART_BYTES} bytes`)
        }
        form.append(
          field.key,
          new Blob([bytes], { type: field.contentType || 'application/octet-stream' }),
          field.fileName || 'file',
        )
      } else {
        form.append(field.key, field.value)
      }
    }
    return form
  }
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
  const now = Date.now()
  for (const attribute of parts.slice(1)) {
    const trimmed = attribute.trim()
    const index = trimmed.indexOf('=')
    if (index <= 0) {
      const name = trimmed.toLowerCase()
      if (name === 'secure') cookie.secure = true
      if (name === 'httponly') cookie.httpOnly = true
      continue
    }
    const name = trimmed.slice(0, index).trim().toLowerCase()
    const attributeValue = trimmed.slice(index + 1).trim()
    if (name === 'domain') cookie.domain = attributeValue
    if (name === 'path') cookie.path = attributeValue
    if (name === 'max-age') {
      const seconds = Number(attributeValue)
      if (Number.isFinite(seconds)) cookie.expiresAt = now + seconds * 1_000
    }
    if (name === 'expires') {
      const parsed = Date.parse(attributeValue)
      if (Number.isFinite(parsed)) cookie.expiresAt = parsed
    }
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

/**
 * The 30x response itself, kept intact for the user: status, headers (including `Location`) and the
 * body the upstream sent. The `error` field tells the client why automatic following stopped.
 */
async function redirectEnvelope(input: {
  response: Response
  url: URL
  redirected: boolean
  startedAt: number
  ttfbAt: number
}): Promise<ProxyResponse> {
  const headersOut = responseHeaders(input.response.headers)
  const contentType = input.response.headers.get('content-type') ?? ''
  const cookies = readCookies(input.response.headers)
  const read = await readCappedBody(input.response, MAX_PROXY_RESPONSE_BYTES)
  const finishedAt = performance.now()
  const totalMs = Math.max(0, Math.round(finishedAt - input.startedAt))
  const downloadMs = Math.max(0, Math.round(finishedAt - input.ttfbAt))
  const text = isTextContentType(contentType)
  return {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: headersOut,
    contentType,
    sizeBytes: read.size,
    durationMs: totalMs,
    body: read.bytes && text ? decodeBody(read.bytes, contentType) : null,
    bodyB64: read.bytes && !text ? toBase64(read.bytes) : null,
    redirected: input.redirected,
    url: input.url.toString(),
    cookies,
    timing: { ttfbMs: Math.max(0, Math.round(input.ttfbAt - input.startedAt)), downloadMs, totalMs },
    error: 'cross_origin_redirect',
  }
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

async function runProxy(
  input: ProxyRequest,
  body: string | Uint8Array | FormData | undefined,
): Promise<ProxyResponse> {
  const startedAt = performance.now()
  const signal = AbortSignal.timeout(clampTimeout(input.timeoutMs))
  let current = assertTargetUrl(input.url)
  let method: HttpMethod = input.method
  let currentBody: string | Uint8Array | FormData | undefined = body
  let redirected = false
  let hops = 0
  const headers = buildRequestHeaders(input.headers)
  // A FormData body owns its boundary; a user-supplied Content-Type would make it unreadable.
  if (body instanceof FormData) headers.delete('content-type')

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

          if (next.origin !== current.origin) {
            return redirectEnvelope({
              response,
              url: current,
              redirected,
              startedAt,
              ttfbAt,
            })
          }

          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET'
            currentBody = undefined
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
      const read = await readCappedBody(response, MAX_PROXY_RESPONSE_BYTES)
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
        body: text ? decodeBody(read.bytes, contentType) : null,
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
