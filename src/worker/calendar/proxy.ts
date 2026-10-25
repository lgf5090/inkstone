/**
 * The one door from a browser to a calendar provider.
 *
 * The reader's browser holds no credentials, so every CalDAV or Graph request arrives here as a
 * relative path and leaves with the authorization header this worker adds. That makes the path the
 * attack surface: it must stay inside the connection's own base, a traversal is refused in every
 * spelling, the method and every forwarded header come from a short list, and both directions are
 * capped while they stream. Redirects are refused outright rather than followed, because the address
 * this proxy checked is the one that was typed and a redirect would replace it with one nobody did.
 *
 * A per-connection minute budget and an in-isolate breaker sit in front of the network. Neither is a
 * quota; both exist so a broken adapter or a dead server cannot turn one reader's retry loop into an
 * unbounded fan-out or hold every request open.
 */
import { utf8ByteLength } from '@shared/text-utils'
import type { CalendarConnectionKind } from '@shared/calendar/model'
import type { Env } from '../env'
import { decryptCalendarCredential } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { createMinuteBudget } from '../lib/rate-limit'
import { readStreamTextWithinLimit } from '../lib/request'
import {
  GOOGLE_CALENDAR_API_BASE,
  OUTLOOK_CALENDAR_API_BASE,
  getCalendarConnection,
  loadCalendarCredential,
  type CalendarConnectionRecord,
} from './connections'
import { validateConnectionUrl } from './discovery'
import { ensureAccessToken } from './oauth'

export const PROXY_REQUEST_MAX_BYTES = 2 * 1024 * 1024
export const PROXY_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
export const PROXY_TIMEOUT_MS = 15_000
/** The JSON envelope adds escaping on top of the body itself; the byte check below is the real cap. */
export const PROXY_JSON_BODY_LIMIT = PROXY_REQUEST_MAX_BYTES * 2 + 64 * 1024
export const PROXY_BUDGET_PER_MINUTE = 120
export const PROXY_FAILURE_LIMIT = 5
export const PROXY_BREAKER_MS = 60_000

const CALDAV_METHODS = new Set(['PROPFIND', 'REPORT', 'PUT', 'DELETE'])
const OAUTH_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])

const ALLOWED_REQUEST_HEADERS = new Map<string, string>([
  ['depth', 'Depth'],
  ['content-type', 'Content-Type'],
  ['if-match', 'If-Match'],
  ['if-none-match', 'If-None-Match'],
  ['prefer', 'Prefer'],
  ['range', 'Range'],
])

const ALLOWED_RESPONSE_HEADERS = ['etag', 'content-type'] as const

export interface ProxyInput {
  method: unknown
  path: unknown
  headers: unknown
  body: unknown
}

export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  body: string
}

interface BreakerState {
  failures: number
  openUntil: number
}

const spendBudget = createMinuteBudget(
  PROXY_BUDGET_PER_MINUTE,
  'Too many calendar requests for this connection. Try again in a minute',
)

const breakers = new Map<string, BreakerState>()

/**
 * Run one request for one owned connection.
 *
 * Ownership is checked by the store query, so another account's id is a 404 before any credential is
 * read, before any budget is spent, and before any network call is made.
 */
