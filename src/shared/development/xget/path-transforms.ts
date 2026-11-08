// Derived from Xget (AGPL-3.0-only) src/routing/platform-transformers.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.

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

const XGET_PATH_TRANSFORMS: Record<string, (transformedPath: string) => string> = {
  crates: transformCratesPath,
  fedora: transformFedoraPath,
  jenkins: transformJenkinsPath,
}

export function applyXgetPathTransform(pathname: string, platformKey: string): string {
  const transformer = XGET_PATH_TRANSFORMS[platformKey]
  return transformer ? transformer(pathname) : pathname
}

export function stripXgetPathTransform(pathname: string, platformKey: string): string {
  if (platformKey !== 'crates') return pathname
  if (pathname === '/api/v1/crates' || pathname === '/api/v1/crates/') return '/'
  if (pathname.startsWith('/api/v1/crates/')) {
    return pathname.slice('/api/v1/crates'.length)
  }
  return pathname
}
