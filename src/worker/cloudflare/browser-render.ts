/**
 * Browser Rendering: one page, one mode, one account's allowance.
 *
 * Cloudflare allows a small amount of browser time per account per day, so the service has to choose
 * an account, keep a short cool-down between renders (ten seconds, so a burst does not burn the day),
 * and hand the work to another account when one is out. The reference module kept a token bucket in
 * memory and a timer to reset it at UTC midnight; a Worker has no reliable timer across requests, so
 * "exhausted" here is stored with the day it belongs to and simply stops applying the next day.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { accountHasFeature, loadActiveAccounts, loadAccount, type CloudflareAccountRow } from './accounts'
import { cfFetchRaw } from './cf-api'
import { incrementQuota, setExhausted } from './quota'
import { utcDay } from './usage'

export const RENDER_MODES = ['screenshot', 'content', 'markdown', 'pdf', 'links'] as const
export type RenderMode = typeof RENDER_MODES[number]

export const RENDER_BROWSERS = ['chrome', 'kitesurf'] as const
export type RenderBrowser = typeof RENDER_BROWSERS[number]

export interface RenderResult {
  mode: RenderMode
  duration: number
  browserMsUsed: number
  screenshot?: string
  pdf?: string
  html?: string
  markdown?: string
  links?: unknown
}

export interface RenderInput {
  url: string
  mode: RenderMode
  browser: RenderBrowser
  accountId?: string
}

const TOKEN_INTERVAL_MS = 10_000
const DAILY_LIMIT_RETRY_AFTER_SECONDS = 60

interface Bucket {
  lastUsedAt: number
  /** The UTC day the account ran out on; a different day means the flag no longer applies. */
  exhaustedOn: string | null
}

const buckets = new Map<string, Bucket>()

/** Forget every cool-down and exhaustion flag. Called by the module's cache-clear action. */
export function resetRenderState(): void {
  buckets.clear()
}

function bucketFor(accountId: string): Bucket {
  let bucket = buckets.get(accountId)
  if (!bucket) {
    bucket = { lastUsedAt: 0, exhaustedOn: null }
    buckets.set(accountId, bucket)
  }
  return bucket
}

function isExhausted(accountId: string): boolean {
  return bucketFor(accountId).exhaustedOn === utcDay()
}

function markExhausted(accountId: string): void {
  bucketFor(accountId).exhaustedOn = utcDay()
}

export interface RenderUsageEntry {
  row: CloudflareAccountRow
  auth: Awaited<ReturnType<typeof loadAccount>>['auth']
}

type Acquire =
  | { kind: 'ok'; account: RenderUsageEntry }
  | { kind: 'cooling'; waitMs: number }
  | { kind: 'exhausted' }

async function acquireAccount(env: Env, userId: string): Promise<Acquire> {
  const candidates = (await loadActiveAccounts(env, userId))
    .filter(({ row }) => row.cf_account_id && accountHasFeature(row, 'browser_render') && row.is_active === 1)
  const now = Date.now()
  let shortestWait = Number.POSITIVE_INFINITY
  let anyAvailable = false
  for (const candidate of candidates) {
    if (isExhausted(candidate.row.id)) continue
    anyAvailable = true
    const bucket = bucketFor(candidate.row.id)
    const elapsed = now - bucket.lastUsedAt
    if (elapsed >= TOKEN_INTERVAL_MS) {
      bucket.lastUsedAt = now
      return { kind: 'ok', account: candidate }
    }
    shortestWait = Math.min(shortestWait, TOKEN_INTERVAL_MS - elapsed)
  }
  return anyAvailable ? { kind: 'cooling', waitMs: shortestWait } : { kind: 'exhausted' }
}

