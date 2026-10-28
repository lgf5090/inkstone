// Derived from Xget (AGPL-3.0-only) src/routing/resolve-target.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { xgetPathPrefix } from '@shared/development/xget/catalog'
import { normalizeRegistryApiPath } from '../protocols/docker'
import { shouldVaryCacheByOrigin } from '../upstream/cache-policy'
import { createErrorResponse } from '../utils/security'
import { getPlatformPathPrefix, SORTED_PLATFORMS } from './platform-index'
import { transformPath } from './platform-transformers'

export interface NormalizedPath {
  effectivePath: string
}

export function normalizeEffectivePath(
  url: URL,
  isDocker: boolean,
): NormalizedPath | { response: Response } {
  let effectivePath = url.pathname
  if (!isDocker) return { effectivePath }

  if (
    !url.pathname.startsWith('/cr/') &&
    !url.pathname.startsWith('/v2/cr/') &&
    url.pathname !== '/v2/auth'
  ) {
    return {
      response: createErrorResponse('container registry requests must use /cr/ prefix', 400),
    }
  }

  effectivePath = url.pathname.replace(/^\/v2/, '')

  if (url.pathname.startsWith('/v2/cr/')) {
    effectivePath = effectivePath.replace(/^\/cr\/([^/]+)\//, '/cr/$1/v2/')
  }

  return { effectivePath }
}

export interface ResolvedTarget {
  cacheTargetUrl: string
  platform: string
  shouldVaryCacheByOrigin: boolean
  targetPath: string
  targetUrl: string
}

export function resolveTarget(
  url: URL,
  effectivePath: string,
  platforms: Record<string, string>,
): ResolvedTarget | { response: Response } {
  const platform =
    SORTED_PLATFORMS.find((key) => effectivePath.startsWith(getPlatformPathPrefix(key))) ||
    effectivePath.split('/')[1]

  const upstreamBase =
    platform && Object.prototype.hasOwnProperty.call(platforms, platform)
      ? platforms[platform]
      : undefined

  if (!platform || !upstreamBase) {
    return { response: createErrorResponse('Invalid platform prefix', 400, true) }
  }

  const platformPath = `/${xgetPathPrefix(platform)}`
  if (effectivePath === platformPath || effectivePath === `${platformPath}/`) {
    return { response: createErrorResponse('Missing resource path', 400, true) }
  }

  const transformedPath = transformPath(effectivePath, platform)
  const targetPath = platform.startsWith('cr-')
    ? normalizeRegistryApiPath(platform, transformedPath)
    : transformedPath
  const targetUrl = `${upstreamBase}${targetPath}${url.search}`
  const varyCacheByOrigin = shouldVaryCacheByOrigin(platform, effectivePath)
  const cacheTargetUrl = varyCacheByOrigin
    ? `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}__xget_origin=${encodeURIComponent(url.origin)}`
    : targetUrl

  return {
    cacheTargetUrl,
    platform,
    shouldVaryCacheByOrigin: varyCacheByOrigin,
    targetPath,
    targetUrl,
  }
}
