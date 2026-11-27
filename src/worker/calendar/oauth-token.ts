import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { readStreamTextWithinLimit } from '../lib/request'

export type CalendarOAuthProvider = 'google' | 'outlook'

const OAUTH_TIMEOUT_MS = 10_000
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 7000
const MAX_SCOPE_LENGTH = 1024
const MAX_TOKEN_TYPE_LENGTH = 64
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 60
const MAX_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60

export const CALENDAR_OAUTH_TOKEN_URLS: Record<CalendarOAuthProvider, string> = {
  google: 'https://oauth2.googleapis.com/token',
  outlook: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
}

export interface CalendarTokenRefreshInput {
  provider: CalendarOAuthProvider
  clientId: string
  clientSecret: string
  refreshToken: string
  scope?: string
}

export interface RefreshedCalendarTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  tokenType?: string
}

export type CalendarTokenRefreshResult =
  | { ok: true; tokens: RefreshedCalendarTokens }
  | { ok: false; reason: 'authorization_expired' | 'provider_unavailable' }

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  token_type?: unknown
}

/** Execute one provider refresh inside the credential vault's single-flight coordinator. */
export async function refreshCalendarOAuthToken(
  input: CalendarTokenRefreshInput,
): Promise<CalendarTokenRefreshResult> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  })
  if (input.provider === 'outlook' && input.scope) form.set('scope', input.scope)

  let response: Response
  try {
    response = await fetch(CALENDAR_OAUTH_TOKEN_URLS[input.provider], {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
    if (isRedirectResponse(response)) return { ok: false, reason: 'provider_unavailable' }
  } catch {
    // A network failure says nothing about the grant; the caller must leave the connection usable.
    return { ok: false, reason: 'provider_unavailable' }
  }

  if (!response.ok) {
    console.warn('[inkstone] Calendar token refresh refused', { provider: input.provider, status: response.status })
    return response.status === 429 || response.status >= 500
      ? { ok: false, reason: 'provider_unavailable' }
      : { ok: false, reason: 'authorization_expired' }
  }

  let text: string | null
  try {
    text = await readStreamTextWithinLimit(response.body, MAX_TOKEN_RESPONSE_BYTES)
  } catch {
    return { ok: false, reason: 'provider_unavailable' }
  }
  if (text === null) return { ok: false, reason: 'provider_unavailable' }
  let body: TokenResponse
  try {
    body = JSON.parse(text) as TokenResponse
  } catch {
    return { ok: false, reason: 'provider_unavailable' }
  }
  const accessToken = readToken(body.access_token, MAX_TOKEN_LENGTH)
  const refreshToken = readToken(body.refresh_token, MAX_TOKEN_LENGTH)
  const scope = readToken(body.scope, MAX_SCOPE_LENGTH)
  const tokenType = readToken(body.token_type, MAX_TOKEN_TYPE_LENGTH)
  if (!accessToken) return { ok: false, reason: 'provider_unavailable' }
  return {
    ok: true,
    tokens: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: expiresAtFrom(body.expires_in),
      ...(scope ? { scope } : {}),
      ...(tokenType ? { tokenType } : {}),
    },
  }
}

function expiresAtFrom(seconds: unknown): number {
  const value = Number(seconds)
  const lifetime = Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TOKEN_LIFETIME_SECONDS)
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