/** The one Base64 we need: bytes a browser produced, turned into a data URL. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export async function renderPage(
  env: Env,
  userId: string,
  account: RenderUsageEntry,
  input: RenderInput,
): Promise<RenderResult> {
  const cfAccountId = account.row.cf_account_id
  if (!cfAccountId) throw ApiError.badRequest('This account has no Cloudflare account id')
  const query = input.browser === 'kitesurf' ? '?browser=kitesurf' : ''
  const started = Date.now()
  const response = await cfFetchRaw(
    account.auth,
    `/accounts/${cfAccountId}/browser-rendering/${input.mode}${query}`,
    {
      method: 'POST',
      body: { url: input.url },
      timeoutMs: 300_000,
    },
  )

  const browserMs = Number.parseInt(response.headers.get('x-browser-ms-used') ?? '0', 10) || 0
  if (!response.ok) {
    if (browserMs > 0) await incrementQuota(env, userId, account.row.id, 'browser_render_seconds', Math.ceil(browserMs / 1000))
    const body = await response.text()
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '0', 10) || 0
    const error = new ApiError(502, 'cloudflare_upstream', body.slice(0, 300) || `Browser rendering answered HTTP ${response.status}`)
    ;(error as ApiError & { retryAfter?: number }).retryAfter = retryAfter
    ;(error as ApiError & { upstreamStatus?: number }).upstreamStatus = response.status
    throw error
  }

  const result: RenderResult = { mode: input.mode, duration: 0, browserMsUsed: browserMs }
  switch (input.mode) {
    case 'screenshot':
      result.screenshot = `data:image/png;base64,${toBase64(new Uint8Array(await response.arrayBuffer()))}`
      break
    case 'pdf':
      result.pdf = `data:application/pdf;base64,${toBase64(new Uint8Array(await response.arrayBuffer()))}`
      break
    case 'content': {
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const json = await response.json() as { result?: unknown }
        result.html = typeof json.result === 'string' ? json.result : JSON.stringify(json.result ?? json)
      } else {
        result.html = await response.text()
      }
      break
    }
    case 'markdown': {
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const json = await response.json() as { result?: unknown }
        result.markdown = typeof json.result === 'string' ? json.result : JSON.stringify(json.result ?? json)
      } else {
        result.markdown = await response.text()
      }
      break
    }
    case 'links': {
      const json = await response.json() as { result?: unknown }
      result.links = json.result ?? json
      break
    }
  }
  result.duration = browserMs > 0 ? browserMs / 1000 : (Date.now() - started) / 1000
  await incrementQuota(env, userId, account.row.id, 'browser_render_seconds', Math.max(1, Math.ceil(result.duration)))
  return result
}

function isDailyLimit(message: string, retryAfter: number): boolean {
  return /browser time limit exceeded|browser limit/i.test(message) || retryAfter > DAILY_LIMIT_RETRY_AFTER_SECONDS
}

export interface RenderOutcome {
  result: RenderResult
  accountId: string
}

/**
 * Render with an explicit account, or let the service choose and fail over once.
 *
 * A daily-limit refusal marks the account and tries exactly one more; retrying in a loop would walk
 * every account in one request and still return nothing when they are all out.
 */
export async function renderWithFailover(env: Env, userId: string, input: RenderInput): Promise<RenderOutcome> {
  let chosen: RenderUsageEntry
  if (input.accountId) {
    const loaded = await loadAccount(env, userId, input.accountId)
    if (!accountHasFeature(loaded.row, 'browser_render')) {
      throw ApiError.badRequest('That account does not have browser rendering enabled')
    }
    chosen = loaded
  } else {
    const acquired = await acquireAccount(env, userId)
    if (acquired.kind === 'exhausted') {
      throw new ApiError(429, 'cloudflare_quota_exceeded', 'Every Cloudflare account has used its browser time for today')
    }
    if (acquired.kind === 'cooling') {
      throw new ApiError(429, 'too_many_attempts', `Browser rendering is cooling down; retry in ${Math.ceil(acquired.waitMs / 1000)}s`)
    }
    chosen = acquired.account
  }

  try {
    return { result: await renderPage(env, userId, chosen, input), accountId: chosen.row.id }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    const retryAfter = (error as ApiError & { retryAfter?: number }).retryAfter ?? 0
    if (!isDailyLimit(error.message, retryAfter)) throw error
    markExhausted(chosen.row.id)
    await setExhausted(env, userId, chosen.row.id, 'browser_render_seconds')
    if (input.accountId) throw new ApiError(429, 'cloudflare_quota_exceeded', 'This account has used its browser time for today')

    const retry = await acquireAccount(env, userId)
    if (retry.kind === 'exhausted') {
      throw new ApiError(429, 'cloudflare_quota_exceeded', 'Every Cloudflare account has used its browser time for today')
    }
    if (retry.kind === 'cooling') {
      throw new ApiError(429, 'too_many_attempts', `The next account is cooling down; retry in ${Math.ceil(retry.waitMs / 1000)}s`)
    }
    return { result: await renderPage(env, userId, retry.account, input), accountId: retry.account.row.id }
  }
}
