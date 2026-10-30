export function usesPathStyle(config: Record<string, unknown>, endpoint: URL): boolean {
  if (typeof config.pathStyle === 'boolean') return config.pathStyle
  return !endpoint.hostname.endsWith('amazonaws.com')
}

function encodeKey(key: string): string {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

export function s3RequestUrl(endpoint: URL, config: Record<string, unknown>, key: string | null): URL {
  const bucket = String(config.bucketName ?? '')
  const basePath = endpoint.pathname.replace(/\/$/, '')
  if (usesPathStyle(config, endpoint)) {
    return new URL(`${endpoint.origin}${basePath}/${bucket}${key ? `/${encodeKey(key)}` : ''}`)
  }
  return new URL(`${endpoint.protocol}//${bucket}.${endpoint.host}${basePath}${key ? `/${encodeKey(key)}` : '/'}`)
}

export function webdavCollectionUrl(base: URL): URL {
  const url = new URL(base.toString())
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url
}