export async function proxyCalendarRequest(
  env: Env,
  userId: string,
  connectionId: string,
  input: ProxyInput,
): Promise<ProxyResponse> {
  const connection = await getCalendarConnection(env.DB, userId, connectionId)
  if (!connection) throw ApiError.notFound('Calendar connection not found')

  const baseUrl = proxyBaseFor(connection)
  const method = proxyMethod(connection.kind, input.method)
  const target = resolveProxyUrl(baseUrl, input.path)
  const headers = proxyHeaders(input.headers)
  const body = proxyBody(method, input.body)
  if (method === 'PROPFIND' || method === 'REPORT') {
    if (body !== undefined && !hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = 'application/xml; charset=utf-8'
    }
  }

  const key = `${userId}:${connectionId}`
  spendBudget(key)
  assertBreakerOpen(key)

  const credentialKind = connection.kind === 'caldav' ? 'basic' : 'oauth'
  const ciphertext = await loadCalendarCredential(env.DB, userId, connectionId, credentialKind)
  if (!ciphertext) throw ApiError.conflict('This calendar connection has no stored credential. Reconnect it')
  const credential = await decryptCalendarCredential(env, connectionId, ciphertext)
  if (!credential) throw ApiError.conflict('This calendar connection credential could not be read. Reconnect it')

  if (connection.kind === 'caldav') {
    if (credential.kind !== 'basic') throw ApiError.conflict('This CalDAV connection needs a password')
    headers.Authorization = basicAuthorization(credential.username, credential.password)
  } else {
    if (credential.kind !== 'oauth') throw ApiError.conflict('This connection needs an OAuth authorization')
    const fresh = await ensureAccessToken(env, userId, connection, credential)
    headers.Authorization = `${fresh.tokenType || 'Bearer'} ${fresh.accessToken}`
  }

  let response: Response
  try {
    response = await fetch(target.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : body,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
  } catch (error) {
    recordFailure(key)
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApiError(502, 'internal', 'The calendar server did not answer in time')
    }
    throw new ApiError(502, 'internal', 'The calendar server could not be reached')
  }

  if (isRedirectResponse(response)) {
    recordFailure(key)
    throw new ApiError(502, 'internal', 'The calendar server redirected, and redirects are not followed')
  }
  if (response.status >= 500) recordFailure(key)
  else recordSuccess(key)

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > PROXY_RESPONSE_MAX_BYTES) {
    recordFailure(key)
    throw new ApiError(502, 'internal', 'The calendar server answered with too much data')
  }
  let text: string | null
  try {
    text = await readStreamTextWithinLimit(response.body, PROXY_RESPONSE_MAX_BYTES)
  } catch {
    recordFailure(key)
    throw new ApiError(502, 'internal', 'The calendar server response could not be read')
  }
  if (text === null) {
    recordFailure(key)
    throw new ApiError(502, 'internal', 'The calendar server answered with too much data')
  }

  const resultHeaders: Record<string, string> = {}
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value && value.length <= 2048 && !/[\r\n\0]/.test(value)) resultHeaders[name] = value
  }
  const location = response.headers.get('location')
  if (location && isSafeLocation(location, target)) resultHeaders.location = location
  return { status: response.status, headers: resultHeaders, body: text }
}

/**
 * Resolve a client path against one stored base.
 *
 * Absolute URLs and protocol-relative paths are refused before parsing. The pathname is decoded twice
 * for validation only — dot segments, encoded separators, backslashes and control characters are all
 * rejected — while the URL is built from the original spelling so an encoded `?` in a calendar id
 * stays part of the pathname. The final pathname must sit under the base, compared on segment
 * boundaries so `/calendars/alice/` cannot authorize `/calendars/alice-other/`.
 */
export function resolveProxyUrl(baseUrl: string, rawPath: unknown): URL {
  if (typeof rawPath !== 'string') throw ApiError.badRequest('A calendar request path is required')
  if (!rawPath || rawPath.length > 8192) throw ApiError.badRequest('The calendar request path is not valid')
  if (/[\u0000-\u001f\u007f]/.test(rawPath) || rawPath.includes('#')) {
    throw ApiError.badRequest('The calendar request path is not valid')
  }
  const queryIndex = rawPath.indexOf('?')
  const rawPathname = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath
  const rawQuery = queryIndex >= 0 ? rawPath.slice(queryIndex) : ''
  if (!rawPathname) throw ApiError.badRequest('The calendar request path is not valid')

  let decoded = rawPathname
  for (let round = 0; round < 2; round++) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      throw ApiError.badRequest('The calendar request path is not valid')
    }
  }
  if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw ApiError.badRequest('The calendar request path is not valid')
  }
  if (decoded.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) {
    throw ApiError.badRequest('The calendar request path must stay inside this connection')
  }
  if (/%25|%2e|%2f|%5c/i.test(decoded)) {
    throw ApiError.badRequest('The calendar request path must stay inside this connection')
  }
  // `.` and `..` are judged after decoding, so `%2e%2e` and `%252e%252e` have already become one.
  for (const segment of decoded.split('/')) {
    if (segment === '.' || segment === '..') {
      throw ApiError.badRequest('The calendar request path must stay inside this connection')
    }
  }

  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new ApiError(500, 'internal', 'This calendar connection has an invalid base address')
  }
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new ApiError(500, 'internal', 'This calendar connection has an invalid base address')
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  const relativeBase = `${base.origin}${basePath}`
  let target: URL
  try {
    target = rawPathname.startsWith('/')
      ? new URL(`${base.origin}${rawPathname}${rawQuery}`)
      : new URL(`${rawPathname}${rawQuery}`, relativeBase)
  } catch {
    throw ApiError.badRequest('The calendar request path is not valid')
  }
  if (target.protocol !== 'https:' || target.username || target.password || target.origin !== base.origin) {
    throw ApiError.badRequest('The calendar request path must stay inside this connection')
  }
  const prefix = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const inside = prefix === ''
    || target.pathname === prefix
    || target.pathname.startsWith(`${prefix}/`)
  if (!inside) throw ApiError.badRequest('The calendar request path must stay inside this connection')
  return target
}

