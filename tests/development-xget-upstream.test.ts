// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { XgetConfigOverrides } from '../src/shared/development/xget/types'
import { handleXgetRequest } from '../src/worker/development/xget/lib/app/handle-request'
import { createConfig } from '../src/worker/development/xget/lib/config'
import {
  resolveCachePolicy,
  resolveResponseCachePolicy,
} from '../src/worker/development/xget/lib/upstream/cache-policy'
import type { RequestTraits } from '../src/worker/development/xget/lib/utils/validation'

const PROXY_BASE = 'https://proxy.example/api/development/xget'

const NO_PROTOCOL: RequestTraits = {
  isAI: false,
  isDocker: false,
  isGit: false,
  isGitLFS: false,
  isHF: false,
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function call(
  path: string,
  init: RequestInit = {},
  overrides: XgetConfigOverrides = {},
): Promise<Response> {
  return handleXgetRequest(new Request(`https://proxy.example${path}`, init), overrides, PROXY_BASE)
}

function readUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function policyFor(input: {
  effectivePath: string
  platform: string
  targetUrl: string
  canUseCache?: boolean
  hasSensitiveHeaders?: boolean
  hasOriginBoundRewrite?: boolean
  requestContext?: RequestTraits
  method?: string
}) {
  return resolveCachePolicy({
    canUseCache: input.canUseCache ?? true,
    config: createConfig({}),
    effectivePath: input.effectivePath,
    hasOriginBoundRewrite: input.hasOriginBoundRewrite ?? false,
    hasSensitiveHeaders: input.hasSensitiveHeaders ?? false,
    platform: input.platform,
    request: new Request(`https://proxy.example${input.effectivePath}`, {
      method: input.method ?? 'GET',
    }),
    requestContext: input.requestContext ?? NO_PROTOCOL,
    targetUrl: input.targetUrl,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Xget cache policy matrix', () => {
  it('marks versioned artifacts as immutable', () => {
    const policy = policyFor({
      effectivePath: '/npm/left-pad/-/left-pad-1.0.0.tgz',
      platform: 'npm',
      targetUrl: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
    })

    expect(policy).toMatchObject({
      allowCacheApi: true,
      allowFetchCache: true,
      browserTtl: 3600,
      edgeTtl: 86400,
      mode: 'edge',
      varyByOrigin: false,
    })
    expect(policy.cacheControl).toBe('public, max-age=3600, s-maxage=86400, immutable')
  })

  it('marks package metadata as short-lived and origin bound', () => {
    const policy = policyFor({
      effectivePath: '/npm/react',
      platform: 'npm',
      targetUrl: 'https://registry.npmjs.org/react',
    })

    expect(policy).toMatchObject({
      browserTtl: 0,
      edgeTtl: 60,
      mode: 'edge',
      varyByOrigin: true,
    })
    expect(policy.cacheControl).toBe('public, max-age=0, s-maxage=60, must-revalidate')
  })

  it('falls back to the configured TTL for mutable resources', () => {
    const policy = policyFor({
      effectivePath: '/debian/pool/main/c/curl/curl_7.88.1-10+deb12u4_amd64.deb',
      platform: 'debian',
      targetUrl: 'https://deb.debian.org/debian/pool/main/c/curl/curl_7.88.1-10+deb12u4_amd64.deb',
    })

    expect(policy).toMatchObject({ browserTtl: 0, edgeTtl: 300, mode: 'edge' })
    expect(policy.cacheControl).toBe('public, max-age=0, s-maxage=300, must-revalidate')
  })

  it('never caches requests carrying credentials', () => {
    const policy = policyFor({
      effectivePath: '/npm/react',
      platform: 'npm',
      targetUrl: 'https://registry.npmjs.org/react',
      hasSensitiveHeaders: true,
    })

    expect(policy).toMatchObject({
      allowCacheApi: false,
      allowFetchCache: false,
      mode: 'private',
      cacheControl: 'private, no-store',
    })
  })

  it('bypasses the cache for non-cacheable methods, protocols and origin-bound rewrites', () => {
    const base = {
      effectivePath: '/npm/react',
      platform: 'npm',
      targetUrl: 'https://registry.npmjs.org/react',
    }

    expect(policyFor({ ...base, canUseCache: false, method: 'POST' })).toMatchObject({
      mode: 'bypass',
      cacheControl: 'no-store',
    })
    expect(
      policyFor({
        ...base,
        requestContext: { ...NO_PROTOCOL, isGit: true },
      }),
    ).toMatchObject({ mode: 'bypass', cacheControl: 'no-store' })
    expect(policyFor({ ...base, hasOriginBoundRewrite: true })).toMatchObject({
      mode: 'bypass',
      cacheControl: 'no-store',
    })
  })

  it('tightens the base policy from upstream response headers', () => {
    const edge = policyFor({
      effectivePath: '/npm/react',
      platform: 'npm',
      targetUrl: 'https://registry.npmjs.org/react',
    })

    const withCookie = resolveResponseCachePolicy({
      basePolicy: edge,
      response: new Response('x', { headers: { 'Set-Cookie': 'a=b' } }),
    })
    expect(withCookie).toMatchObject({ allowCacheApi: false, mode: 'private' })

    const upstreamPrivate = resolveResponseCachePolicy({
      basePolicy: edge,
      response: new Response('x', { headers: { 'Cache-Control': 'private, max-age=60' } }),
    })
    expect(upstreamPrivate).toMatchObject({ allowCacheApi: false, mode: 'private' })

    const upstreamNoStore = resolveResponseCachePolicy({
      basePolicy: edge,
      response: new Response('x', { headers: { 'Cache-Control': 'no-store' } }),
    })
    expect(upstreamNoStore).toMatchObject({ allowCacheApi: false, mode: 'bypass' })

    const varyStar = resolveResponseCachePolicy({
      basePolicy: edge,
      response: new Response('x', { headers: { Vary: '*' } }),
    })
    expect(varyStar).toMatchObject({ allowCacheApi: false, mode: 'bypass' })

    const unchanged = resolveResponseCachePolicy({
      basePolicy: edge,
      response: new Response('x', { headers: { 'Cache-Control': 'public, max-age=60' } }),
    })
    expect(unchanged).toEqual(edge)
  })
})

describe('the Xget upstream retries', () => {
  it('retries 5xx responses and returns the eventual success', async () => {
    let calls = 0
    const fetchMock = stubFetch(async () => {
      calls += 1
      if (calls < 3) return new Response('retry', { status: 500 })
      return new Response('ok', { status: 200 })
    })

    const response = await call('/npm/react', {}, { MAX_RETRIES: 3, RETRY_DELAY_MS: 0 })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry 4xx responses', async () => {
    const fetchMock = stubFetch(async () => new Response('missing', { status: 404 }))

    const response = await call('/npm/react', {}, { MAX_RETRIES: 3, RETRY_DELAY_MS: 0 })
    expect(response.status).toBe(404)
    const text = await response.text()
    expect(text).toContain('Upstream server error (404)')
    expect(text).toContain('missing')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries network failures before reporting 502', async () => {
    const fetchMock = stubFetch(async () => {
      throw new TypeError('fetch failed')
    })

    const response = await call('/npm/react', {}, { MAX_RETRIES: 2, RETRY_DELAY_MS: 0 })
    expect(response.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reuses the buffered request body across retries', async () => {
    const sentBodies: string[] = []
    let calls = 0
    const fetchMock = stubFetch(async (_input, init) => {
      calls += 1
      const body = init?.body
      sentBodies.push(body instanceof Uint8Array ? new TextDecoder().decode(body) : '')
      if (calls === 1) return new Response('retry', { status: 500 })
      return new Response('ok', { status: 200 })
    })

    const response = await call(
      '/gh/owner/repo/git-receive-pack',
      { method: 'POST', body: 'payload' },
      { MAX_RETRIES: 2, RETRY_DELAY_MS: 0 },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentBodies).toEqual(['payload', 'payload'])
  })

  it('returns 408 when an attempt times out', async () => {
    const fetchMock = stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )

    const response = await call(
      '/npm/react',
      {},
      { TIMEOUT_SECONDS: 1, MAX_RETRIES: 3, RETRY_DELAY_MS: 0 },
    )
    expect(response.status).toBe(408)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('the Xget HEAD handling', () => {
  it('fills Content-Length from a ranged GET when the HEAD response has none', async () => {
    const calls: { method: string; range: string | null }[] = []
    const fetchMock = stubFetch(async (_input, init) => {
      const headers = new Headers(init?.headers as Headers)
      calls.push({ method: init?.method ?? 'GET', range: headers.get('range') })
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
      }
      return new Response(null, {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-0/4242' },
      })
    })

    const response = await call('/npm/react', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('4242')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(calls[1]).toEqual({ method: 'GET', range: 'bytes=0-0' })
  })
})

describe('the Xget Docker protocol', () => {
  it('retries a 401 with an anonymous registry token scoped to the repository', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchMock = stubFetch(async (input, init) => {
      calls.push({ url: readUrl(input), init })
      if (calls.length === 1) {
        return new Response('{}', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          },
        })
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify({ token: 'anon-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('manifest', { status: 200 })
    })

    const response = await call('/cr/docker/v2/nginx/manifests/latest', {}, { MAX_RETRIES: 1 })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(calls[0].url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/latest')

    const tokenUrl = new URL(calls[1].url)
    expect(tokenUrl.origin).toBe('https://auth.docker.io')
    expect(tokenUrl.pathname).toBe('/token')
    expect(tokenUrl.searchParams.get('service')).toBe('registry.docker.io')
    expect(tokenUrl.searchParams.get('scope')).toBe('repository:library/nginx:pull')

    const retryHeaders = new Headers(calls[2].init?.headers as Headers)
    expect(retryHeaders.get('authorization')).toBe('Bearer anon-token')
    expect(calls[2].url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/latest')
  })

  it('drops Authorization when following a Docker redirect', async () => {
    const calls: { url: string; authorization: string | null }[] = []
    stubFetch(async (input, init) => {
      const headers = new Headers(init?.headers as Headers)
      calls.push({ url: readUrl(input), authorization: headers.get('authorization') })
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.registry.example/blob' },
        })
      }
      return new Response('blob', { status: 200 })
    })

    const response = await call('/cr/docker/v2/library/nginx/blobs/sha256:abc', {
      headers: { Authorization: 'Bearer private-token' },
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[0].authorization).toBe('Bearer private-token')
    expect(calls[1].url).toBe('https://cdn.registry.example/blob')
    expect(calls[1].authorization).toBeNull()
  })

  it('returns a local 401 challenge when the anonymous token is unavailable', async () => {
    stubFetch(async () =>
      new Response('{}', {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
        },
      }),
    )
    // The second call is the token request and is also answered with 401.
    const response = await call('/cr/docker/v2/nginx/manifests/latest', {}, { MAX_RETRIES: 1 })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(
      `${PROXY_BASE}/cr/docker/v2/auth`,
    )
  })
})

describe('the Xget edge cache', () => {
  it('serves a cached response without contacting upstream', async () => {
    const cache = {
      match: vi.fn(async () => new Response('cached-body', { status: 200 })),
      put: vi.fn(async () => undefined),
    }
    vi.stubGlobal('caches', { default: cache })
    const fetchMock = stubFetch(async () => {
      throw new Error('fetch must not run on a cache hit')
    })

    const response = await call('/npm/react')
    expect(await response.text()).toBe('cached-body')
    expect(fetchMock).not.toHaveBeenCalled()

    const metrics = JSON.parse(response.headers.get('x-performance-metrics') as string) as Record<string, number>
    expect(metrics.cache_hit).toBeTypeOf('number')
  })

  it('warns and still returns the response when the cache write fails', async () => {
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new Error('quota exceeded')
      }),
    }
    vi.stubGlobal('caches', { default: cache })
    stubFetch(async () => new Response('fresh', { status: 200 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await call('/npm/react')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fresh')
    expect(cache.put).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('does not cache responses for requests that carry credentials', async () => {
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    }
    vi.stubGlobal('caches', { default: cache })
    stubFetch(async () => new Response('private', { status: 200 }))

    const response = await call('/npm/react', { headers: { Authorization: 'Bearer secret' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(cache.match).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('keeps upstream Set-Cookie responses out of the shared cache and response', async () => {
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    }
    vi.stubGlobal('caches', { default: cache })
    stubFetch(async () =>
      new Response('fresh', {
        status: 200,
        headers: { 'Set-Cookie': 'upstream=1', 'Content-Type': 'application/json' },
      }),
    )

    const response = await call('/npm/react')
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(cache.put).not.toHaveBeenCalled()
  })
})
