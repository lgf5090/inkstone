// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBunnyStorageDriver } from '../src/worker/clouddrive/drivers/bunny_storage'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    accessKey: 'zone-key',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-bunny',
    type: 'bunny_storage',
    config: {
      storageZoneName: 'zone',
      endpoint: 'https://storage.bunnycdn.com',
      cdnBaseUrl: 'https://cdn.example.com',
      rootPath: '/',
      ...(overrides.config ?? {}),
    },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
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

function listing(): Response {
  return new Response(JSON.stringify([
    { ObjectName: 'a.txt', Length: 10, LastChanged: '2026-01-01T00:00:00Z', IsDirectory: false, Guid: 'g1' },
    { ObjectName: 'docs', Length: 0, LastChanged: '', IsDirectory: true, Guid: 'g2' },
    { ObjectName: '.openlist', Length: 0, LastChanged: '', IsDirectory: false, Guid: 'g3' },
  ]), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Bunny Storage driver', () => {
  it('lists a directory in one flat request and hides the placeholder', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/zone/')
      expect(headersOf(init).get('accesskey')).toBe('zone-key')
      return listing()
    })
    const driver = createBunnyStorageDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(result.entries[1]!.kind).toBe('folder')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('maps 401 to auth', async () => {
    vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }))
    const driver = createBunnyStorageDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createBunnyStorageDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found with the upstream message', async () => {
    vi.stubGlobal('fetch', async () => new Response('missing object', { status: 404 }))
    const driver = createBunnyStorageDriver(context())
    await expect(driver.read('/missing.txt')).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('missing object'),
    })
  })

  it('passes upstream messages through', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'bad zone' }), { status: 400 }))
    const driver = createBunnyStorageDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('bad zone'),
    })
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createBunnyStorageDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range on read', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/zone/a.txt')
      expect(init?.method).toBe('GET')
      expect(headersOf(init).get('range')).toBe('bytes=0-2')
      return new Response('abc', { status: 206 })
    })
    const driver = createBunnyStorageDriver(context())
    const response = await driver.read('/a.txt', 'bytes=0-2')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abc')
  })

  it('uploads a file and reports progress afterwards', async () => {
    const onProgress = vi.fn()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/zone/a.txt')
      expect(init?.method).toBe('PUT')
      expect(headersOf(init).get('accesskey')).toBe('zone-key')
      expect(headersOf(init).get('content-length')).toBe('3')
      expect(onProgress).not.toHaveBeenCalled()
      return new Response('', { status: 201 })
    })
    const driver = createBunnyStorageDriver(context())
    await driver.upload('/a.txt', new Uint8Array([1, 2, 3]), {
      size: 3,
      contentType: 'text/plain',
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledWith(3, 3)
  })

  it('creates a directory with a zero-byte placeholder', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/zone/docs/.openlist')
      expect(init?.method).toBe('PUT')
      expect((init?.body as Uint8Array).byteLength).toBe(0)
      return new Response('', { status: 201 })
    })
    const driver = createBunnyStorageDriver(context())
    await driver.mkdir('/docs')
  })

  it('copies and moves an object by streaming it between storage paths', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.pathname}`)
      if (url.pathname === '/zone/') return listing()
      if (method === 'GET' && url.pathname === '/zone/a.txt') {
        return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '5' } })
      }
      return new Response('', { status: 201 })
    })

    const driver = createBunnyStorageDriver(context())
    await driver.copy!('/a.txt', '/b.txt')
    await driver.move('/a.txt', '/c.txt')
    expect(calls).toEqual([
      'GET /zone/',
      'GET /zone/a.txt',
      'PUT /zone/b.txt',
      'GET /zone/',
      'GET /zone/a.txt',
      'PUT /zone/c.txt',
      'DELETE /zone/a.txt',
    ])
  })

  it('builds a CDN direct link, signed when a token key is configured', async () => {
    const plain = createBunnyStorageDriver(context())
    const plainLink = await plain.directLink!('/a.txt')
    expect(plainLink).toBe('https://cdn.example.com/a.txt')

    const signed = createBunnyStorageDriver(context({
      config: {
        storageZoneName: 'zone',
        endpoint: 'https://storage.bunnycdn.com',
        cdnBaseUrl: 'https://cdn.example.com',
        cdnTokenKey: 'cdn-secret',
        rootPath: '/',
      },
    }))
    const link = await signed.directLink!('/a.txt')
    const url = new URL(link!)
    expect(url.pathname).toBe('/a.txt')
    expect(url.searchParams.get('token')).toBeTruthy()
    expect(url.searchParams.get('expires')).toBeTruthy()
  })

  it('declares only real capabilities', () => {
    const driver = createBunnyStorageDriver(context())
    expect(driver.copy).toBeTypeOf('function')
    expect(driver.capabilities.share).toBe(false)
    expect((driver as unknown as Record<string, unknown>).share).toBeUndefined()
  })
})
