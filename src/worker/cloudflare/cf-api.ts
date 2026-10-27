/**
 * The one door to api.cloudflare.com.
 *
 * The reference module used the Cloudflare Node SDK in one generation and `cfFetch` in the next. A
 * Worker cannot use the SDK's Node transport (and does not need to): every call here is `fetch` with
 * the account's own headers, which is also what makes the module testable — a route test stubs one
 * origin.
 *
 * Errors keep the upstream status and body. A route decides how much of that to show; the words are
 * Cloudflare's own, and the routes never invent a status the API did not send.
 */
import { ApiError } from '../lib/errors'

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

const CF_TIMEOUT_MS = 20_000
const MAX_PAGES = 20
const MAX_ERROR_BODY = 400

export interface CloudflareApiErrorInit {
  status: number
  body: string
  cfCode?: number
}

export class CloudflareApiError extends Error {
  readonly status: number
  readonly body: string
  readonly cfCode?: number

  constructor({ status, body, cfCode }: CloudflareApiErrorInit) {
    super(describeCloudflareError(status, body))
    this.name = 'CloudflareApiError'
    this.status = status
    this.body = body
    this.cfCode = cfCode
  }
}

/** The account fields a request needs; credentials are decrypted per call, never cached. */
export interface CloudflareAuth {
  auth_type: 'token' | 'global_key'
  api_token?: string | null
  api_key?: string | null
  email?: string | null
}

export function authHeaders(auth: CloudflareAuth): Record<string, string> {
  if (auth.auth_type === 'token') {
    if (!auth.api_token) throw new ApiError(400, 'cloudflare_not_configured', 'This account has no API token')
    return { Authorization: `Bearer ${auth.api_token}` }
  }
  if (!auth.api_key || !auth.email) {
    throw new ApiError(400, 'cloudflare_not_configured', 'This account has no API key and email')
  }
  return { 'X-Auth-Email': auth.email, 'X-Auth-Key': auth.api_key }
}

export interface CfRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  /** Overrides the default 20s; the batch operations and CSV import ask for more. */
  timeoutMs?: number
  signal?: AbortSignal
}

async function send(auth: CloudflareAuth, path: string, init: CfRequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? CF_TIMEOUT_MS)
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason)
    else init.signal.addEventListener('abort', () => controller.abort(init.signal?.reason), { once: true })
  }
  try {
    return await fetch(`${CF_API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(auth),
        ...(init.headers ?? {}),
      },
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
      signal: controller.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not answer in time')
    }
    throw new ApiError(
      502,
      'cloudflare_upstream',
      `Cloudflare could not be reached: ${(error as Error)?.message ?? 'network error'}`,
    )
  } finally {
    clearTimeout(timeout)
  }
}

/** A JSON call. Non-2xx is an error, and the upstream's own message is what the error carries. */
export async function cfFetch<T>(auth: CloudflareAuth, path: string, init: CfRequestInit = {}): Promise<T> {
  const response = await send(auth, path, init)
  const text = await response.text()
  if (!response.ok) throw toApiError(response.status, text)
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare answered with something that is not JSON')
  }
}

/** A raw response, for multipart uploads, streamed downloads and anything the caller parses itself. */
export async function cfFetchRaw(
  auth: CloudflareAuth,
  path: string,
  init: CfRequestInit = {},
): Promise<Response> {
  return await send(auth, path, init)
}

/**
 * Every page of a list endpoint.
 *
 * `MAX_PAGES` is a guard, not a feature: a listing that answers "more pages" forever would otherwise
 * hold a request open until the Worker is killed. Twenty pages at 50 rows is 1,000 rows, which is
 * already more than the screens show at once.
 */
export interface CfListResult<T> {
  items: T[]
  /** True when the page cap stopped the walk with pages left: the listing is not the whole set. */
  truncated: boolean
}

export async function cfFetchAllDetailed<T>(
  auth: CloudflareAuth,
  path: string,
  perPage = 50,
): Promise<CfListResult<T>> {
  const all: T[] = []
  let page = 0
  let totalPages = 1
  for (; page < MAX_PAGES; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const body = await cfFetch<{
      result?: T[] | null
      result_info?: { total_pages?: number }
    }>(auth, `${path}${separator}page=${page + 1}&per_page=${perPage}`)
    const items = body.result ?? []
    all.push(...items)
    totalPages = body.result_info?.total_pages ?? 1
    if (items.length === 0 || page + 1 >= totalPages) break
  }
  return { items: all, truncated: page + 1 < totalPages }
}

export async function cfFetchAll<T>(
  auth: CloudflareAuth,
  path: string,
  perPage = 50,
): Promise<T[]> {
  return (await cfFetchAllDetailed<T>(auth, path, perPage)).items
}

/** The GraphQL door. Cloudflare reports query problems in a 200 body, so both shapes are checked. */
export async function cfGraphQL<T>(
  auth: CloudflareAuth,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await send(auth, '/graphql', {
    method: 'POST',
    body: { query, variables },
    timeoutMs: 30_000,
  })
  const text = await response.text()
  if (!response.ok) throw toApiError(response.status, text)
  let payload: { errors?: Array<{ message?: string }>; data?: T }
  try {
    payload = JSON.parse(text) as { errors?: Array<{ message?: string }>; data?: T }
  } catch {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare answered the query with something that is not JSON')
  }
  if (payload.errors?.length) {
    throw new ApiError(
      502,
      'cloudflare_upstream',
      payload.errors[0]?.message ?? 'Cloudflare refused the analytics query',
    )
  }
  if (!payload.data) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare answered the query without data')
  return payload.data
}

/** The error a route rethrows when an operation relied on Cloudflare and the call did not land. */
export function upstreamApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof CloudflareApiError) {
    return new ApiError(error.status === 429 ? 429 : 502, 'cloudflare_upstream', error.message)
  }
  return new ApiError(
    502,
    'cloudflare_upstream',
    error instanceof Error ? error.message : 'Cloudflare request failed',
  )
}

function toApiError(status: number, body: string): ApiError {
  return upstreamApiError(new CloudflareApiError({ status, body, cfCode: readCode(body) }))
}

function readCode(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: number }> }
    const code = parsed.errors?.[0]?.code
    return typeof code === 'number' ? code : undefined
  } catch {
    return undefined
  }
}

function describeCloudflareError(status: number, body: string): string {
  const message = readMessage(body)
  if (message) return message
  const trimmed = body.trim()
  if (!trimmed) return `Cloudflare answered HTTP ${status}`
  return trimmed.slice(0, MAX_ERROR_BODY)
}

function readMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: string }>
      error?: { message?: string }
      message?: string
    }
    return parsed.errors?.[0]?.message ?? parsed.error?.message ?? parsed.message
  } catch {
    return undefined
  }
}
