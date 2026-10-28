// Derived from Xget (AGPL-3.0-only) src/protocols/git.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.

const GIT_LFS_OBJECT_PATH = /\/objects\/[a-fA-F0-9]{64}$/

export function isGitRequest(request: Request, url: URL): boolean {
  if (url.pathname.endsWith('/info/refs')) return true
  if (url.pathname.endsWith('/git-upload-pack') || url.pathname.endsWith('/git-receive-pack')) {
    return true
  }

  const userAgent = request.headers.get('User-Agent') || ''
  if (userAgent.includes('git/')) return true

  if (url.searchParams.has('service')) {
    const service = url.searchParams.get('service')
    return service === 'git-upload-pack' || service === 'git-receive-pack'
  }

  const contentType = request.headers.get('Content-Type') || ''
  return contentType.includes('git-upload-pack') || contentType.includes('git-receive-pack')
}

export function isGitLFSRequest(request: Request, url: URL): boolean {
  if (url.pathname.includes('/info/lfs')) return true
  if (url.pathname.includes('/objects/batch')) return true
  if (GIT_LFS_OBJECT_PATH.test(url.pathname)) return true

  const accept = request.headers.get('Accept') || ''
  const contentType = request.headers.get('Content-Type') || ''
  if (accept.includes('application/vnd.git-lfs') || contentType.includes('application/vnd.git-lfs')) {
    return true
  }

  const userAgent = request.headers.get('User-Agent') || ''
  return userAgent.includes('git-lfs')
}

export function configureGitHeaders(
  headers: Headers,
  request: Request,
  url: URL,
  isLFS: boolean,
): void {
  if (!isLFS) {
    if (!headers.has('User-Agent')) headers.set('User-Agent', 'git/2.34.1')
    if (request.method === 'POST' && url.pathname.endsWith('/git-upload-pack')) {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/x-git-upload-pack-request')
      }
    }
    if (request.method === 'POST' && url.pathname.endsWith('/git-receive-pack')) {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/x-git-receive-pack-request')
      }
    }
    return
  }

  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'git-lfs/3.0.0 (GitHub; darwin amd64; go 1.17.2)')
  }
  if (url.pathname.includes('/objects/batch')) {
    if (!headers.has('Accept')) headers.set('Accept', 'application/vnd.git-lfs+json')
    if (request.method === 'POST' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/vnd.git-lfs+json')
    }
  }
  if (GIT_LFS_OBJECT_PATH.test(url.pathname)) {
    if (!headers.has('Accept')) headers.set('Accept', 'application/octet-stream')
  }
}
