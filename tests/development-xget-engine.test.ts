// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { xgetPathPrefix } from '../src/shared/development/xget/catalog'
import type { XgetConfigOverrides } from '../src/shared/development/xget/types'
import { handleXgetRequest, resolveProxyTarget } from '../src/worker/development/xget/lib/app/handle-request'
import { createConfig } from '../src/worker/development/xget/lib/config'
import { normalizeEffectivePath, resolveTarget } from '../src/worker/development/xget/lib/routing/resolve-target'
import { readRequestBodyWithinLimit } from '../src/worker/development/xget/lib/upstream/fetch-upstream'
import { validateRequest } from '../src/worker/development/xget/lib/utils/validation'

const PROXY_BASE = 'https://proxy.example/api/development/xget'

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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Xget platform routing', () => {
  it('resolves plain, hyphenated and special platform prefixes', () => {
    expect(resolveProxyTarget('/gh/microsoft/vscode/archive/refs/heads/main.zip', {})).toEqual({
      ok: true,
      platform: 'gh',
      targetUrl: 'https://github.com/microsoft/vscode/archive/refs/heads/main.zip',
    })

    expect(resolveProxyTarget('/ip/openai/v1/models', {})).toEqual({
      ok: true,
      platform: 'ip-openai',
      targetUrl: 'https://api.openai.com/v1/models',
    })

    expect(resolveProxyTarget('/homebrew/api/formula/git.json', {})).toEqual({
      ok: true,
      platform: 'homebrew-api',
      targetUrl: 'https://formulae.brew.sh/api/formula/git.json',
    })

    expect(resolveProxyTarget('/homebrew/bottles/core/git/manifests/2.39.0', {})).toEqual({
      ok: true,
      platform: 'homebrew-bottles',
      targetUrl: 'https://ghcr.io/core/git/manifests/2.39.0',
    })
  })

  it('applies the crates, fedora and jenkins path transformers', () => {
    expect(resolveProxyTarget('/crates/serde', {})).toMatchObject({
      ok: true,
      platform: 'crates',
      targetUrl: 'https://crates.io/api/v1/crates/serde',
    })

    expect(resolveProxyTarget('/fedora/pub/fedora/linux/releases/39/Everything/os/Packages/n/nginx.rpm', {})).toMatchObject({
      ok: true,
      targetUrl: 'https://mirrors.kernel.org/fedora/releases/39/Everything/os/Packages/n/nginx.rpm',
    })

    expect(resolveProxyTarget('/jenkins/update-center.json', {})).toMatchObject({
      ok: true,
      targetUrl: 'https://updates.jenkins.io/current/update-center.json',
    })

    expect(resolveProxyTarget('/jenkins/plugin-versions.json', {})).toMatchObject({
      ok: true,
      targetUrl: 'https://updates.jenkins.io/current/plugin-versions.json',
    })
  })

  it('normalizes Docker Hub library images and leaves other registries alone', () => {
    expect(resolveProxyTarget('/cr/docker/v2/nginx/manifests/latest', {})).toMatchObject({
      ok: true,
      platform: 'cr-docker',
      targetUrl: 'https://registry-1.docker.io/v2/library/nginx/manifests/latest',
    })

    expect(resolveProxyTarget('/cr/quay/v2/nginxinc/nginx/manifests/latest', {})).toMatchObject({
      ok: true,
      platform: 'cr-quay',
      targetUrl: 'https://quay.io/v2/nginxinc/nginx/manifests/latest',
    })
  })

  it('keeps the query string on the target URL', () => {
    expect(resolveProxyTarget('/gh/o/r/archive/main.zip?ref=1', {})).toMatchObject({
      ok: true,
      targetUrl: 'https://github.com/o/r/archive/main.zip?ref=1',
    })
  })

  it('replaces every hyphen in a platform key, not just the first', () => {
    expect(xgetPathPrefix('homebrew-bottles')).toBe('homebrew/bottles')
    expect(xgetPathPrefix('ip-openai')).toBe('ip/openai')
  })

  it('normalizes the legacy /v2/cr/ Docker spelling', () => {
    const url = new URL('https://proxy.example/v2/cr/docker/library/nginx/manifests/latest')
    const normalized = normalizeEffectivePath(url, true)
    expect('effectivePath' in normalized && normalized.effectivePath).toBe(
      '/cr/docker/v2/library/nginx/manifests/latest',
    )

    const invalid = normalizeEffectivePath(new URL('https://proxy.example/v2/other/manifests/latest'), true)
    expect('response' in invalid && invalid.response.status).toBe(400)
  })

  it('varies the cache key by request origin for origin-bound rewrites', () => {
    const config = createConfig({})
    const npmUrl = new URL('https://proxy.example/npm/react')
    const npmTarget = resolveTarget(npmUrl, '/npm/react', config.PLATFORMS)
    expect('cacheTargetUrl' in npmTarget && npmTarget.cacheTargetUrl).toContain(
      '__xget_origin=https%3A%2F%2Fproxy.example',
    )

    const mutableUrl = new URL('https://proxy.example/gh/o/r/archive/main.zip')
    const mutableTarget = resolveTarget(mutableUrl, '/gh/o/r/archive/main.zip', config.PLATFORMS)
    expect('cacheTargetUrl' in mutableTarget && mutableTarget.cacheTargetUrl).not.toContain(
      '__xget_origin',
    )
  })

  it('rejects unknown platforms and bare platform prefixes', () => {
    expect(resolveProxyTarget('/unknown/thing', {})).toMatchObject({ ok: false })
    expect(resolveProxyTarget('/gh', {})).toMatchObject({ ok: false })
    expect(resolveProxyTarget('/gh/', {})).toMatchObject({ ok: false })
  })
})