export function proxyMethod(kind: CalendarConnectionKind, raw: unknown): string {
  const method = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  const allowed = kind === 'caldav' ? CALDAV_METHODS : OAUTH_METHODS
  if (!allowed.has(method)) throw ApiError.forbidden('That method is not allowed for this calendar connection')
  return method
}

export function proxyHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  if (raw === undefined || raw === null) return headers
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw ApiError.badRequest('Calendar request headers must be an object')
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const canonical = ALLOWED_REQUEST_HEADERS.get(name.toLowerCase())
    if (!canonical) continue
    if (typeof value !== 'string' || value.length > 1024 || /[\r\n\0]/.test(value)) {
      throw ApiError.badRequest(`The ${canonical} header is not valid`)
    }
    if (value) headers[canonical] = value
  }
  return headers
}

export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

function proxyBody(method: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw ApiError.badRequest('The calendar request body must be text')
  if (utf8ByteLength(raw) > PROXY_REQUEST_MAX_BYTES) throw ApiError.tooLarge('The calendar request body is too large')
  if (!raw) return undefined
  if (method === 'GET' || method === 'DELETE') {
    throw ApiError.badRequest('That method does not carry a calendar request body')
  }
  return raw
}

function proxyBaseFor(connection: CalendarConnectionRecord): string {
  const raw = connection.calendarHomeUrl ?? connection.baseUrl
  const url = validateConnectionUrl(raw)
  if (connection.kind === 'google' && url.origin !== new URL(GOOGLE_CALENDAR_API_BASE).origin) {
    throw new ApiError(500, 'internal', 'This Google connection has an invalid base address')
  }
  if (connection.kind === 'outlook' && url.origin !== new URL(OUTLOOK_CALENDAR_API_BASE).origin) {
    throw new ApiError(500, 'internal', 'This Outlook connection has an invalid base address')
  }
  return url.toString()
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())
}

function isSafeLocation(location: string, target: URL): boolean {
  if (location.length > 2048 || /[\r\n\0]/.test(location)) return false
  try {
    return new URL(location, target).origin === target.origin
  } catch {
    return false
  }
}

function breakerKey(key: string): BreakerState | undefined {
  return breakers.get(key)
}

function assertBreakerOpen(key: string): void {
  const state = breakerKey(key)
  if (state && state.openUntil > Date.now()) {
    throw new ApiError(503, 'internal', 'This calendar server is failing repeatedly. Try again in a minute')
  }
  if (state && state.openUntil !== 0) breakers.delete(key)
}

function recordFailure(key: string): void {
  const state = breakers.get(key) ?? { failures: 0, openUntil: 0 }
  state.failures += 1
  if (state.failures >= PROXY_FAILURE_LIMIT) {
    state.failures = 0
    state.openUntil = Date.now() + PROXY_BREAKER_MS
  }
  if (breakers.size > 512) breakers.clear()
  breakers.set(key, state)
}

function recordSuccess(key: string): void {
  breakers.delete(key)
}
