// Derived from Xget (AGPL-3.0-only) src/upstream/cache-policy.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import type { XgetConfig } from '../config'
import { isFlatpakReferenceFilePath } from '../utils/rewrite'
import type { RequestTraits } from '../utils/validation'

const METADATA_EDGE_TTL_SECONDS = 60
const MUTABLE_EDGE_TTL_SECONDS = 300
const IMMUTABLE_EDGE_TTL_SECONDS = 86400
const IMMUTABLE_BROWSER_TTL_SECONDS = 3600

const GITHUB_RELEASE_ARTIFACT_PATTERN =
  /\.(?:tgz|whl|jar|zip|gem|crate|deb|rpm|nupkg|tar\.gz|tar\.bz2|tar\.xz)(?:$|[?#])/i
const MAVEN_ARTIFACT_PATTERN = /\.(?:jar|pom|war|aar|module)(?:$|[?#])/i
const PYPI_FILE_ARTIFACT_PATTERN = /\.(?:whl|zip|tar\.gz|tar\.bz2|tar\.xz)(?:$|[?#])/i
const MOVING_VERSION_ALIASES = new Set([
  'current',
  'dev',
  'edge',
  'latest',
  'main',
  'master',
  'nightly',
  'snapshot',
  'stable',
])

function getPathname(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return value.split(/[?#]/, 1)[0] || ''
  }
}

function getBasename(pathname: string): string {
  const basename = pathname.split('/').filter(Boolean).at(-1) || ''
  try {
    return decodeURIComponent(basename)
  } catch {
    return basename
  }
}

function hasVersionLikeToken(value: string): boolean {
  const normalized = value.toLowerCase()
  if (MOVING_VERSION_ALIASES.has(normalized)) return false
  return /(?:^|[-_.])v?\d/.test(normalized)
}

function getGithubReleaseDownloadTag(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  const releasesIndex = segments.findIndex(
    (segment, index) => segment === 'releases' && segments[index + 1] === 'download',
  )
  if (releasesIndex === -1) return null

  const tag = segments[releasesIndex + 2]
  if (!tag) return null
  try {
    return decodeURIComponent(tag)
  } catch {
    return tag
  }
}

function isGithubReleaseArtifact(effectivePath: string, targetPath: string): boolean {
  const effectiveTag = getGithubReleaseDownloadTag(effectivePath)
  const targetTag = getGithubReleaseDownloadTag(targetPath)

  return (
    (effectivePath.includes('/releases/download/') || targetPath.includes('/releases/download/')) &&
    (GITHUB_RELEASE_ARTIFACT_PATTERN.test(effectivePath) ||
      GITHUB_RELEASE_ARTIFACT_PATTERN.test(targetPath)) &&
    ((effectiveTag !== null && hasVersionLikeToken(effectiveTag)) ||
      (targetTag !== null && hasVersionLikeToken(targetTag)))
  )
}

function isNpmTarballPath(pathname: string): boolean {
  return /^\/(?:npm\/)?(?:@[^/]+\/)?[^/]+\/-\/[^/]+\.tgz$/i.test(pathname)
}

function isMavenReleaseArtifactPath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length < 4 || !MAVEN_ARTIFACT_PATTERN.test(pathname)) return false
  const version = segments.at(-2) || ''
  return /\d/.test(version) && !version.toUpperCase().includes('SNAPSHOT')
}

function isVersionedPyPIFilePath(pathname: string): boolean {
  if (!PYPI_FILE_ARTIFACT_PATTERN.test(pathname)) return false
  const stem = getBasename(pathname).replace(/\.(?:whl|zip|tar\.gz|tar\.bz2|tar\.xz)$/i, '')
  return hasVersionLikeToken(stem)
}

export function isImmutableArtifactRequest(
  platform: string,
  effectivePath: string,
  targetUrl: string,
): boolean {
  const effectivePathname = getPathname(effectivePath)
  const targetPathname = getPathname(targetUrl)

  if (platform === 'npm') {
    return isNpmTarballPath(effectivePathname) || isNpmTarballPath(targetPathname)
  }
  if (platform === 'pypi-files') {
    return isVersionedPyPIFilePath(effectivePathname) || isVersionedPyPIFilePath(targetPathname)
  }
  if (platform === 'maven') {
    return (
      isMavenReleaseArtifactPath(effectivePathname) || isMavenReleaseArtifactPath(targetPathname)
    )
  }
  if (platform === 'crates') {
    return effectivePathname.endsWith('.crate') || targetPathname.endsWith('.crate')
  }
  if (platform === 'rubygems') {
    return effectivePathname.endsWith('.gem') || targetPathname.endsWith('.gem')
  }
  if (platform === 'gh') {
    return isGithubReleaseArtifact(effectivePathname, targetPathname)
  }
  return false
}

function isNpmMetadataPath(effectivePath: string): boolean {
  return effectivePath.startsWith('/npm/') && !isImmutableArtifactRequest('npm', effectivePath, '')
}

export function shouldVaryCacheByOrigin(platform: string, effectivePath: string): boolean {
  return (
    (platform === 'flathub' && isFlatpakReferenceFilePath(effectivePath)) ||
    (platform === 'npm' && isNpmMetadataPath(effectivePath))
  )
}

function isMetadataOrIndexPath(platform: string, effectivePath: string): boolean {
  if (platform === 'npm') return isNpmMetadataPath(effectivePath)
  if (platform === 'pypi') {
    return effectivePath.startsWith('/pypi/simple/') || effectivePath === '/pypi/simple'
  }
  if (platform === 'maven') return effectivePath.endsWith('/maven-metadata.xml')
  if (platform === 'flathub') {
    return effectivePath === '/flathub/repo/summary' || effectivePath === '/flathub/repo/summary.sig'
  }
  return false
}

function buildPublicCacheControl(
  browserTtl: number,
  edgeTtl: number,
  immutable: boolean,
): string {
  const directives = ['public', `max-age=${browserTtl}`, `s-maxage=${edgeTtl}`]
  directives.push(immutable ? 'immutable' : 'must-revalidate')
  return directives.join(', ')
}

export interface CachePolicy {
  allowCacheApi: boolean
  allowFetchCache: boolean
  browserTtl: number
  cacheControl: string
  edgeTtl: number
  mode: 'bypass' | 'edge' | 'private'
  varyByOrigin: boolean
}

export function resolveCachePolicy({
  canUseCache,
  config,
  effectivePath,
  hasOriginBoundRewrite = false,
  hasSensitiveHeaders,
  platform,
  request,
  requestContext,
  targetUrl,
}: {
  canUseCache: boolean
  config: XgetConfig
  effectivePath: string
  hasOriginBoundRewrite?: boolean
  hasSensitiveHeaders: boolean
  platform: string
  request: Request
  requestContext: RequestTraits
  targetUrl: string
}): CachePolicy {
  const isProtocol =
    requestContext.isGit ||
    requestContext.isGitLFS ||
    requestContext.isDocker ||
    requestContext.isAI ||
    requestContext.isHF

  if (hasSensitiveHeaders) {
    return {
      allowCacheApi: false,
      allowFetchCache: false,
      browserTtl: 0,
      cacheControl: 'private, no-store',
      edgeTtl: 0,
      mode: 'private',
      varyByOrigin: false,
    }
  }

  if (!canUseCache || isProtocol || hasOriginBoundRewrite) {
    return {
      allowCacheApi: false,
      allowFetchCache: false,
      browserTtl: 0,
      cacheControl: 'no-store',
      edgeTtl: 0,
      mode: 'bypass',
      varyByOrigin: false,
    }
  }

  if (isImmutableArtifactRequest(platform, effectivePath, targetUrl)) {
    return {
      allowCacheApi: request.method === 'GET',
      allowFetchCache: true,
      browserTtl: IMMUTABLE_BROWSER_TTL_SECONDS,
      cacheControl: buildPublicCacheControl(
        IMMUTABLE_BROWSER_TTL_SECONDS,
        IMMUTABLE_EDGE_TTL_SECONDS,
        true,
      ),
      edgeTtl: IMMUTABLE_EDGE_TTL_SECONDS,
      mode: 'edge',
      varyByOrigin: shouldVaryCacheByOrigin(platform, effectivePath),
    }
  }

  if (isMetadataOrIndexPath(platform, effectivePath)) {
    return {
      allowCacheApi: request.method === 'GET',
      allowFetchCache: true,
      browserTtl: 0,
      cacheControl: buildPublicCacheControl(0, METADATA_EDGE_TTL_SECONDS, false),
      edgeTtl: METADATA_EDGE_TTL_SECONDS,
      mode: 'edge',
      varyByOrigin: shouldVaryCacheByOrigin(platform, effectivePath),
    }
  }

  const fallbackEdgeTtl = Number.isFinite(config.CACHE_DURATION)
    ? config.CACHE_DURATION
    : MUTABLE_EDGE_TTL_SECONDS

  return {
    allowCacheApi: request.method === 'GET',
    allowFetchCache: true,
    browserTtl: 0,
    cacheControl: buildPublicCacheControl(0, fallbackEdgeTtl, false),
    edgeTtl: fallbackEdgeTtl,
    mode: 'edge',
    varyByOrigin: shouldVaryCacheByOrigin(platform, effectivePath),
  }
}

function hasCacheControlDirective(cacheControl: string, directive: string): boolean {
  return cacheControl
    .split(',')
    .map((part) => part.trim().toLowerCase().split('=', 1)[0])
    .includes(directive)
}

function getHeaderValue(headers: Headers, name: string): string | null {
  try {
    return typeof headers.get === 'function' ? headers.get(name) : null
  } catch {
    return null
  }
}

function hasHeaderValue(headers: Headers, name: string): boolean {
  try {
    if (typeof headers.has === 'function') return headers.has(name)
  } catch {
    return false
  }
  return getHeaderValue(headers, name) !== null
}

export function resolveResponseCachePolicy({
  basePolicy,
  response,
}: {
  basePolicy: CachePolicy
  response: Response
}): CachePolicy {
  if (basePolicy.mode === 'private') {
    return {
      ...basePolicy,
      allowCacheApi: false,
      browserTtl: 0,
      cacheControl: 'private, no-store',
      edgeTtl: 0,
    }
  }

  const upstreamCacheControl = getHeaderValue(response.headers, 'Cache-Control') || ''
  const hasPrivateDirective = hasCacheControlDirective(upstreamCacheControl, 'private')
  const hasNoStoreDirective = hasCacheControlDirective(upstreamCacheControl, 'no-store')
  const hasNoCacheDirective = hasCacheControlDirective(upstreamCacheControl, 'no-cache')
  const hasSetCookie = hasHeaderValue(response.headers, 'Set-Cookie')
  const hasVaryStar = getHeaderValue(response.headers, 'Vary')
    ?.split(',')
    .map((value) => value.trim())
    .includes('*')

  if (hasSetCookie || hasPrivateDirective) {
    return {
      ...basePolicy,
      allowCacheApi: false,
      browserTtl: 0,
      cacheControl: 'private, no-store',
      edgeTtl: 0,
      mode: 'private',
    }
  }

  if (hasNoStoreDirective || hasNoCacheDirective || hasVaryStar) {
    return {
      ...basePolicy,
      allowCacheApi: false,
      browserTtl: 0,
      cacheControl: 'no-store',
      edgeTtl: 0,
      mode: 'bypass',
    }
  }

  return basePolicy
}
