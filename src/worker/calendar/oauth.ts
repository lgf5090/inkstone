/**
 * Google and Outlook authorization-code sign-in with PKCE.
 *
 * The browser leaves for the provider and comes back to one fixed callback. Nothing secret travels in
 * either direction's URL: the state is random, D1 stores only its SHA-256, the PKCE verifier is sealed
 * in the vault under that hash, and the tokens land in the credential column and nowhere else.
 *
 * The callback is a top-level browser navigation, so it is registered before `requireAuth` and relies
 * on the session loader that already ran. It consumes the state row atomically with `UPDATE … RETURNING`
 * before the code exchange, which is what makes a replay fail even when two requests race.
 */
import type { Env } from '../env'
import {
  decryptCalendarCredential,
  decryptCalendarOAuthVerifier,
  encryptCalendarCredential,
  encryptCalendarOAuthVerifier,
  type CalendarCredentialPayload,
} from '../lib/crypto'
import { sha256Hex, toBase64Url } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { readStreamTextWithinLimit } from '../lib/request'
import {
  GOOGLE_CALENDAR_API_BASE,
  OUTLOOK_CALENDAR_API_BASE,
  createCalendarConnection,
  loadCalendarCredential,
  saveCalendarCredential,
  updateCalendarConnectionStatus,
  type CalendarConnectionRecord,
} from './connections'

export type CalendarOAuthProvider = 'google' | 'outlook'

export const CALENDAR_OAUTH_PROVIDERS = ['google', 'outlook'] as const

const OAUTH_TIMEOUT_MS = 10_000
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const STATE_TTL_MS = 10 * 60 * 1000
const REFRESH_SKEW_MS = 60 * 1000
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 60

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const OUTLOOK_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const OUTLOOK_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

const GOOGLE_SCOPES = {
  read: 'https://www.googleapis.com/auth/calendar.readonly',
  write: 'https://www.googleapis.com/auth/calendar',
} as const

const OUTLOOK_SCOPES = {
  read: 'https://graph.microsoft.com/Calendars.Read offline_access',
  write: 'https://graph.microsoft.com/Calendars.ReadWrite offline_access',
} as const

const CALLBACK_PATH = '/api/calendar/oauth/callback'

export type CalendarOAuthCredential = Extract<CalendarCredentialPayload, { kind: 'oauth' }>

const refreshFlights = new Map<string, Promise<CalendarOAuthCredential>>()

interface ProviderSettings {
  provider: CalendarOAuthProvider
  clientId: string
  clientSecret: string
  authorizeUrl: string
  tokenUrl: string
  apiBase: string
  label: string
}

interface OAuthStateRow {
  provider: string
  verifier_ciphertext: string
  redirect_to: string
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  token_type?: unknown
}

export interface StartOAuthInput {
  provider: CalendarOAuthProvider
  writable: boolean
  redirectTo?: unknown
  origin: string
}

export interface CompleteOAuthInput {
  code: unknown
  state: unknown
  origin: string
}

export interface CompletedOAuth {
  connectionId: string
  redirectTo: string
}

