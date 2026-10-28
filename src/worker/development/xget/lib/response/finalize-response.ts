// Derived from Xget (AGPL-3.0-only) src/response/finalize-response.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { XGET_MAX_REWRITE_BYTES } from '@shared/development/xget/constants'
import type { XgetConfig } from '../config'
import type { Cache } from '../upstream/cache'
import { resolveCachePolicy, resolveResponseCachePolicy } from '../upstream/cache-policy'
import { stripUpstreamResponseHeaders } from '../utils/headers'
import type { PerformanceMonitor } from '../utils/performance'
import {
  isFlatpakReferenceFilePath,
  rewriteTextResponse,
  shouldRewriteTextResponse,
} from '../utils/rewrite'
import { addSecurityHeaders, createErrorResponse } from '../utils/security'
import type { RequestTraits } from '../utils/validation'

function isWithinRewriteLimit(response: Response): boolean {
  const rawContentLength = response.headers.get('Content-Length')
  if (rawContentLength === null) return false
  const contentLength = Number(rawContentLength)
  return Number.isFinite(contentLength) && contentLength >= 0 && contentLength <= XGET_MAX_REWRITE_BYTES
}

async function finalizeErrorResponse({
  requestContext,
  response,
  responseGeneratedLocally,
}: {
  requestContext: RequestTraits
  response: Response
  responseGeneratedLocally: boolean
}): Promise<Response> {
  if (responseGeneratedLocally || response.ok || response.status === 206) return response

  if (requestContext.isDocker && response.status === 401) {
    if (!response.headers.has('WWW-Authenticate')) {
      const isCustomError =
        response.headers.get('content-type') === 'application/json' &&
        (await response.clone().text()).includes('UNAUTHORIZED')

      if (!isCustomError) {
        const errorText = await response.text().catch(() => '')
        return createErrorResponse(
          `Authentication required for this container registry resource. This may be a private repository. Original error: ${errorText}`,
          401,
          true,
        )
      }
    }
    return response
  }

  if (requestContext.isAI || requestContext.isHF || requestContext.isGit || requestContext.isGitLFS) {
    return response
  }

  const errorText = await response.text().catch(() => 'Unknown error')
  return createErrorResponse(
    `Upstream server error (${response.status}): ${errorText}`,
    response.status,
    true,
  )
}

async function finalizeSuccessfulResponse({
  cache,
  cacheTargetUrl,
  canUseCache,
  config,
  effectivePath,
  hasSensitiveHeaders,
  monitor,
  platform,
  request,
  requestContext,
  response,
  targetUrl = cacheTargetUrl,
  proxyBaseUrl,
}: {
  cache: Cache | null
  cacheTargetUrl: string
  canUseCache: boolean
  config: XgetConfig
  effectivePath: string
  hasSensitiveHeaders: boolean
  monitor: PerformanceMonitor
  platform: string
  request: Request
  requestContext: RequestTraits
  response: Response
  targetUrl?: string
  proxyBaseUrl: string
}): Promise<Response> {
  const { isAI, isDocker, isGit, isGitLFS, isHF } = requestContext

  let responseBody: string | ReadableStream<Uint8Array> | null = response.body
  let rewrittenContentLength: number | null = null
  let hasOriginBoundRewrite = false

  const contentType = response.headers.get('Content-Type') || ''
  if (
    isWithinRewriteLimit(response) &&
    shouldRewriteTextResponse(platform, effectivePath, contentType)
  ) {
    const originalText =
      platform === 'flathub' && isFlatpakReferenceFilePath(effectivePath)
        ? new TextDecoder().decode(await response.arrayBuffer())
        : await response.text()
    const rewrittenText = rewriteTextResponse(platform, effectivePath, originalText, proxyBaseUrl)
    responseBody = rewrittenText
    rewrittenContentLength = new TextEncoder().encode(rewrittenText).byteLength
    hasOriginBoundRewrite = platform === 'pypi'
  }

  const headers = stripUpstreamResponseHeaders(new Headers(response.headers))
  if (rewrittenContentLength !== null) {
    headers.set('Content-Length', String(rewrittenContentLength))
  }

  const requestCachePolicy = resolveCachePolicy({
    canUseCache,
    config,
    effectivePath,
    hasOriginBoundRewrite,
    hasSensitiveHeaders,
    platform,
    request,
    requestContext,
    targetUrl,
  })
  const cachePolicy = resolveResponseCachePolicy({
    basePolicy: requestCachePolicy,
    response,
  })

  if (!isGit && !isGitLFS && !isDocker && !isAI && !isHF) {
    headers.set('Cache-Control', cachePolicy.cacheControl)

    if (cachePolicy.mode === 'private') {
      const existingVary = headers.get('Vary')
      headers.set(
        'Vary',
        existingVary ? `${existingVary}, Authorization, Cookie` : 'Authorization, Cookie',
      )
    }

    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Accept-Ranges', 'bytes')
    addSecurityHeaders(headers)
  }

  let finalizedResponse = new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })

  if (
    cache &&
    cachePolicy.allowCacheApi &&
    request.method === 'GET' &&
    finalizedResponse.ok &&
    finalizedResponse.status === 200
  ) {
    const rangeHeader = request.headers.get('Range')
    const cacheKey = rangeHeader
      ? new Request(cacheTargetUrl, {
          method: 'GET',
          headers: new Headers(
            [...request.headers.entries()].filter(([key]) => key.toLowerCase() !== 'range'),
          ),
        })
      : new Request(cacheTargetUrl, { method: 'GET' })

    try {
      await cache.put(cacheKey, finalizedResponse.clone())

      if (rangeHeader) {
        const rangedResponse = await cache.match(
          new Request(cacheTargetUrl, { method: 'GET', headers: request.headers }),
        )
        if (rangedResponse) {
          monitor.mark('range_cache_hit_after_full_cache')
          finalizedResponse = rangedResponse
        }
      }
    } catch (error) {
      console.warn(
        '[xget] Cache put/match failed:',
        error instanceof Error ? error.name : 'unknown error',
      )
    }
  }

  return finalizedResponse
}

export async function finalizeResponse({
  cache,
  cacheTargetUrl,
  canUseCache,
  config,
  effectivePath,
  hasSensitiveHeaders,
  monitor,
  platform,
  request,
  requestContext,
  response,
  responseGeneratedLocally,
  targetUrl = cacheTargetUrl,
  proxyBaseUrl,
}: {
  cache: Cache | null
  cacheTargetUrl: string
  canUseCache: boolean
  config: XgetConfig
  effectivePath: string
  hasSensitiveHeaders: boolean
  monitor: PerformanceMonitor
  platform: string
  request: Request
  requestContext: RequestTraits
  response: Response
  responseGeneratedLocally: boolean
  targetUrl?: string
  proxyBaseUrl: string
}): Promise<Response> {
  const errorResponse = await finalizeErrorResponse({
    requestContext,
    response,
    responseGeneratedLocally,
  })

  if (errorResponse !== response || !errorResponse.ok) return errorResponse

  return await finalizeSuccessfulResponse({
    cache,
    cacheTargetUrl,
    canUseCache,
    config,
    effectivePath,
    hasSensitiveHeaders,
    monitor,
    platform,
    request,
    requestContext,
    response: errorResponse,
    targetUrl,
    proxyBaseUrl,
  })
}
