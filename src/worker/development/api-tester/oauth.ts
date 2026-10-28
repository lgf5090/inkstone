import { Hono } from 'hono'
import { isBlockedTarget } from '@shared/ai-proxy-guard'
import { OAUTH_RATE_LIMIT } from '@shared/development/api-tester/limits'
import { OAUTH_JSON_LIMIT, OAuthTokenRequestSchema } from '@shared/development/api-tester/schemas'
import type { OAuthTokenRequest, OAuthTokenResponse } from '@shared/development/api-tester/types'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../../lib/throttle'

export const oauthRoutes = new Hono<AppBindings>()

/** OAuth token endpoints answer quickly; a hung one must not hold the Worker open. */
const OAUTH_TIMEOUT_MS = 15_000

/**
 * The token endpoint this exchange may call.
 *
 * The URL comes from the request, so it is judged like any relay target: only http(s), no embedded
 * credentials, and no literal private or internal address. The platform's public-fetch rule is the
 * hard boundary underneath, but refusing the obvious cases here keeps the error intelligible.
 */
function assertTokenTarget(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
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

function parseTokenRequest(raw: unknown): OAuthTokenRequest {
  const result = OAuthTokenRequestSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'body'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return result.data
}

/** The form OAuth 2.0 says a token endpoint receives, with only the fields this grant needs. */
function tokenForm(input: OAuthTokenRequest): URLSearchParams {
  const grantType = input.grantType ?? 'authorization_code'
  const form = new URLSearchParams()
  form.set('grant_type', grantType)
  if (grantType === 'authorization_code') {
    setIfPresent(form, 'code', input.code)
    setIfPresent(form, 'redirect_uri', input.redirectUri)
  } else {
    setIfPresent(form, 'refresh_token', input.refreshToken)
  }
  setIfPresent(form, 'client_id', input.clientId)
  setIfPresent(form, 'client_secret', input.clientSecret)
  return form
}

function setIfPresent(form: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) form.set(key, value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * The token response in the shape the client expects.
 *
 * OAuth's wire names are snake_case while the API talks camelCase, so the values are translated —
 * never reinterpreted. An upstream `error`/`error_description` keeps its exact text, because the
 * reader needs the provider's own words to fix the grant.
 */
function tokenResponse(record: Record<string, unknown>, status: number): OAuthTokenResponse {
  const response: OAuthTokenResponse = {}
  const accessToken = stringField(record, 'access_token')
  const refreshToken = stringField(record, 'refresh_token')
  const tokenType = stringField(record, 'token_type')
  const scope = stringField(record, 'scope')
  const error = stringField(record, 'error')
  const errorDescription = stringField(record, 'error_description')
  if (accessToken !== undefined) response.accessToken = accessToken
  if (refreshToken !== undefined) response.refreshToken = refreshToken
  if (tokenType !== undefined) response.tokenType = tokenType
  if (scope !== undefined) response.scope = scope
  if (error !== undefined) response.error = error
  if (errorDescription !== undefined) response.errorDescription = errorDescription

  const expiresIn = record.expires_in
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    response.expiresIn = expiresIn
  } else if (typeof expiresIn === 'string' && /^\d+$/.test(expiresIn)) {
    response.expiresIn = Number(expiresIn)
  }

  if (response.accessToken === undefined && response.error === undefined) {
    response.error = `The token endpoint did not return an access token (HTTP ${status})`
  }
  return response
}

oauthRoutes.post('/oauth2/token', async (c) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()

  await assertAttemptBudget(
    () =>
      consumeAttemptBudget(c.env.DB, [
        { key: `apitester-oauth:${userId}`, ...OAUTH_RATE_LIMIT },
      ]),
    'Too many OAuth token exchanges',
  )

  const input = parseTokenRequest(await readJson<unknown>(c, OAUTH_JSON_LIMIT))
  const target = assertTokenTarget(input.tokenUrl)

  let response: Response
  try {
    response = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenForm(input).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    const failure = timedOut ? 'request_timeout' : 'upstream_unreachable'
    console.warn('[inkstone] API tester OAuth token exchange failed:', failure, target.hostname)
    if (timedOut) {
      throw new ApiError(502, 'apitester_request_timeout', 'The token endpoint did not answer in time')
    }
    throw new ApiError(502, 'apitester_upstream_unreachable', 'The token endpoint could not be reached')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    // A provider that answers HTML or an empty body still gets an envelope the client can show;
    // the body itself is not repeated here because an error page can echo credentials.
    console.warn('[inkstone] API tester OAuth token endpoint returned non-JSON:', target.hostname, response.status)
    return c.json<OAuthTokenResponse>({
      error: `The token endpoint returned a non-JSON response (HTTP ${response.status})`,
    })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    console.warn('[inkstone] API tester OAuth token endpoint returned a non-object:', target.hostname, response.status)
    return c.json<OAuthTokenResponse>({
      error: `The token endpoint returned an invalid response (HTTP ${response.status})`,
    })
  }
  return c.json(tokenResponse(payload as Record<string, unknown>, response.status))
})