describe('the Xget request validation', () => {
  it('rejects encoded directory traversal', async () => {
    const doubleEncoded = await call('/gh/%252e%252e/%252e%252e/etc/passwd')
    expect(doubleEncoded.status).toBe(400)

    const singleEncoded = await call('/gh/%2e%2e/%2e%2e/etc/passwd')
    expect(singleEncoded.status).toBe(400)
  })

  it('rejects ascii control characters in the path', () => {
    const config = createConfig({})
    const pathname = '/gh/a\u0001b'
    const fakeUrl = {
      pathname,
      searchParams: new URLSearchParams(),
      origin: 'https://proxy.example',
    } as unknown as URL
    const fakeRequest = {
      method: 'GET',
      url: `https://proxy.example${pathname}`,
      headers: new Headers(),
    } as unknown as Request

    expect(validateRequest(fakeRequest, fakeUrl, config)).toMatchObject({
      valid: false,
      status: 400,
    })
  })

  it('rejects disallowed methods and overlong paths', async () => {
    expect((await call('/npm/react', { method: 'POST' })).status).toBe(405)

    const overlong = await call(`/npm/${'a'.repeat(2100)}`)
    expect(overlong.status).toBe(414)
  })

  it('lets protocol requests use any known method', async () => {
    stubFetch(async () => new Response('ok', { status: 200 }))
    const response = await call('/gh/owner/repo/info/refs?service=git-upload-pack', {
      method: 'POST',
    })
    expect(response.status).toBe(200)
  })

  it('applies the shared configuration bounds', () => {
    expect(createConfig({})).toMatchObject({
      TIMEOUT_SECONDS: 30,
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 1000,
      CACHE_DURATION: 300,
      SECURITY: {
        ALLOWED_METHODS: ['GET', 'HEAD'],
        ALLOWED_ORIGINS: ['*'],
        MAX_PATH_LENGTH: 2048,
      },
    })

    expect(createConfig({ TIMEOUT_SECONDS: 0, MAX_RETRIES: 99, RETRY_DELAY_MS: -1 })).toMatchObject({
      TIMEOUT_SECONDS: 30,
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 1000,
    })

    expect(
      createConfig({
        SECURITY: {
          ALLOWED_METHODS: ['post', ' GET', 'post', 'NOTREAL'],
          ALLOWED_ORIGINS: ['https://Example.com', 'ftp://example.com', 'https://user:pass@example.com'],
          MAX_PATH_LENGTH: 0,
        },
      }),
    ).toMatchObject({
      SECURITY: {
        ALLOWED_METHODS: ['POST', 'GET'],
        ALLOWED_ORIGINS: ['https://example.com'],
        MAX_PATH_LENGTH: 2048,
      },
    })

    expect(createConfig({ SECURITY: { ALLOWED_ORIGINS: ['not-a-url'] } }).SECURITY.ALLOWED_ORIGINS).toEqual([])
    expect(createConfig({ SECURITY: { ALLOWED_ORIGINS: [] } }).SECURITY.ALLOWED_ORIGINS).toEqual([])
  })
})

