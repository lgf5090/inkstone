// Derived from Xget (AGPL-3.0-only) src/routing/platform-transformers.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { applyXgetPathTransform } from '@shared/development/xget/path-transforms'
import { XGET_PLATFORM_KEYS } from '@shared/development/xget/catalog'
import { getPlatformPathPrefix } from './platform-index'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripPlatformPrefix(path: string, platformKey: string): string {
  const prefix = getPlatformPathPrefix(platformKey)
  if (path === prefix.slice(0, -1)) return '/'
  return path.replace(new RegExp(`^${escapeRegex(prefix)}`), '/')
}

export function transformPath(path: string, platformKey: string): string {
  if (!XGET_PLATFORM_KEYS.includes(platformKey)) return path
  const transformedPath = stripPlatformPrefix(path, platformKey)
  return applyXgetPathTransform(transformedPath, platformKey)
}
