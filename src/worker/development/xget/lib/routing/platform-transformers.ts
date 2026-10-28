// Derived from Xget (AGPL-3.0-only) src/routing/platform-transformers.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { XGET_PLATFORM_KEYS } from '@shared/development/xget/catalog'
import { getPlatformPathPrefix } from './platform-index'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripPlatformPrefix(path: string, platformKey: string): string {
  const prefix = getPlatformPathPrefix(platformKey)
  return path.replace(new RegExp(`^${escapeRegex(prefix)}`), '/')
}

function transformCratesPath(transformedPath: string): string {
  if (!transformedPath.startsWith('/')) return transformedPath
  if (transformedPath === '/' || transformedPath.startsWith('/?')) {
    return transformedPath.replace('/', '/api/v1/crates')
  }
  return `/api/v1/crates${transformedPath}`
}

function transformFedoraPath(transformedPath: string): string {
  return transformedPath.replace(/^\/pub\/fedora\/linux(?=\/|$)/, '') || '/'
}

function transformJenkinsPath(transformedPath: string): string {
  if (!transformedPath.startsWith('/')) return transformedPath
  if (transformedPath === '/update-center.json') return '/current/update-center.json'
  if (transformedPath === '/update-center.actual.json') return '/current/update-center.actual.json'
  if (
    transformedPath.startsWith('/experimental/') ||
    transformedPath.startsWith('/download/') ||
    transformedPath.startsWith('/current/')
  ) {
    return transformedPath
  }
  return `/current${transformedPath}`
}

const PLATFORM_PATH_TRANSFORMERS: Record<string, (transformedPath: string) => string> = {
  crates: transformCratesPath,
  fedora: transformFedoraPath,
  jenkins: transformJenkinsPath,
}

export function transformPath(path: string, platformKey: string): string {
  if (!XGET_PLATFORM_KEYS.includes(platformKey)) return path
  const transformedPath = stripPlatformPrefix(path, platformKey)
  const transformer = PLATFORM_PATH_TRANSFORMERS[platformKey]
  return transformer ? transformer(transformedPath) : transformedPath
}
