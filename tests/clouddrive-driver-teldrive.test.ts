// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTeldriveDriver } from '../src/worker/clouddrive/drivers/teldrive'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

function stubFetch(handler: FetchHandler) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const options = init ?? {}
    calls.push({ url, init: options })
    return await handler(url, options)
  })
  return calls
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    accessToken: 'jwt-token',
    ...(overrides.credentials ?? {}),
  }
  const config: Record<string, unknown> = {
    url: 'https://teldrive.example',
    rootPath: '/drive',
    ...(overrides.config ?? {}),
  }
  return {
    userId: overrides.userId ?? USER,
    storageId: overrides.storageId ?? STORAGE,
    type: overrides.type ?? 'teldrive',
    config,
    credentials,
    saveCredentials: overrides.saveCredentials ?? vi.fn(async () => undefined),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

const FOLDER = { id: 'folder-1', name: 'docs', type: 'folder', createdAt: '2026-01-01T00:00:00Z' }
const FILE = { id: 'file-1', name: 'a.bin', type: 'file', size: 7, updatedAt: '2026-01-02T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TelDrive driver', () => {
  it('lists with a Bearer token and prefixes the mount root', async () => {
    const calls = stubFetch((url, init) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jwt-token')
      expect(new URL(url).searchParams.get('path')).toBe('/drive')
      return json([FOLDER, FILE])
    })

    const driver = createTeldriveDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['docs', 'a.bin'])
    expect(result.entries[0]!.kind).toBe('folder')
    expect(result.entries[1]!.ref).toBe('file-1')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('marks the storage for re-authorization when the token is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    stubFetch(() => json({ message: 'unauthorized' }, 401))
    const driver = createTeldriveDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to a rate-limit driver error', async () => {
    stubFetch(() => json({ message: 'slow down' }, 429))
    const driver = createTeldriveDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    stubFetch(() => json({ message: 'gone' }, 404))
    const driver = createTeldriveDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the upstream failure message', async () => {
    stubFetch(() => json({ message: 'telegram is rate limited' }, 400))
    const driver = createTeldriveDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('telegram is rate limited'),
    })
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createTeldriveDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exposes the direct download URL and forwards Range to it', async () => {
    stubFetch((url, init) => {
      if (url.startsWith('https://teldrive.example/api/files?path=')) {
        expect(new URL(url).searchParams.get('path')).toBe('/drive')
        return json([FILE])
      }
      if (url === 'https://teldrive.example/api/files/file-1') {
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jwt-token')
        expect(new Headers(init.headers).get('Range')).toBe('bytes=1-3')
        return new Response('abc', { status: 206 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createTeldriveDriver(context())
    const response = await driver.read('/a.bin', 'bytes=1-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abc')
    expect(await driver.directLink!('/a.bin')).toBe('https://teldrive.example/api/files/file-1')
  })

  it('creates folders and removes entries through their native ids', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    stubFetch((url, init) => {
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null })
      if (url.includes('/api/files?path=')) return json([FOLDER, FILE])
      if (url.endsWith('/api/files/mkdir')) return json({})
      return new Response('', { status: 200 })
    })

    const driver = createTeldriveDriver(context())
    await driver.mkdir('/new-folder')
    await driver.remove('/a.bin')

    expect(requests.find((request) => request.url.endsWith('/api/files/mkdir'))).toMatchObject({
      method: 'POST',
      body: { path: '/drive/new-folder' },
    })
    expect(requests.find((request) => request.method === 'DELETE')).toMatchObject({
      url: 'https://teldrive.example/api/files/file-1',
    })
  })

  it('has no rename, copy or upload capability', async () => {
    const driver = createTeldriveDriver(context())
    expect(driver.rename).toBeUndefined()
    expect(driver.copy).toBeUndefined()
    expect(driver.upload).toBeUndefined()
  })
})