describe('the Xget CORS preflight', () => {
  function preflight(origin: string, method: string) {
    return call('/npm/react', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': method,
      },
    })
  }

  it('answers an allowed preflight with the engine CORS headers', async () => {
    const response = await preflight('https://app.example', 'GET')
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD')
    expect(response.headers.get('access-control-max-age')).toBe('86400')
  })

  it('rejects origins outside the configured allow list', async () => {
    const response = await call(
      '/npm/react',
      {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
      },
      { SECURITY: { ALLOWED_ORIGINS: ['https://app.example'] } },
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('echoes an allowed explicit origin', async () => {
    const response = await call(
      '/npm/react',
      {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'GET' },
      },
      { SECURITY: { ALLOWED_ORIGINS: ['https://app.example'] } },
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example')
  })

  it('rejects methods outside the allowed list', async () => {
    const response = await preflight('https://app.example', 'POST')
    expect(response.status).toBe(405)
  })
})

describe('the Xget entry responses', () => {
  it('serves the platform catalog at the root', async () => {
    const response = await call('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')

    const body = (await response.json()) as {
      name: string
      platformCount: number
      platforms: { key: string; prefix: string }[]
    }
    expect(body.name).toBe('Inkstone Xget')
    expect(body.platformCount).toBe(84)
    expect(body.platforms).toHaveLength(84)
    expect(body.platforms.find((platform) => platform.key === 'ip-openai')?.prefix).toBe('/ip/openai/')
  })

  it('answers illegal platforms with a 400 JSON body instead of a redirect', async () => {
    for (const path of ['/unknown/thing', '/gh', '/gh/']) {
      const response = await call(path)
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toContain('application/json')
      const body = (await response.json()) as { error: string }
      expect(body.error.length).toBeGreaterThan(0)
    }
  })

  it('answers the Docker version probe and does not add performance metrics to protocol responses', async () => {
    const response = await call('/v2/')
    expect(response.status).toBe(200)
    expect(response.headers.get('docker-distribution-api-version')).toBe('registry/2.0')
    expect(response.headers.get('x-performance-metrics')).toBeNull()
  })
})

describe('the Xget response rewriting', () => {
  it('rewrites npm metadata links through the proxy base', async () => {
    const body = JSON.stringify({
      tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
    })
    stubFetch(async () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(body).byteLength),
        },
      }),
    )

    const response = await call('/npm/left-pad')
    const text = await response.text()
    expect(text).toContain(`${PROXY_BASE}/npm/left-pad/-/left-pad-1.0.0.tgz`)
    expect(text).not.toContain('https://registry.npmjs.org/left-pad')
    expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(text).byteLength))
  })

  it('rewrites pypi HTML links through the proxy base', async () => {
    const body =
      '<a href="https://files.pythonhosted.org/packages/source/r/requests/requests-2.31.0.tar.gz">x</a>'
    stubFetch(async () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(new TextEncoder().encode(body).byteLength),
        },
      }),
    )

    const response = await call('/pypi/simple/requests/')
    const text = await response.text()
    expect(text).toContain(`${PROXY_BASE}/pypi/files/packages/source/r/requests/requests-2.31.0.tar.gz`)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rewrites flathub reference files through the proxy base', async () => {
    const body = 'Uri=https://dl.flathub.org/repo/appstream/org.example.App.flatpakref\n'
    stubFetch(async () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(new TextEncoder().encode(body).byteLength),
        },
      }),
    )

    const response = await call('/flathub/repo/org.example.App.flatpakref')
    const text = await response.text()
    expect(text).toContain(`${PROXY_BASE}/flathub/repo/appstream/org.example.App.flatpakref`)
  })

  it('streams responses larger than the rewrite limit unchanged', async () => {
    const body = JSON.stringify({ tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz' })
    stubFetch(async () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(9 * 1024 * 1024),
        },
      }),
    )

    const response = await call('/npm/left-pad')
    const text = await response.text()
    expect(text).toContain('https://registry.npmjs.org/left-pad')
    expect(text).not.toContain(`${PROXY_BASE}/npm/left-pad`)
  })
})

