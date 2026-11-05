// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUssDriver } from '../src/worker/clouddrive/drivers/uss'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    operatorPassword: 'secret',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-uss',
    type: 'uss',
    config: {
      bucket: 'upyun-bucket',
      endpoint: 'https://cdn.example.com',
      operatorName: 'operator',
      rootPath: '/',
      ...(overrides.config ?? {}),
    },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers)
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Upyun USS driver', () => {
  it('walks list pages with x-list-iter and x-list-limit', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      urls.push(url)
      expect(new URL(url).pathname).toBe('/upyun-bucket/')
      expect(headersOf(init).get('authorization')).toMatch(/^UPYUN operator:/)
      expect(headersOf(init).get('date')).toBeTruthy()
      expect(headersOf(init).get('x-list-limit')).toBe('2')
      if (headersOf(init).get('x-list-iter') === 'iter-2') {
        return json([{ name: 'b.txt', type: 'N', length: 20, last_modified: 1700000000 }])
      }
      return json(
        [
          { name: 'a.txt', type: 'N', length: 10, last_modified: 1700000000 },
          { name: 'docs', type: 'F' },
        ],
        { 'x-upyun-list-iter': 'iter-2' },
      )
    })

    const driver = createUssDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(first.entries[1]!.kind).toBe('folder')
    expect(first.cursor).toBe('iter-2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.txt'])
    expect(second.cursor).toBeNull()
    expect(urls).toHaveLength(3)
  })

  it('maps 403 to auth', async () => {
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }))
    const driver = createUssDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createUssDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found with the upstream message', async () => {
    vi.stubGlobal('fetch', async () => new Response('file not found', { status: 404 }))
    const driver = createUssDriver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('file not found'),
    })
  })

  it('passes upstream messages through', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'bad listing' }), { status: 400 }))
    const driver = createUssDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('bad listing'),
    })
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createUssDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range on read', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/upyun-bucket/a.txt')
      expect(init?.method).toBe('GET')
      expect(headersOf(init).get('range')).toBe('bytes=0-1')
      return new Response('ab', { status: 206, headers: { 'content-range': 'bytes 0-1/10' } })
    })
    const driver = createUssDriver(context())
    const response = await driver.read('/a.txt', 'bytes=0-1')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('ab')
  })

  it('uploads with a Content-MD5 and reports progress afterwards', async () => {
    const onProgress = vi.fn()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/upyun-bucket/a.txt')
      expect(init?.method).toBe('PUT')
      expect(headersOf(init).get('content-md5')).toBe('5289df737df57326fcdd22597afb1fac')
      expect(headersOf(init).get('content-type')).toBe('text/plain')
      expect(onProgress).not.toHaveBeenCalled()
      return new Response('', { status: 200 })
    })
    const driver = createUssDriver(context())
    await driver.upload('/a.txt', new Uint8Array([1, 2, 3]), {
      size: 3,
      contentType: 'text/plain',
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledWith(3, 3)
  })

  it('creates a directory with the Folder header', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/upyun-bucket/docs/')
      expect(init?.method).toBe('POST')
      expect(headersOf(init).get('folder')).toBe('true')
      return new Response('', { status: 200 })
    })
    const driver = createUssDriver(context())
    await driver.mkdir('/docs')
  })

  it('moves and copies files with the Upyun source headers', async () => {
    const calls: Array<{ method: string; url: string; source: string | null }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: new URL(requestUrl(input)).pathname,
        source: headersOf(init).get('x-upyun-move-source') ?? headersOf(init).get('x-upyun-copy-source'),
      })
      return new Response('', { status: 200 })
    })
    const driver = createUssDriver(context())
    await driver.move('/a.txt', '/b.txt')
    await driver.copy!('/c.txt', '/d.txt')
    expect(calls).toEqual([
      { method: 'PUT', url: '/upyun-bucket/b.txt', source: '/upyun-bucket/a.txt' },
      { method: 'PUT', url: '/upyun-bucket/d.txt', source: '/upyun-bucket/c.txt' },
    ])
  })

  it('builds an anti-theft direct link', async () => {
    const driver = createUssDriver(context())
    const link = await driver.directLink!('/a.txt')
    const url = new URL(link!)
    expect(url.origin).toBe('https://cdn.example.com')
    expect(url.pathname).toBe('/a.txt')
    expect(url.searchParams.get('_upd')).toBe('a.txt')
    expect(url.searchParams.get('_upt')).toBeTruthy()
  })

  it('declares only real capabilities', () => {
    const driver = createUssDriver(context())
    expect(driver.copy).toBeTypeOf('function')
    expect(driver.capabilities.share).toBe(false)
    expect((driver as unknown as Record<string, unknown>).share).toBeUndefined()
  })
})