export function isCalendarOAuthProvider(value: unknown): value is CalendarOAuthProvider {
  return typeof value === 'string' && (CALENDAR_OAUTH_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Start a sign-in: create the state row, then answer the provider URL the browser should visit.
 *
 * `redirect_to` is an internal path only. It is validated here rather than at the callback so a
 * caller cannot even mint a state aimed at another origin, and it is validated again when read back.
 */
export async function startOAuth(
  env: Env,
  userId: string,
  input: StartOAuthInput,
): Promise<{ url: string }> {
  if (!isValidId(userId)) throw ApiError.unauthenticated()
  if (!isCalendarOAuthProvider(input.provider)) throw ApiError.badRequest('Unknown calendar provider')
  const settings = providerSettings(env, input.provider)
  const redirectTo = input.redirectTo === undefined ? '/calendar' : assertInternalRedirect(input.redirectTo)
  const redirectUri = callbackUrl(env, input.origin)

  const state = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const stateHash = await sha256Hex(state)
  const challenge = await pkceChallenge(verifier)
  const verifierCiphertext = await encryptCalendarOAuthVerifier(env, stateHash, verifier)
  const now = Date.now()

  // Expired and already-used rows have no further use; clearing this reader's own rows keeps the
  // table bounded without a cron and cannot touch anybody else's pending sign-in.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM calendar_oauth_states
        WHERE user_id = ?1 AND (expires_at <= ?2 OR used_at IS NOT NULL)`,
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO calendar_oauth_states
        (user_id, state_hash, provider, verifier_ciphertext, redirect_to, expires_at, used_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
    ).bind(userId, stateHash, input.provider, verifierCiphertext, redirectTo, now + STATE_TTL_MS, now),
  ])

  const url = new URL(settings.authorizeUrl)
  url.searchParams.set('client_id', settings.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', scopeFor(settings.provider, input.writable))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (settings.provider === 'google') {
    // Without both of these Google returns an access token but no refresh token on a repeat consent,
    // which would make the connection silently die an hour after it was created.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('include_granted_scopes', 'true')
  } else {
    url.searchParams.set('response_mode', 'query')
  }
  return { url: url.toString() }
}

/**
 * Finish a sign-in.
 *
 * The state row is consumed before the code is exchanged, so a replayed callback cannot spend the
 * same verifier twice. The returned redirect is an internal path; tokens never appear in it.
 */
export async function completeOAuth(
  env: Env,
  userId: string,
  input: CompleteOAuthInput,
): Promise<CompletedOAuth> {
  if (!isValidId(userId)) throw ApiError.unauthenticated()
  const state = typeof input.state === 'string' ? input.state : ''
  const code = typeof input.code === 'string' ? input.code : ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw ApiError.badRequest('The sign-in response is not valid')
  }
  if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw ApiError.badRequest('The sign-in response is not valid')
  }
  const stateHash = await sha256Hex(state)
  const now = Date.now()
  const row = await env.DB.prepare(
    `UPDATE calendar_oauth_states
        SET used_at = ?1
      WHERE user_id = ?2 AND state_hash = ?3 AND used_at IS NULL AND expires_at > ?1
      RETURNING provider, verifier_ciphertext, redirect_to`,
  ).bind(now, userId, stateHash).first<OAuthStateRow>()
  if (!row) throw ApiError.badRequest('This sign-in link is invalid or has expired')
  if (!isCalendarOAuthProvider(row.provider)) {
    throw new ApiError(500, 'internal', 'The stored calendar sign-in names an unknown provider')
  }
  const settings = providerSettings(env, row.provider)
  const verifier = await decryptCalendarOAuthVerifier(env, stateHash, row.verifier_ciphertext)
  if (!verifier) throw new ApiError(500, 'internal', 'The stored calendar sign-in could not be read')

  const tokens = await exchangeCode(
    settings,
    code,
    verifier,
    callbackUrl(env, input.origin),
  )
  const connectionId = newId()
  const credential: CalendarOAuthCredential = {
    kind: 'oauth',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    tokenType: tokens.tokenType,
  }
  const ciphertext = await encryptCalendarCredential(env, connectionId, credential)
  // The granted scope is the truth: a provider may downgrade a write request, and a connection that
  // reported write after that would let the adapter try writes the token cannot perform.
  const writable = grantsWriteScope(settings.provider, tokens.scope)
  await createCalendarConnection(env.DB, userId, {
    id: connectionId,
    kind: settings.provider,
    label: settings.label,
    baseUrl: settings.apiBase,
    calendarHomeUrl: settings.apiBase,
    username: null,
    scope: writable ? 'write' : 'read',
    writable,
    credential: { kind: 'oauth', ciphertext },
  })
  return { connectionId, redirectTo: safeInternalPath(row.redirect_to) }
}

/**
 * A usable access token, refreshed shortly before it expires.
 *
 * The new bundle is sealed and written back before the caller uses it, so a refresh is not repeated by
 * every request in the last minute of a token's life. Only a refused grant marks the connection
 * `expired`; a network or provider outage stays connected so the next request can retry.
 */
export async function ensureAccessToken(
  env: Env,
  userId: string,
  connection: CalendarConnectionRecord,
  credential: CalendarOAuthCredential,
): Promise<CalendarOAuthCredential> {
  if (credential.kind !== 'oauth') throw new Error('calendar_credential_is_not_oauth')
  if (credential.expiresAt > Date.now() + REFRESH_SKEW_MS) return credential
  if (credential.refreshToken.length === 0) {
    await markExpired(env, userId, connection.id)
    throw reconnectError()
  }
  if (!isCalendarOAuthProvider(connection.kind)) {
    throw new ApiError(500, 'internal', 'An OAuth credential belongs to an unknown provider')
  }
  const key = `${userId}:${connection.id}`
  const existing = refreshFlights.get(key)
  if (existing) return existing
  const flight = refreshAccessToken(env, userId, connection, credential)
  refreshFlights.set(key, flight)
  try {
    return await flight
  } finally {
    if (refreshFlights.get(key) === flight) refreshFlights.delete(key)
  }
}

async function refreshAccessToken(
  env: Env,
  userId: string,
  connection: CalendarConnectionRecord,
  credential: CalendarOAuthCredential,
): Promise<CalendarOAuthCredential> {
  if (!isCalendarOAuthProvider(connection.kind)) {
    throw new ApiError(500, 'internal', 'An OAuth credential belongs to an unknown provider')
  }
  const settings = providerSettings(env, connection.kind)
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    refresh_token: credential.refreshToken,
  })
  if (settings.provider === 'outlook' && credential.scope) form.set('scope', credential.scope)
  let response: Response
  try {
    response = await tokenRequest(settings.tokenUrl, form, connection.kind)
  } catch {
    // A network failure says nothing about the grant; marking expired would force a re-login for an
    // outage the reader cannot fix.
    throw new ApiError(502, 'internal', 'The calendar provider could not be reached')
  }
  if (!response.ok) {
    console.warn('[inkstone] Calendar token refresh refused', { provider: connection.kind, status: response.status })
    if (response.status === 429 || response.status >= 500) {
      throw new ApiError(502, 'internal', 'The calendar provider is temporarily unavailable')
    }
    await markExpired(env, userId, connection.id)
    throw reconnectError()
  }
  const text = await readStreamTextWithinLimit(response.body, MAX_TOKEN_RESPONSE_BYTES)
  if (text === null) {
    throw new ApiError(502, 'internal', 'The calendar provider answered with too much data')
  }
  let body: TokenResponse
  try {
    body = JSON.parse(text) as TokenResponse
  } catch {
    throw new ApiError(502, 'internal', 'The calendar provider answered with an unreadable token response')
  }
  const accessToken = readToken(body.access_token, 7000)
  if (!accessToken) {
    throw new ApiError(502, 'internal', 'The calendar provider answered without an access token')
  }
  const next: CalendarOAuthCredential = {
    kind: 'oauth',
    accessToken,
    refreshToken: readToken(body.refresh_token, 7000) ?? credential.refreshToken,
    expiresAt: expiresAtFrom(body.expires_in),
    scope: readToken(body.scope, 1024) ?? credential.scope,
    tokenType: readToken(body.token_type, 64) ?? credential.tokenType,
  }
  const ciphertext = await encryptCalendarCredential(env, connection.id, next)
  await saveCalendarCredential(env.DB, userId, connection.id, 'oauth', ciphertext)
  await updateCalendarConnectionStatus(env.DB, userId, connection.id, {
    status: 'connected',
    errorCode: null,
  })
  return next
}

/**
 * Best-effort revocation before a local delete.
 *
 * Google has an endpoint; Microsoft's v2 endpoint does not, so the local row is the only thing this
 * app can remove and the operator note says so. A failed call is logged and swallowed because the
 * reader asked for the connection to be gone, not for a remote call to succeed first.
 */
export async function revokeCalendarConnection(
  env: Env,
  userId: string,
  connection: CalendarConnectionRecord,
): Promise<void> {
  if (connection.kind !== 'google') {
    if (connection.kind === 'outlook') {
      console.info('[inkstone] Calendar connection removed locally; revoke the app in the Microsoft account to remove the remote grant')
    }
    return
  }
  let ciphertext: string | null
  try {
    ciphertext = await loadCalendarCredential(env.DB, userId, connection.id, 'oauth')
  } catch (error) {
    console.warn('[inkstone] Calendar credential lookup failed during revoke:', error instanceof Error ? error.name : 'unknown')
    return
  }
  if (!ciphertext) return
  let credential: CalendarCredentialPayload | null
  try {
    credential = await decryptCalendarCredential(env, connection.id, ciphertext)
  } catch (error) {
    // The vault is unavailable; local deletion still proceeds and the remote grant is reported only
    // in this low-level line, never as a reason to keep the connection.
    console.warn('[inkstone] Calendar credential could not be read during revoke:', error instanceof Error ? error.name : 'unknown')
    return
  }
  if (!credential || credential.kind !== 'oauth') return
  const token = credential.refreshToken || credential.accessToken
  if (!token) return
  try {
    const response = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
    // 400 means the token was already invalid, which is the outcome revocation wanted.
    if (!response.ok && response.status !== 400) {
      console.warn('[inkstone] Calendar token revoke was refused', { provider: 'google', status: response.status })
    }
  } catch (error) {
    console.warn('[inkstone] Calendar token revoke could not be reached:', error instanceof Error ? error.name : 'unknown')
  }
}

// ---------------------------------------------------------------------------- configuration

function providerSettings(env: Env, provider: CalendarOAuthProvider): ProviderSettings {
  if (provider === 'google') {
    const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? ''
    const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? ''
    if (!clientId || !clientSecret) {
      throw new ApiError(503, 'server_misconfigured', 'Google Calendar sign-in is not configured on this deployment')
    }
    return {
      provider,
      clientId,
      clientSecret,
      authorizeUrl: GOOGLE_AUTHORIZE_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
      apiBase: GOOGLE_CALENDAR_API_BASE,
      label: 'Google Calendar',
    }
  }
  const clientId = env.OUTLOOK_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.OUTLOOK_CLIENT_SECRET?.trim() ?? ''
  if (!clientId || !clientSecret) {
    throw new ApiError(503, 'server_misconfigured', 'Outlook Calendar sign-in is not configured on this deployment')
  }
  return {
    provider,
    clientId,
    clientSecret,
    authorizeUrl: OUTLOOK_AUTHORIZE_URL,
    tokenUrl: OUTLOOK_TOKEN_URL,
    apiBase: OUTLOOK_CALENDAR_API_BASE,
    label: 'Outlook Calendar',
  }
}

function scopeFor(provider: CalendarOAuthProvider, writable: boolean): string {
  if (provider === 'google') return writable ? GOOGLE_SCOPES.write : GOOGLE_SCOPES.read
  return writable ? OUTLOOK_SCOPES.write : OUTLOOK_SCOPES.read
}

/**
 * Whether the granted scope string contains the provider's write scope.
 *
 * Microsoft has been known to answer with the short `Calendars.ReadWrite` rather than the full URI
 * that was requested, so both spellings count. Google's scope is a URI in both directions.
 */
function grantsWriteScope(provider: CalendarOAuthProvider, scope: string): boolean {
  if (provider === 'google') return scope.split(/\s+/).includes(GOOGLE_SCOPES.write)
  return /(^|\s)(?:https:\/\/graph\.microsoft\.com\/)?Calendars\.ReadWrite(?:\s|$)/i.test(scope)
}

function isLocalCallbackHost(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

function callbackUrl(env: Env, origin: string): string {
  const configured = env.CALENDAR_OAUTH_REDIRECT_BASE?.trim()
  if (configured) {
    let base: URL
    try {
      base = new URL(configured)
    } catch {
      throw new ApiError(503, 'server_misconfigured', 'CALENDAR_OAUTH_REDIRECT_BASE is not a valid URL')
    }
    if (base.username || base.password
      || !(base.protocol === 'https:' || (base.protocol === 'http:' && isLocalCallbackHost(base)))) {
      throw new ApiError(503, 'server_misconfigured', 'CALENDAR_OAUTH_REDIRECT_BASE must be https (http is allowed only on localhost)')
    }
    return `${base.origin}${CALLBACK_PATH}`
  }
  let requestOrigin: URL
  try {
    requestOrigin = new URL(origin)
  } catch {
    throw ApiError.badRequest('The request origin could not be read')
  }
  if (!(requestOrigin.protocol === 'https:'
    || (requestOrigin.protocol === 'http:' && isLocalCallbackHost(requestOrigin)))) {
    throw ApiError.badRequest('The request origin could not be read')
  }
  return `${requestOrigin.origin}${CALLBACK_PATH}`
}

// ---------------------------------------------------------------------------- token exchange

interface ExchangedTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
  tokenType?: string
}

async function exchangeCode(
  settings: ProviderSettings,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<ExchangedTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  const response = await tokenRequest(settings.tokenUrl, form, settings.provider)
  if (!response.ok) {
    console.warn('[inkstone] Calendar authorization code was refused', { provider: settings.provider, status: response.status })
    throw new ApiError(502, 'internal', 'The calendar provider refused the sign-in')
  }
  const text = await readStreamTextWithinLimit(response.body, MAX_TOKEN_RESPONSE_BYTES)
  if (text === null) {
    throw new ApiError(502, 'internal', 'The calendar provider answered with too much data')
  }
  let body: TokenResponse
  try {
    body = JSON.parse(text) as TokenResponse
  } catch {
    throw new ApiError(502, 'internal', 'The calendar provider answered with an unreadable token response')
  }
  const accessToken = readToken(body.access_token, 7000)
  if (!accessToken) {
    throw new ApiError(502, 'internal', 'The calendar provider answered without an access token')
  }
  return {
    accessToken,
    refreshToken: readToken(body.refresh_token, 7000) ?? '',
    expiresAt: expiresAtFrom(body.expires_in),
    scope: readToken(body.scope, 1024) ?? '',
    tokenType: readToken(body.token_type, 64) ?? 'Bearer',
  }
}

async function tokenRequest(
  tokenUrl: string,
  form: URLSearchParams,
  provider: CalendarOAuthProvider,
): Promise<Response> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
    if (isRedirectResponse(response)) {
      throw new ApiError(502, 'internal', 'The calendar provider redirected the token request')
    }
    return response
  } catch (error) {
    if (error instanceof ApiError) throw error
    const name = error instanceof Error ? error.name : ''
    console.warn('[inkstone] Calendar token request failed', { provider, reason: name || 'network' })
    throw new ApiError(502, 'internal', 'The calendar provider could not be reached')
  }
}

function expiresAtFrom(seconds: unknown): number {
  const value = Number(seconds)
  const lifetime = Number.isFinite(value) && value > 0
    ? Math.min(value, 30 * 24 * 60 * 60)
    : DEFAULT_TOKEN_LIFETIME_SECONDS
  return Date.now() + lifetime * 1000
}

function readToken(value: unknown, max: number): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier) as BufferSource)
  return toBase64Url(new Uint8Array(digest))
}

async function markExpired(env: Env, userId: string, connectionId: string): Promise<void> {
  await updateCalendarConnectionStatus(env.DB, userId, connectionId, {
    status: 'expired',
    errorCode: 'authorization_expired',
  })
}

function reconnectError(): ApiError {
  return new ApiError(502, 'internal', 'The calendar authorization has expired. Reconnect this account')
}

// ---------------------------------------------------------------------------- redirects

/**
 * An internal path, or a refusal.
 *
 * The check runs before the state row is written and again after it is read. `//host` and a backslash
 * are browsers' favourite ways to turn a path into another origin, so both are refused rather than
 * normalized.
 */
export function assertInternalRedirect(value: unknown): string {
  const path = safeInternalPath(value)
  if (path === '/calendar' && value !== '/calendar') {
    throw ApiError.badRequest('The calendar return address must be an internal path')
  }
  return path
}

export function safeInternalPath(value: unknown): string {
  if (typeof value !== 'string') return '/calendar'
  const path = value.trim()
  if (path.length === 0 || path.length > 512) return '/calendar'
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/calendar'
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return '/calendar'
  // Encoded separators are the same attack in a different spelling: a browser may turn `%5c` or
  // `%2f%2f` back into a path that leaves this origin before it sends the request.
  let decoded = path
  for (let round = 0; round < 2; round++) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      return '/calendar'
    }
  }
  if (decoded.startsWith('//') || decoded.startsWith('/\\') || decoded.includes('\\')) return '/calendar'
  if (/[\u0000-\u001f\u007f]/.test(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded.slice(1))) {
    return '/calendar'
  }
  if (/%25|%2e|%2f|%5c/i.test(decoded)) return '/calendar'
  try {
    const url = new URL(path, 'https://calendar.invalid')
    if (url.origin !== 'https://calendar.invalid') return '/calendar'
    return `${url.pathname}${url.search}`
  } catch {
    return '/calendar'
  }
}
