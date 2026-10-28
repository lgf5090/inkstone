// Derived from Xget (AGPL-3.0-only) src/protocols/docker.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { xgetPathPrefix } from '@shared/development/xget/catalog'
import type { XgetConfig } from '../config'
import { SORTED_PLATFORMS } from '../routing/platform-index'
import { createErrorResponse } from '../utils/security'

export interface WwwAuthenticate {
  realm: string
  service: string
}

function logError(scope: string, error: unknown): void {
  console.warn(`[xget] ${scope}:`, error instanceof Error ? error.name : 'unknown error')
}

function parseSecureUrl(value: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use https`)
  if (parsed.username || parsed.password) throw new Error(`${label} must not include credentials`)
  return parsed
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutSeconds: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

export function parseAuthenticate(authenticateStr: string): WwwAuthenticate {
  const realmMatch = authenticateStr.match(/realm="([^"]+)"/)
  const serviceMatch = authenticateStr.match(/service="([^"]+)"/)

  if (!realmMatch || !serviceMatch) {
    throw new Error('invalid WWW-Authenticate header')
  }

  return { realm: realmMatch[1], service: serviceMatch[1] }
}

export async function fetchToken(
  wwwAuthenticate: WwwAuthenticate,
  scope: string,
  authorization: string,
  timeoutSeconds: number,
): Promise<Response> {
  const url = parseSecureUrl(wwwAuthenticate.realm, 'registry token realm')
  if (wwwAuthenticate.service.length) url.searchParams.set('service', wwwAuthenticate.service)
  if (scope) url.searchParams.set('scope', scope)

  const headers = new Headers()
  if (authorization) headers.set('Authorization', authorization)

  return await fetchWithTimeout(url, { method: 'GET', headers }, timeoutSeconds)
}

export async function readRegistryTokenResponse(response: Response): Promise<string | null> {
  let rawBody: string
  try {
    rawBody = await response.text()
  } catch (error) {
    logError('Failed to read registry token response', error)
    return null
  }

  if (!rawBody.trim()) return null

  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.token === 'string') return record.token
    if (typeof record.access_token === 'string') return record.access_token
    return null
  } catch {
    console.warn('[xget] Registry token response is not valid JSON')
    return null
  }
}

function normalizeRepoPath(platformKey: string, repoPath: string): string {
  if (platformKey === 'cr-docker' && repoPath && !repoPath.includes('/')) {
    return `library/${repoPath}`
  }
  return repoPath
}

function extractRepositoryPath(apiPath: string): string {
  const normalizedPath = apiPath.startsWith('/v2/') ? apiPath.slice(4) : apiPath.replace(/^\/+/, '')
  const pathParts = normalizedPath.split('/').filter(Boolean)

  if (pathParts.length === 0 || pathParts[0].startsWith('_')) return ''

  const suffixIndex = pathParts.findIndex((part) =>
    ['manifests', 'blobs', 'tags', 'referrers'].includes(part),
  )
  if (suffixIndex <= 0) return ''

  return pathParts.slice(0, suffixIndex).join('/')
}

export function normalizeRegistryApiPath(platformKey: string, apiPath: string): string {
  if (platformKey !== 'cr-docker' || !apiPath.startsWith('/v2/')) return apiPath
  const repoPath = extractRepositoryPath(apiPath)
  const normalizedRepoPath = normalizeRepoPath(platformKey, repoPath)
  if (!repoPath || normalizedRepoPath === repoPath) return apiPath
  return apiPath.replace(`/v2/${repoPath}`, `/v2/${normalizedRepoPath}`)
}

export function getScopeFromUrl(url: URL, effectivePath: string, platform: string): string {
  void url
  const platformPrefix = `/${xgetPathPrefix(platform)}/`

  if (effectivePath.includes('/_catalog')) return 'registry:catalog:*'

  const apiPath = normalizeRegistryApiPath(
    platform,
    effectivePath.startsWith(platformPrefix)
      ? `/${effectivePath.slice(platformPrefix.length)}`
      : effectivePath,
  )
  const repoName = extractRepositoryPath(apiPath)
  return repoName ? `repository:${repoName}:pull` : ''
}

function resolveDockerAuthTarget(
  url: URL,
  platforms: Record<string, string>,
): { platformKey: string; upstreamScope: string } {
  const scope = url.searchParams.get('scope') || ''
  const pathMatch = url.pathname.match(/^\/cr\/([^/]+)\/v2\/auth\/?$/)

  let platformKey = pathMatch ? `cr-${pathMatch[1]}` : ''
  let repoPath = ''
  let upstreamScope = scope

  if (scope) {
    const parts = scope.split(':')
    if (parts.length >= 3 && parts[0] === 'repository') {
      const [, fullRepoPath] = parts

      if (fullRepoPath.startsWith('cr/')) {
        for (const key of SORTED_PLATFORMS) {
          if (!key.startsWith('cr-')) continue
          const prefix = xgetPathPrefix(key)
          if (fullRepoPath.startsWith(`${prefix}/`)) {
            platformKey = key
            repoPath = fullRepoPath.slice(prefix.length + 1)
            break
          }
        }
      } else {
        repoPath = fullRepoPath
      }

      repoPath = normalizeRepoPath(platformKey, repoPath)
      upstreamScope = repoPath ? `repository:${repoPath}:${parts.slice(2).join(':')}` : scope
    }
  }

  if (!platformKey || !Object.prototype.hasOwnProperty.call(platforms, platformKey)) {
    throw new Error('unsupported registry platform in scope')
  }

  return { platformKey, upstreamScope }
}

export function responseUnauthorized(platform: string, proxyBaseUrl: string): Response {
  const realmPath = platform.startsWith('cr-')
    ? `/cr/${platform.slice(3)}/v2/auth`
    : '/v2/auth'
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('WWW-Authenticate', `Bearer realm="${proxyBaseUrl}${realmPath}",service="Xget"`)
  return new Response(
    JSON.stringify({
      errors: [{ code: 'UNAUTHORIZED', message: 'authentication required', detail: null }],
    }),
    { status: 401, headers },
  )
}

export async function handleDockerAuth(
  request: Request,
  url: URL,
  config: Pick<XgetConfig, 'PLATFORMS' | 'TIMEOUT_SECONDS'>,
): Promise<Response> {
  let target: { platformKey: string; upstreamScope: string }
  try {
    target = resolveDockerAuthTarget(url, config.PLATFORMS)
  } catch (error) {
    logError('Failed to resolve Docker auth target', error)
    return createErrorResponse('Invalid Docker authentication request', 400)
  }

  const upstreamUrl = config.PLATFORMS[target.platformKey]
  let v2Url: URL
  try {
    v2Url = parseSecureUrl(`${upstreamUrl}/v2/`, 'registry endpoint')
  } catch (error) {
    logError('Invalid registry endpoint', error)
    return createErrorResponse('Invalid registry endpoint', 502)
  }

  let v2Response: Response
  try {
    v2Response = await fetchWithTimeout(
      v2Url,
      { method: 'GET', redirect: 'follow' },
      config.TIMEOUT_SECONDS,
    )
  } catch (error) {
    logError('Registry authentication probe failed', error)
    return createErrorResponse('Registry authentication unavailable', 502)
  }

  if (v2Response.status !== 401) return v2Response

  const authenticateStr = v2Response.headers.get('WWW-Authenticate')
  if (authenticateStr === null) return v2Response

  let wwwAuthenticate: WwwAuthenticate
  try {
    wwwAuthenticate = parseAuthenticate(authenticateStr)
  } catch (error) {
    logError('Invalid registry authentication challenge', error)
    return createErrorResponse('Invalid registry authentication challenge', 502)
  }

  try {
    return await fetchToken(
      wwwAuthenticate,
      target.upstreamScope,
      request.headers.get('Authorization') || '',
      config.TIMEOUT_SECONDS,
    )
  } catch (error) {
    logError('Registry token request failed', error)
    return createErrorResponse('Registry token request failed', 502)
  }
}
