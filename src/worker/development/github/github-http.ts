import {
  GITHUB_DETAIL_TIMEOUT_MS,
  GITHUB_TIMEOUT_MS,
  MAX_GITHUB_TEXT_BYTES,
} from '@shared/development/github/limits'
import { ApiError } from '../../lib/errors'
import { readStreamTextWithinLimit } from '../../lib/request'
import { readHttpUrl } from '@shared/development/github/url'

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_USER_AGENT = 'inkstone-GitHub/1.0'

export interface GithubRateLimit {
  limit: number | null
  remaining: number | null
  reset: number | null
  resource: string | null
}

export interface GithubRequestOptions {
  token?: string | null
  method?: string
  body?: unknown
  timeoutMs?: number
  maxBytes?: number
  accept?: string
}

export interface GithubResponse<T> {
  data: T
  status: number
  rateLimit: GithubRateLimit | null
  link: string | null
  scopes: string[] | null
}

export interface GithubUser {
  login: string
  avatarUrl: string
  scopes: string[] | null
}

function readHeaderNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function readRateLimit(headers: Headers): GithubRateLimit | null {
  const limit = readHeaderNumber(headers, 'x-ratelimit-limit')
  const remaining = readHeaderNumber(headers, 'x-ratelimit-remaining')
  const reset = readHeaderNumber(headers, 'x-ratelimit-reset')
  const resource = headers.get('x-ratelimit-resource')
  if (limit === null && remaining === null && reset === null) return null
  return { limit, remaining, reset, resource: resource || null }
}

function readScopes(headers: Headers): string[] | null {
  const raw = headers.get('x-oauth-scopes')
  if (raw === null) return null
  return raw.split(',').map((scope) => scope.trim()).filter(Boolean)
}

function rateLimitDetails(rateLimit: GithubRateLimit | null): Record<string, unknown> | undefined {
  if (!rateLimit) return undefined
  const details: Record<string, unknown> = {}
  if (rateLimit.remaining !== null) details.remaining = rateLimit.remaining
  if (rateLimit.reset !== null) details.resetAt = new Date(rateLimit.reset * 1000).toISOString()
  if (rateLimit.resource) details.resource = rateLimit.resource
  return Object.keys(details).length > 0 ? details : undefined
}

async function discardBody(response: Response): Promise<void> {
  if (!response.body) return
  try {
    await response.body.cancel()
  } catch (error) {
    console.warn('[inkstone] Discarding a development github error response failed:', error)
  }
}

async function responseError(
  response: Response,
  rateLimit: GithubRateLimit | null,
): Promise<ApiError> {
  await discardBody(response)
  const status = response.status
  if (status === 401) {
    return new ApiError(400, 'github_token_invalid', 'The GitHub token is invalid or expired')
  }
  if (status === 403 || status === 429) {
    const remaining = rateLimit?.remaining ?? 0
    if (status === 429 || remaining === 0) {
      return new ApiError(
        429,
        'github_rate_limited',
        'The GitHub API rate limit has been reached',
        rateLimitDetails(rateLimit),
      )
    }
  }
  if (status === 404) {
    return new ApiError(404, 'github_not_found', 'GitHub could not find the requested resource')
  }
  return new ApiError(502, 'github_upstream', `GitHub responded with status ${status}`)
}

async function sendRequest(
  path: string,
  options: GithubRequestOptions,
): Promise<{ response: Response; rateLimit: GithubRateLimit | null }> {
  if (!path.startsWith('/') || path.includes('://')) {
    throw new Error('A GitHub request path must be absolute and relative to api.github.com')
  }
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/vnd.github+json',
    'User-Agent': GITHUB_USER_AGENT,
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? GITHUB_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApiError(502, 'github_upstream', 'GitHub did not answer in time')
    }
    throw new ApiError(502, 'github_upstream', 'GitHub could not be reached')
  }
  const rateLimit = readRateLimit(response.headers)
  if (response.status >= 300 && response.status < 400) {
    await discardBody(response)
    throw new ApiError(502, 'github_upstream', 'GitHub redirected the request, and redirects are not followed')
  }
  if (!response.ok) throw await responseError(response, rateLimit)
  return { response, rateLimit }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = readHeaderNumber(response.headers, 'content-length')
  if (declared !== null && declared > maxBytes) {
    await discardBody(response)
    throw new ApiError(502, 'github_upstream', 'GitHub answered with too much data')
  }
  let text: string | null
  try {
    text = await readStreamTextWithinLimit(response.body, maxBytes)
  } catch (error) {
    throw new ApiError(502, 'github_upstream', 'The GitHub response could not be read')
  }
  if (text === null) {
    throw new ApiError(502, 'github_upstream', 'GitHub answered with too much data')
  }
  return text
}

export async function githubJson<T>(
  path: string,
  options: GithubRequestOptions = {},
): Promise<GithubResponse<T>> {
  const { response, rateLimit } = await sendRequest(path, options)
  const scopes = readScopes(response.headers)
  if (response.status === 204) {
    return { data: null as T, status: response.status, rateLimit, link: null, scopes }
  }
  const text = await readResponseText(response, options.maxBytes ?? MAX_GITHUB_TEXT_BYTES)
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      throw new ApiError(502, 'github_upstream', 'GitHub answered with invalid JSON')
    }
  }
  return {
    data: data as T,
    status: response.status,
    rateLimit,
    link: response.headers.get('link'),
    scopes,
  }
}

export async function githubText(
  path: string,
  options: GithubRequestOptions = {},
): Promise<GithubResponse<string>> {
  const { response, rateLimit } = await sendRequest(path, options)
  const text = await readResponseText(response, options.maxBytes ?? MAX_GITHUB_TEXT_BYTES)
  return {
    data: text,
    status: response.status,
    rateLimit,
    link: response.headers.get('link'),
    scopes: readScopes(response.headers),
  }
}

export async function fetchGithubUser(token: string): Promise<GithubUser> {
  const { data, scopes } = await githubJson<Record<string, unknown>>('/user', {
    token,
    timeoutMs: GITHUB_DETAIL_TIMEOUT_MS,
  })
  const record = data && typeof data === 'object' ? data : {}
  const login = typeof record.login === 'string' ? record.login.trim() : ''
  if (!login) {
    throw new ApiError(400, 'github_token_invalid', 'GitHub did not return a username for this token')
  }
  return {
    login,
    avatarUrl: readHttpUrl(record.avatar_url, 2048),
    scopes,
  }
}
