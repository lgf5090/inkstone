// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createR2Driver } from '../src/worker/clouddrive/drivers/r2'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-r2',
    type: 'r2',
    config: {
      accountId: 'account-1',
      bucket: 'r2-bucket',
      region: 'auto',
      rootPath: '/',
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

function listXml(entries: string[], next?: string): string {
  return [
    '<ListBucketResult>',
    `<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>`,
    next ? `<NextContinuationToken>${next}</NextContinuationToken>` : '',
    ...entries,
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

describe('R2 driver', () => {
  it('always talks to the R2 S3 endpoint derived from accountId', async () => {
    let seen = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input))
      seen = url.toString()
      return new Response(listXml([contents('a.txt', 10)]))
    })
    const driver = createR2Driver(context())
    await driver.list('/')
    const url = new URL(seen)
    expect(url.host).toBe('account-1.r2.cloudflarestorage.com')
    expect(url.pathname).toBe('/r2-bucket')
    expect(url.searchParams.get('list-type')).toBe('2')
    expect(driver.definition.id).toBe('r2')
  })

  it('walks pages with continuation tokens', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input))
      if (url.searchParams.get('continuation-token') === 'next') {
        return new Response(listXml([contents('b.txt', 4)]))
      }
      return new Response(listXml([contents('a.txt', 1)], 'next'))
    })
    const driver = createR2Driver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('next')
    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.txt'])
    expect(second.cursor).toBeNull()
  })

  it('maps 403 to auth', async () => {
    vi.stubGlobal('fetch', async () => new Response('<Error><Message>denied</Message></Error>', { status: 403 }))
    const driver = createR2Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createR2Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found with the upstream message', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>',
      { status: 404 },
    ))
    const driver = createR2Driver(context())
    await expect(driver.read('/missing.txt')).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('missing'),
    })
  })

  it('passes upstream messages through', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '<Error><Message>r2 says no</Message></Error>',
      { status: 400 },
    ))
    const driver = createR2Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('r2 says no'),
    })
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createR2Driver(context())
    await expect(driver.list('/a/../b')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range and signs with SigV4', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input))
      expect(url.pathname).toBe('/r2-bucket/a.txt')
      expect(headersOf(init).get('range')).toBe('bytes=1-2')
      expect(headersOf(init).get('authorization')).toMatch(/^AWS4-HMAC-SHA256/)
      return new Response('bc', { status: 206 })
    })
    const driver = createR2Driver(context())
    const response = await driver.read('/a.txt', 'bytes=1-2')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bc')
  })

  it('copies and generates presigned links', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response('', { status: 200, headers: { 'content-length': '2' } })
      expect(headersOf(init).get('x-amz-copy-source')).toBe('r2-bucket/a.txt')
      return new Response('<CopyObjectResult/>')
    })
    const driver = createR2Driver(context())
    await driver.copy!('/a.txt', '/b.txt')
    const link = await driver.directLink!('/a.txt')
    expect(new URL(link!).searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(new URL(link!).host).toBe('account-1.r2.cloudflarestorage.com')
  })

  it('declares only real capabilities', () => {
    const driver = createR2Driver(context())
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.capabilities.share).toBe(false)
    expect((driver as unknown as Record<string, unknown>).share).toBeUndefined()
  })
})
