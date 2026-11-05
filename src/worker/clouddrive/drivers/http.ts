/**
 * Shared HTTP plumbing for the JSON APIs most CloudDrive drivers speak.
 *
 * The base owns the parts every driver gets wrong the same way: bounded time, a small retry budget
 * for 429/5xx, error bodies that keep their upstream message, one forced re-authentication after a
 * 401, and credential rotation written back through the vault callback. A driver only supplies its
 * login/refresh hooks and the actual endpoints.
 */
import { normalizeCloudDrivePath } from '@shared/clouddrive/model'
import { DriverError, type DriverContext } from './contract'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RETRIES = 2

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: BodyInit
  timeoutMs?: number
  retries?: number
  /** Redirects are followed by hand only when a driver asks; the default refuses them. */
  redirect?: RequestInit['redirect']
  signal?: AbortSignal
  /** Pass a `Request` as the first fetch argument instead of a URL plus init. */
  asRequest?: boolean
}

function retryDelay(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after')
  const seconds = header ? Number(header) : Number.NaN
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(5_000, seconds * 1000)
  return Math.min(2_000, 300 * 2 ** attempt)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function errorFromResponse(response: Response): Promise<DriverError> {
  const text = await response.text().catch(() => '')
  let message = ''
  try {
    // IPFS answers with a capitalised `Message`; the other APIs use the lower-case spellings.
    const parsed = JSON.parse(text) as { message?: unknown; msg?: unknown; error?: unknown; Message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message
    else if (typeof parsed.msg === 'string') message = parsed.msg
    else if (typeof parsed.error === 'string') message = parsed.error
    else if (parsed.error && typeof parsed.error === 'object') {
      const nested = parsed.error as { message?: unknown; msg?: unknown }
      if (typeof nested.message === 'string') message = nested.message
      else if (typeof nested.msg === 'string') message = nested.msg
    } else if (typeof parsed.Message === 'string') message = parsed.Message
  } catch {
    message = text.slice(0, 200)
  }
  const suffix = message ? `: ${message}` : ''
  if (response.status === 401 || response.status === 403) {
    return DriverError.auth(`The storage refused the credentials (HTTP ${response.status}${suffix})`)
  }
  if (response.status === 404) return DriverError.notFound(`Not found upstream (HTTP 404${suffix})`)
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    return DriverError.rateLimited(
      `The upstream service is rate limiting requests${suffix}`,
      Number.isFinite(retry) ? retry * 1000 : undefined,
    )
  }
  return DriverError.upstream(`The upstream service answered HTTP ${response.status}${suffix}`)
}

export abstract class HttpDriverBase {
  private authenticated = false
  private authPromise: Promise<void> | null = null

  constructor(readonly ctx: DriverContext) {}

  /** Performs the driver's login sequence and persists any rotated token. */
  protected abstract login(force: boolean): Promise<void>

  protected async authenticate(force = false): Promise<void> {
    if (force) this.authenticated = false
    if (this.authenticated) return
    if (this.authPromise) {
      await this.authPromise
      return
    }
    this.authPromise = this.login(force).then(() => {
      this.authenticated = true
    }).finally(() => {
      this.authPromise = null
    })
    await this.authPromise
  }

  /** One attempt, then a forced re-login on auth failures, then mark the storage for review. */
  protected async withAuth<T>(work: () => Promise<T>): Promise<T> {
    await this.authenticate(false)
    try {
      return await work()
    } catch (error) {
      if (!(error instanceof DriverError) || error.kind !== 'auth') throw error
      try {
        await this.authenticate(true)
        return await work()
      } catch (retryError) {
        await this.ctx.markNeedsReauth(
          retryError instanceof Error ? retryError.message : 'The storage needs to be authorized again',
        )
        throw DriverError.auth(
          retryError instanceof Error ? retryError.message : 'The storage needs to be authorized again',
        )
      }
    }
  }

  protected async request(url: string, options: HttpOptions = {}): Promise<Response> {
    const retries = options.retries ?? DEFAULT_RETRIES
    let lastError: DriverError | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      let response: Response
      try {
        const init: RequestInit = {
          method: options.method ?? 'GET',
          headers: options.headers,
          body: options.body,
          redirect: options.redirect ?? 'manual',
          signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        }
        // A driver can ask for a Request when its caller inspects the fetch argument; the init
        // object stays on the second argument so headers and bodies remain readable.
        response = options.asRequest
          ? await fetch(new Request(url, init), init)
          : await fetch(url, init)
      } catch (error) {
        lastError = DriverError.upstream(`The upstream service could not be reached: ${error instanceof Error ? error.message : String(error)}`)
        if (attempt === retries) throw lastError
        await sleep(retryDelay(null, attempt))
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = await errorFromResponse(response)
        if (attempt === retries) throw lastError
        await sleep(retryDelay(response, attempt))
        continue
      }
      if (!response.ok) throw await errorFromResponse(response)
      return response
    }
    throw lastError ?? DriverError.upstream('The upstream service did not answer')
  }

  protected async json<T>(url: string, options: HttpOptions = {}): Promise<T> {
    const response = await this.request(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers ?? {}) },
    })
    if (!response.headers.get('content-type')?.includes('json')) {
      const text = await response.text()
      try {
        return JSON.parse(text) as T
      } catch {
        throw DriverError.upstream('The upstream service returned an unexpected body')
      }
    }
    return await response.json() as T
  }

  protected async saveCredential(patch: Record<string, string>, expect?: Record<string, string>): Promise<Record<string, string>> {
    return await this.ctx.saveCredentials(patch, expect ? { expect } : undefined)
  }

  protected configText(key: string, fallback = ''): string {
    const value = this.ctx.config[key]
    return typeof value === 'string' ? value : fallback
  }
}

export function driverPath(input: string): string {
  try {
    return normalizeCloudDrivePath(input)
  } catch {
    throw DriverError.invalid()
  }
}

export function driverFileName(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function driverParentPath(path: string): string {
  if (path === '/') return '/'
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function driverChildPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

export interface PageFetcher<T> {
  (state: { page: number; cursor: string | null }): Promise<{ items: T[]; next: string | null }>
}

/**
 * The three pagination shapes the reference drivers use. `page` is one-based; `cursor`/`offset`
 * pass the previous `next` token back to the fetcher unchanged.
 */
export async function collectPages<T>(
  fetcher: PageFetcher<T>,
  options: { mode?: 'page' | 'cursor'; maxPages?: number } = {},
): Promise<{ items: T[]; truncated: boolean; pages: number }> {
  const maxPages = options.maxPages ?? 50
  const items: T[] = []
  let page = 1
  let cursor: string | null = null
  while (page <= maxPages) {
    const result = await fetcher({ page, cursor })
    items.push(...result.items)
    if (result.next === null) return { items, truncated: false, pages: page }
    cursor = result.next
    page++
  }
  return { items, truncated: true, pages: maxPages }
}

export async function uploadInParts(options: {
  size: number
  partSize: number
  uploadPart: (partNumber: number, start: number, end: number) => Promise<void>
  complete: () => Promise<void>
  concurrency?: number
}): Promise<void> {
  const partSize = Math.max(1, options.partSize)
  const total = Math.max(1, Math.ceil(options.size / partSize))
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 1))
  let next = 1
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const partNumber = next++
      if (partNumber > total) return
      const start = (partNumber - 1) * partSize
      const end = Math.min(start + partSize, options.size)
      await options.uploadPart(partNumber, start, end)
    }
  })
  await Promise.all(workers)
  await options.complete()
}
