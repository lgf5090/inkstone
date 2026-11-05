// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAzureBlobDriver } from '../src/worker/clouddrive/drivers/azure_blob'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const ACCESS_KEY = 'c2VjcmV0'

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    accessKey: ACCESS_KEY,
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-azure',
    type: 'azure_blob',
    config: {
      endpoint: 'https://acct.blob.core.windows.net',
      containerName: 'cont',
      rootPath: '/',
      ...(overrides.config ?? {}),
    },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function blob(name: string, size: number): string {
  return [
    '<Blob>',
    `<Name>${name}</Name>`,
    '<Properties>',
    '<Last-Modified>Wed, 01 Jan 2026 00:00:00 GMT</Last-Modified>',
    `<Content-Length>${size}</Content-Length>`,
    '<Etag>"e"</Etag>',
    '</Properties>',
    '</Blob>',
  ].join('')
}

function listXml(options: { blobs?: string[]; prefixes?: string[]; marker?: string } = {}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<EnumerationResults>',
    '<Blobs>',
    ...(options.prefixes ?? []).map((prefix) => `<BlobPrefix><Name>${prefix}</Name></BlobPrefix>`),
    ...(options.blobs ?? []),
    '</Blobs>',
    options.marker ? `<NextMarker>${options.marker}</NextMarker>` : '',
    '</EnumerationResults>',
  ].join('')
}

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers)
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Azure Blob driver', () => {
  it('walks list pages with maxresults and marker', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input))
      urls.push(url.toString())
      expect(url.pathname).toBe('/cont')
      expect(url.searchParams.get('restype')).toBe('container')
      expect(url.searchParams.get('comp')).toBe('list')
      expect(url.searchParams.get('delimiter')).toBe('/')
      expect(url.searchParams.get('maxresults')).toBe('2')
      if (url.searchParams.get('marker') === 'm2') {
        return new Response(listXml({ prefixes: ['docs/'] }))
      }
      return new Response(listXml({ blobs: [blob('a.txt', 10)], marker: 'm2' }))
    })

    const driver = createAzureBlobDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('m2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(urls.filter((url) => url.includes('comp=list'))).toHaveLength(3)
  })

  it('maps 403 to auth', async () => {
    vi.stubGlobal('fetch', async () => new Response('AuthenticationFailed', { status: 403 }))
    const driver = createAzureBlobDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createAzureBlobDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found with the upstream message', async () => {
    vi.stubGlobal('fetch', async () => new Response('BlobNotFound', { status: 404 }))
    const driver = createAzureBlobDriver(context())
    await expect(driver.read('/missing.txt')).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('BlobNotFound'),
    })
  })

  it('passes upstream messages through', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad blob request', { status: 400 }))
    const driver = createAzureBlobDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('bad blob request'),
    })
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createAzureBlobDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range and signs with SharedKey', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/cont/a.txt')
      expect(init?.method).toBe('GET')
      expect(headersOf(init).get('range')).toBe('bytes=1-2')
      expect(headersOf(init).get('authorization')).toMatch(/^SharedKey acct:/)
      expect(headersOf(init).get('x-ms-version')).toBe('2021-08-06')
      return new Response('bc', { status: 206 })
    })
    const driver = createAzureBlobDriver(context())
    const response = await driver.read('/a.txt', 'bytes=1-2')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bc')
  })

  it('uploads a block blob and reports progress afterwards', async () => {
    const onProgress = vi.fn()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/cont/a.txt')
      expect(init?.method).toBe('PUT')
      expect(headersOf(init).get('x-ms-blob-type')).toBe('BlockBlob')
      expect(headersOf(init).get('content-type')).toBe('text/plain')
      expect(onProgress).not.toHaveBeenCalled()
      return new Response('', { status: 201 })
    })
    const driver = createAzureBlobDriver(context())
    await driver.upload('/a.txt', new Uint8Array([1, 2, 3]), {
      size: 3,
      contentType: 'text/plain',
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledWith(3, 3)
  })

  it('creates a directory as a zero-byte marker blob', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/cont/docs/')
      expect(init?.method).toBe('PUT')
      expect(headersOf(init).get('x-ms-blob-type')).toBe('BlockBlob')
      expect(headersOf(init).get('x-ms-meta-hdi_isfolder')).toBe('true')
      expect((init?.body as Uint8Array).byteLength).toBe(0)
      return new Response('', { status: 201 })
    })
    const driver = createAzureBlobDriver(context())
    await driver.mkdir('/docs')
  })

  it('copies a blob with x-ms-copy-source', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      calls.push(`${init?.method} ${url.pathname}`)
      if (init?.method === 'HEAD') {
        return new Response('', { status: 200, headers: { 'content-length': '10' } })
      }
      expect(url.pathname).toBe('/cont/b.txt')
      expect(headersOf(init).get('x-ms-copy-source')).toBe('https://acct.blob.core.windows.net/cont/a.txt')
      return new Response('', { status: 202 })
    })
    const driver = createAzureBlobDriver(context())
    await driver.copy!('/a.txt', '/b.txt')
    expect(calls).toEqual(['HEAD /cont/a.txt', 'PUT /cont/b.txt'])
  })

  it('detects a directory on stat from the list prefix', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      if (init?.method === 'HEAD') return new Response('', { status: 404 })
      expect(url.searchParams.get('prefix')).toBe('docs/')
      return new Response(listXml({ prefixes: ['docs/sub/'] }))
    })
    const driver = createAzureBlobDriver(context())
    const entry = await driver.stat('/docs')
    expect(entry.kind).toBe('folder')
    expect(entry.name).toBe('docs')
  })

  it('returns a SAS direct link', async () => {
    const driver = createAzureBlobDriver(context())
    const link = await driver.directLink!('/a.txt')
    const url = new URL(link!)
    expect(url.host).toBe('acct.blob.core.windows.net')
    expect(url.pathname).toBe('/cont/a.txt')
    expect(url.searchParams.get('sp')).toBe('r')
    expect(url.searchParams.get('sr')).toBe('b')
    expect(url.searchParams.get('sig')).toBeTruthy()
  })

  it('declares only real capabilities', () => {
    const driver = createAzureBlobDriver(context())
    expect(driver.copy).toBeTypeOf('function')
    expect(driver.capabilities.share).toBe(false)
    expect((driver as unknown as Record<string, unknown>).share).toBeUndefined()
  })
})
