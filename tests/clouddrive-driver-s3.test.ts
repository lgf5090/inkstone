// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createS3Driver } from '../src/worker/clouddrive/drivers/s3'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: USER,
    storageId: STORAGE,
    type: 's3',
    config: {
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      region: 'auto',
      rootPath: '/',
      pathStyle: true,
      ...(overrides.config ?? {}),
    },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function contents(key: string, size: number): string {
  return `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>"e"</ETag><Size>${size}</Size></Contents>`
}

function listXml(options: {
  contents?: string[]
  prefixes?: string[]
  truncated?: boolean
  next?: string
  nextMarker?: string
} = {}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListBucketResult>',
    `<IsTruncated>${options.truncated ? 'true' : 'false'}</IsTruncated>`,
    options.next ? `<NextContinuationToken>${options.next}</NextContinuationToken>` : '',
    options.nextMarker ? `<NextMarker>${options.nextMarker}</NextMarker>` : '',
    ...(options.contents ?? []),
    ...(options.prefixes ?? []).map((prefix) => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`),
    '</ListBucketResult>',
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

describe('S3 driver', () => {
  it('walks ListObjectsV2 pages and returns the real continuation cursor', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input))
      urls.push(url.toString())
      const token = url.searchParams.get('continuation-token')
      if (token === 'tok2') {
        return new Response(listXml({ prefixes: ['docs/'] }), { status: 200 })
      }
      expect(url.searchParams.get('list-type')).toBe('2')
      expect(url.searchParams.get('delimiter')).toBe('/')
      return new Response(listXml({
        contents: [contents('a.txt', 10), contents('b.pdf', 20)],
        truncated: true,
        next: 'tok2',
      }), { status: 200 })
    })

    const driver = createS3Driver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('tok2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(urls.filter((url) => url.includes('list-type=2'))).toHaveLength(3)
  })

  it('walks ListObjects v1 pages with a marker when configured', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input))
      expect(url.searchParams.has('list-type')).toBe(false)
      if (url.searchParams.get('marker') === 'a.txt') {
        return new Response(listXml({ contents: [contents('b.txt', 2)] }))
      }
      return new Response(listXml({
        contents: [contents('a.txt', 1)],
        truncated: true,
        nextMarker: 'a.txt',
      }))
    })
    const driver = createS3Driver(context({ config: {
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      region: 'auto',
      rootPath: '/',
      pathStyle: true,
      listObjectVersion: 'v1',
    } }))
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('a.txt')
    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.txt'])
    expect(second.cursor).toBeNull()
  })

  it('maps 403 to an auth driver error', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
      { status: 403 },
    ))
    const driver = createS3Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to a rate-limit driver error', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createS3Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found and keeps the upstream message', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '<Error><Code>NoSuchKey</Code><Message>missing key</Message></Error>',
      { status: 404 },
    ))
    const driver = createS3Driver(context())
    await expect(driver.read('/missing.txt')).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('missing key'),
    })
  })

  it('passes an upstream error message through', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '<Error><Code>InvalidRequest</Code><Message>bad prefix</Message></Error>',
      { status: 400 },
    ))
    const driver = createS3Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('bad prefix'),
    })
  })

  it('rejects a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createS3Driver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range on read and returns the 206 upstream response', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      expect(url).toContain('/bucket/a.txt')
      expect(init?.method).toBe('GET')
      expect(headersOf(init).get('range')).toBe('bytes=0-3')
      expect(headersOf(init).get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//)
      return new Response('abcd', {
        status: 206,
        headers: { 'content-range': 'bytes 0-3/10', 'content-length': '4' },
      })
    })

    const driver = createS3Driver(context())
    const response = await driver.read('/a.txt', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcd')
  })

  it('uploads a small object with one PUT and reports progress afterwards', async () => {
    const onProgress = vi.fn()
    let seen = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      expect(url).toContain('/bucket/small.txt')
      expect(init?.method).toBe('PUT')
      expect(headersOf(init).get('content-type')).toBe('text/plain')
      expect(onProgress).not.toHaveBeenCalled()
      seen = true
      return new Response('', { status: 200 })
    })

    const driver = createS3Driver(context())
    await driver.upload('/small.txt', new Uint8Array([1, 2, 3]), {
      size: 3,
      contentType: 'text/plain',
      onProgress,
    })
    expect(seen).toBe(true)
    expect(onProgress).toHaveBeenCalledWith(3, 3)
  })

  it('uploads a large object as multipart and completes it', async () => {
    const size = 8 * 1024 * 1024 + 1
    const bytes = new Uint8Array(size)
    const partNumbers: string[] = []
    let completed = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      if (url.searchParams.has('uploads')) {
        expect(init?.method).toBe('POST')
        return new Response('<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>')
      }
      if (url.searchParams.get('uploadId') === 'up-1' && init?.method === 'POST') {
        completed = true
        return new Response('<CompleteMultipartUploadResult/>')
      }
      if (url.searchParams.has('partNumber')) {
        partNumbers.push(url.searchParams.get('partNumber')!)
        expect(init?.method).toBe('PUT')
        return new Response('', { status: 200, headers: { etag: `"etag-${partNumbers.length}"` } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const onProgress = vi.fn()
    const driver = createS3Driver(context())
    await driver.upload('/big.bin', bytes, { size, onProgress })
    expect(partNumbers).toEqual(['1', '2'])
    expect(completed).toBe(true)
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith(size, size)
  })

  it('creates a directory with a zero-byte placeholder object', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      expect(url).toContain('/bucket/docs/.openlist')
      expect(init?.method).toBe('PUT')
      expect((init?.body as Uint8Array).byteLength).toBe(0)
      return new Response('', { status: 200 })
    })
    const driver = createS3Driver(context())
    await driver.mkdir('/docs')
  })

  it('copies an object with a server-side COPY request', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      calls.push(`${init?.method} ${url}`)
      if (init?.method === 'HEAD') {
        return new Response('', { status: 200, headers: { 'content-length': '5', etag: '"e"' } })
      }
      expect(init?.method).toBe('PUT')
      expect(headersOf(init).get('x-amz-copy-source')).toBe('bucket/a.txt')
      return new Response('<CopyObjectResult/>')
    })
    const driver = createS3Driver(context())
    await driver.copy!('/a.txt', '/b.txt')
    expect(calls.some((call) => call.startsWith('HEAD '))).toBe(true)
    expect(calls.some((call) => call.startsWith('PUT '))).toBe(true)
  })

  it('detects a directory on stat when HEAD misses and the prefix has contents', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      if (init?.method === 'HEAD') return new Response('', { status: 404 })
      expect(url.searchParams.get('prefix')).toBe('docs/')
      return new Response(listXml({ prefixes: ['docs/sub/'] }))
    })
    const driver = createS3Driver(context())
    const entry = await driver.stat('/docs')
    expect(entry.kind).toBe('folder')
    expect(entry.name).toBe('docs')
  })

  it('returns a presigned direct link', async () => {
    const driver = createS3Driver(context())
    const link = await driver.directLink!('/a.txt')
    expect(link).toBeTruthy()
    const url = new URL(link!)
    expect(url.host).toBe('s3.example.com')
    expect(url.pathname).toBe('/bucket/a.txt')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })

  it('does not expose capabilities it does not implement', () => {
    const driver = createS3Driver(context())
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.capabilities.directLink).toBe(true)
    expect(driver.capabilities.share).toBe(false)
    expect((driver as unknown as Record<string, unknown>).share).toBeUndefined()
    expect(driver.copy).toBeTypeOf('function')
  })
})
