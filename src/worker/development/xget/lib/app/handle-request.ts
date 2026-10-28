// Derived from Xget (AGPL-3.0-only) src/app/handle-request.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { XGET_PLATFORMS } from '@shared/development/xget/catalog'
import type { XgetConfigOverrides } from '../config'
import { createConfig } from '../config'
import { handleDockerAuth } from '../protocols/docker'
import { finalizeResponse } from '../response/finalize-response'
import { getPlatformPathPrefix } from '../routing/platform-index'
import { normalizeEffectivePath, resolveTarget } from '../routing/resolve-target'
import { getDefaultCache, tryReadCachedResponse } from '../upstream/cache'
import { resolveCachePolicy } from '../upstream/cache-policy'
import { fetchUpstreamResponse } from '../upstream/fetch-upstream'
import { stripUpstreamResponseHeaders } from '../utils/headers'
import { addPerformanceHeaders, PerformanceMonitor } from '../utils/performance'
import { addCorsHeaders, addSecurityHeaders, createErrorResponse } from '../utils/security'
import { getAllowedMethods, isProtocolRequest, validateRequest } from '../utils/validation'
import { createRequestContext } from './request-context'

function createPlatformIndexResponse(proxyBaseUrl: string): Response {
  const body = JSON.stringify(
    {
      name: 'Inkstone Xget',
      usage: `${proxyBaseUrl}/<platform-prefix>/<path>`,
      platformCount: XGET_PLATFORMS.length,
      platforms: XGET_PLATFORMS.map((platform) => ({
        key: platform.key,
        name: platform.name,
        prefix: getPlatformPathPrefix(platform.key),
        upstream: platform.upstreamBase,
        category: platform.category,
      })),
    },
    null,
    2,
  )

  const headers = addSecurityHeaders(
    new Headers({ 'Content-Type': 'application/json; charset=utf-8' }),
  )
  return new Response(body, { status: 200, headers })
}

export async function handleXgetRequest(
  request: Request,
  overrides: XgetConfigOverrides,
  proxyBaseUrl: string,
): Promise<Response> {
  let response: Response | undefined
  const monitor = new PerformanceMonitor()
  const requestContext = createRequestContext(request, overrides, proxyBaseUrl)
  const { config, isCorsPreflight, isDocker, url } = requestContext

  try {
    if (isCorsPreflight) {
      const requestedMethod = request.headers.get('Access-Control-Request-Method') || ''
      const allowedMethods = getAllowedMethods(request, url, config)

      if (!allowedMethods.includes(requestedMethod)) {
        response = createErrorResponse('Method not allowed', 405)
      } else {
        const headers = addCorsHeaders(new Headers(), request, config)
        if (!headers.has('Access-Control-Allow-Origin')) {
          response = createErrorResponse('Origin not allowed', 403)
        } else {
          headers.set('Access-Control-Allow-Methods', allowedMethods.join(', '))
          headers.set('Access-Control-Max-Age', '86400')
          addSecurityHeaders(headers)
          response = new Response(null, { status: 204, headers })
        }
      }
    } else if (isDocker && (url.pathname === '/v2/' || url.pathname === '/v2')) {
      const headers = new Headers({
        'Docker-Distribution-Api-Version': 'registry/2.0',
        'Content-Type': 'application/json',
      })
      addSecurityHeaders(headers)
      response = new Response('{}', { status: 200, headers })
    } else if (url.pathname === '/' || url.pathname === '') {
      response = createPlatformIndexResponse(proxyBaseUrl)
    } else {
      const validation = validateRequest(request, url, config, requestContext)
      if (!validation.valid) {
        response = createErrorResponse(
          validation.error || 'Validation failed',
          validation.status || 400,
        )
      } else {
        const normalizedPath = normalizeEffectivePath(url, isDocker)
        let effectivePath = url.pathname

        if ('response' in normalizedPath) {
          response = normalizedPath.response
        } else {
          effectivePath = normalizedPath.effectivePath
        }

        if (!response) {
          if (
            isDocker &&
            (url.pathname === '/v2/auth' || /^\/cr\/[^/]+\/v2\/auth\/?$/.test(url.pathname))
          ) {
            response = await handleDockerAuth(request, url, config)
          } else {
            const resolvedTarget = resolveTarget(url, effectivePath, config.PLATFORMS)

            if ('response' in resolvedTarget) {
              response = resolvedTarget.response
            } else {
              const { cacheTargetUrl, platform, targetUrl } = resolvedTarget
              const authorization = request.headers.get('Authorization')
              // The site's session cookie is stripped before the upstream request; it must not
              // turn every browser download into a private, uncacheable response.
              const hasSensitiveHeaders = Boolean(
                authorization || request.headers.get('Proxy-Authorization'),
              )
              const canUseCache = request.method === 'GET' || request.method === 'HEAD'
              const shouldPassthroughRequest = isProtocolRequest(requestContext) || !canUseCache
              const cachePolicy = resolveCachePolicy({
                canUseCache,
                config,
                effectivePath,
                hasSensitiveHeaders,
                platform,
                request,
                requestContext,
                targetUrl,
              })
              const cache = getDefaultCache()

              response =
                (await tryReadCachedResponse({
                  cache,
                  cacheTargetUrl,
                  cachePolicy,
                  canUseCache,
                  hasSensitiveHeaders,
                  monitor,
                  request,
                  requestContext,
                })) ?? undefined

              if (!response) {
                const {
                  response: upstreamResponse,
                  responseGeneratedLocally: upstreamResponseGeneratedLocally,
                } = await fetchUpstreamResponse({
                  authorization,
                  cachePolicy,
                  canUseCache,
                  config,
                  effectivePath,
                  monitor,
                  platform,
                  request,
                  requestContext,
                  shouldPassthroughRequest,
                  targetUrl,
                })
                response = await finalizeResponse({
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
                  response: upstreamResponse,
                  responseGeneratedLocally: upstreamResponseGeneratedLocally,
                  targetUrl,
                  proxyBaseUrl,
                })
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(
      '[xget] Request handling failed:',
      error instanceof Error ? error.name : 'unknown error',
    )
    response = createErrorResponse('Internal Server Error', 500)
  }

  if (!response) response = createErrorResponse('Internal Server Error', 500)

  monitor.mark('complete')

  const preservePreflightHeaders = isCorsPreflight && response.status === 204
  const finalizedHeaders = preservePreflightHeaders
    ? new Headers(response.headers)
    : addCorsHeaders(stripUpstreamResponseHeaders(new Headers(response.headers)), request, config)

  const responseWithCors = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: finalizedHeaders,
  })

  return isProtocolRequest(requestContext)
    ? responseWithCors
    : addPerformanceHeaders(responseWithCors, monitor)
}

export function resolveProxyTarget(
  pathname: string,
  overrides: XgetConfigOverrides,
): { ok: true; platform: string; targetUrl: string } | { ok: false; error: string } {
  const config = createConfig(overrides)
  const fakeUrl = new URL(`https://xget.local${pathname.startsWith('/') ? pathname : `/${pathname}`}`)
  const resolved = resolveTarget(fakeUrl, fakeUrl.pathname, config.PLATFORMS)

  if ('response' in resolved) {
    return { ok: false, error: 'Invalid platform prefix or missing resource path' }
  }

  return { ok: true, platform: resolved.platform, targetUrl: resolved.targetUrl }
}