describe('the Xget header hygiene', () => {
  it('strips site, Cloudflare and hop-by-hop request headers while keeping credentials', async () => {
    let sentHeaders: Headers | null = null
    stubFetch(async (_input, init) => {
      sentHeaders = new Headers(init?.headers as Headers)
      return new Response('ok', {
        status: 200,
        headers: {
          'Set-Cookie': 'upstream=1',
          'Clear-Site-Data': '"*"',
          'Access-Control-Allow-Origin': 'https://registry.example',
        },
      })
    })

    const response = await call(
      '/gh/owner/repo/info/refs?service=git-upload-pack',
      {
        headers: {
          Cookie: 'session=secret',
          'X-Inkstone-Client': 'web',
          'X-Inkstone-Origin': 'https://app.example',
          'CF-Connecting-IP': '203.0.113.9',
          'CF-Ray': 'abc123',
          'X-Forwarded-For': '203.0.113.9',
          'X-Real-IP': '203.0.113.9',
          Connection: 'keep-alive',
          'Proxy-Authorization': 'Basic cHJveHk=',
          Authorization: 'Bearer upstream-secret',
          Origin: 'https://app.example',
          Range: 'bytes=0-1',
          'User-Agent': 'git/2.42.0',
          Accept: 'application/json',
        },
      },
    )

    const headers = sentHeaders as Headers | null
    expect(headers).not.toBeNull()
    for (const name of [
      'cookie',
      'x-inkstone-client',
      'x-inkstone-origin',
      'cf-connecting-ip',
      'cf-ray',
      'x-forwarded-for',
      'x-real-ip',
      'connection',
      'proxy-authorization',
    ]) {
      expect((headers as Headers).get(name)).toBeNull()
    }
    expect((headers as Headers).get('authorization')).toBe('Bearer upstream-secret')
    expect((headers as Headers).get('origin')).toBe('https://app.example')
    expect((headers as Headers).get('range')).toBe('bytes=0-1')
    expect((headers as Headers).get('user-agent')).toBe('git/2.42.0')

    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('clear-site-data')).toBeNull()
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('the Xget body limit', () => {
  it('rejects an oversized declared body with 413 before contacting upstream', async () => {
    const fetchMock = stubFetch(async () => new Response('nope', { status: 200 }))
    const response = await call('/gh/owner/repo/git-receive-pack', {
      method: 'POST',
      headers: { 'Content-Length': String(64 * 1024 * 1024 + 1) },
      body: 'x',
    })

    expect(response.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops a streamed body as soon as it crosses the limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abcdef'))
        controller.close()
      },
    })
    const request = new Request('https://proxy.example/gh/owner/repo/git-receive-pack', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)

    const result = await readRequestBodyWithinLimit(request, 3)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(413)
  })
})

describe('the Xget performance metrics', () => {
  it('adds a JSON metrics header to non-protocol responses', async () => {
    stubFetch(async () => new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }))
    const response = await call('/npm/react')

    const rawMetrics = response.headers.get('x-performance-metrics')
    expect(rawMetrics).not.toBeNull()
    const metrics = JSON.parse(rawMetrics as string) as Record<string, number>
    expect(metrics.complete).toBeTypeOf('number')
    expect(metrics.attempt_0).toBeTypeOf('number')
  })

  it('keeps the metrics header off protocol responses', async () => {
    stubFetch(async () => new Response('ok', { status: 200 }))
    const response = await call('/npm/react', {
      headers: { 'User-Agent': 'git/2.42.0' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-performance-metrics')).toBeNull()
  })
})

describe('the Docker authentication proxy', () => {
  it('returns 400 for an auth request without a registry target', async () => {
    const response = await call('/v2/auth')
    expect(response.status).toBe(400)
  })

  it('returns 502 for an invalid upstream challenge instead of an uncaught 500', async () => {
    stubFetch(async () =>
      new Response('{}', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer nonsense' },
      }),
    )

    const response = await call('/cr/docker/v2/auth?scope=repository:library/nginx:pull')
    expect(response.status).toBe(502)
  })

  it('returns 502 when the registry auth probe times out', async () => {
    stubFetch(
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
      '/cr/docker/v2/auth?scope=repository:library/nginx:pull',
      {},
      { TIMEOUT_SECONDS: 1 },
    )
    expect(response.status).toBe(502)
  })

  it('never echoes the upstream URL in an invalid challenge response', async () => {
    stubFetch(async () =>
      new Response('{}', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="https://user:pass@registry.example" service="x"' },
      }),
    )

    const response = await call('/cr/docker/v2/auth?scope=repository:library/nginx:pull')
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('user:pass')
  })
})

describe('the request body buffer helper', () => {
  it('returns the assembled body for reads under the limit', async () => {
    const result = await readRequestBodyWithinLimit(
      new Request('https://proxy.example/upload', { method: 'POST', body: 'abc' }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body).not.toBeNull()
      expect(new TextDecoder().decode(result.body as Uint8Array)).toBe('abc')
    }
  })

  it('reads the URL from the request passed to fetch', async () => {
    const fetchMock = stubFetch(async () => new Response('ok', { status: 200 }))
    await call('/npm/react')
    const [input] = fetchMock.mock.calls[0]
    expect(readUrl(input)).toBe('https://registry.npmjs.org/react')
  })
})

describe('the site cookie and the shared cache', () => {
  it('does not let the Inkstone session cookie turn a browser download private', async () => {
    const stored = new Map<string, Response>()
    const cache = {
      async match(request: Request) {
        return stored.get(request.url)
      },
      async put(request: Request, response: Response) {
        stored.set(request.url, response.clone())
      },
    }
    vi.stubGlobal('caches', { default: cache })
    const fetchMock = stubFetch(async () =>
      new Response('package', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const headers = { Cookie: 'inkstone_session=site-secret' }
    const first = await call('/npm/react', { headers })
    expect(first.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stored.size).toBe(1)
    const second = await call('/npm/react', { headers })
    expect(second.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
