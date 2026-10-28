// Derived from Xget (AGPL-3.0-only) src/upstream/cache.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import type { PerformanceMonitor } from '../utils/performance'
import type { RequestTraits } from '../utils/validation'

export interface Cache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export function getDefaultCache(): Cache | null {
  const storage = (globalThis as unknown as { caches?: { default?: Cache } }).caches
  return storage?.default ?? null
}

export async function tryReadCachedResponse({
  cache,
  cacheTargetUrl,
  cachePolicy,
  canUseCache,
  hasSensitiveHeaders,
  monitor,
  request,
  requestContext,
}: {
  cache: Cache | null
  cacheTargetUrl: string
  cachePolicy?: { allowCacheApi: boolean }
  canUseCache: boolean
  hasSensitiveHeaders: boolean
  monitor: PerformanceMonitor
  request: Request
  requestContext: RequestTraits
}): Promise<Response | null> {
  const { isAI, isDocker, isGit, isGitLFS, isHF } = requestContext

  if (
    !cache ||
    (cachePolicy && !cachePolicy.allowCacheApi) ||
    !canUseCache ||
    isGit ||
    isGitLFS ||
    isDocker ||
    isAI ||
    isHF ||
    hasSensitiveHeaders
  ) {
    return null
  }

  try {
    const cacheKey = new Request(cacheTargetUrl, { method: 'GET', headers: request.headers })
    const cachedResponse = await cache.match(cacheKey)
    if (cachedResponse) {
      monitor.mark('cache_hit')
      return cachedResponse
    }

    const rangeHeader = request.headers.get('Range')
    if (!rangeHeader) return null

    const fullContentKey = new Request(cacheTargetUrl, {
      method: 'GET',
      headers: new Headers(
        [...request.headers.entries()].filter(([key]) => key.toLowerCase() !== 'range'),
      ),
    })
    const fullCachedResponse = await cache.match(fullContentKey)
    if (fullCachedResponse) {
      monitor.mark('cache_hit_full_content')
      return fullCachedResponse
    }
  } catch (error) {
    console.warn(
      '[xget] Cache API read failed:',
      error instanceof Error ? error.name : 'unknown error',
    )
  }

  return null
}
