// Derived from Xget (AGPL-3.0-only) src/routing/platform-index.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import {
  XGET_PLATFORMS_BY_LONGEST_PREFIX,
  xgetPathPrefix,
} from '@shared/development/xget/catalog'

export function getPlatformPathPrefix(platformKey: string): string {
  return `/${xgetPathPrefix(platformKey)}/`
}

export const SORTED_PLATFORMS: string[] = XGET_PLATFORMS_BY_LONGEST_PREFIX.map(
  (platform) => platform.key,
)
