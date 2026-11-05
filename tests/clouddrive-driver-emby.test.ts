// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmbyDriver } from '../src/worker/clouddrive/drivers/emby'
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
    apiKey: 'api-key',
    ...(overrides.credentials ?? {}),
  }
  const config: Record<string, unknown> = {
    url: 'https://emby.example',
    userId: 'u1',
    rootFolderId: '1',
    linkMethod: 'stream',
    ...(overrides.config ?? {}),
  }
  return {
    userId: overrides.userId ?? USER,
    storageId: overrides.storageId ?? STORAGE,
    type: overrides.type ?? 'emby',
    config,
    credentials,
    saveCredentials: overrides.saveCredentials ?? vi.fn(async () => undefined),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

const FOLDER = { Name: 'Movies', Id: 'folder-1', IsFolder: true, DateCreated: '2026-01-01T00:00:00Z' }
const FILE = { Name: 'movie.mp4', Id: 'file-1', IsFolder: false, Size: 100, DateCreated: '2026-01-02T00:00:00Z' }

function items(): Response {
  return json({ Items: [FOLDER, FILE], TotalRecordCount: 2 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Emby driver', () => {
  it('lists /Users/{userId}/Items without pagination', async () => {
    const calls = stubFetch((url) => {
      expect(url).toContain('/Users/u1/Items')
      expect(new URL(url).searchParams.get('ParentId')).toBe('1')
      expect(new URL(url).searchParams.get('api_key')).toBe('api-key')
      return items()
    })

    const driver = createEmbyDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['Movies', 'movie.mp4'])
    expect(result.entries[0]!.kind).toBe('folder')
    expect(result.entries[1]!.ref).toBe('file-1')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('marks the storage for re-authorization when an API key cannot be refreshed', async () => {
    const mark = vi.fn(async () => undefined)
    stubFetch(() => json({ message: 'unauthorized' }, 401))
    const driver = createEmbyDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to a rate-limit driver error', async () => {
    stubFetch(() => json({ message: 'slow down' }, 429))
    const driver = createEmbyDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    stubFetch(() => json({ message: 'gone' }, 404))
    const driver = createEmbyDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the upstream failure message', async () => {
    stubFetch(() => json({ message: 'server exploded' }, 500))
    const driver = createEmbyDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('server exploded'),
    })
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createEmbyDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('builds the stream link from MediaSources and forwards Range', async () => {
    stubFetch((url, init) => {
      if (url.includes('/Users/u1/Items?') && url.includes('ParentId=1')) return items()
      if (url.includes('/Users/u1/Items/file-1?')) {
        return json({ MediaSources: [{ Id: 'ms-1', Container: 'mp4', SupportsDirectStream: true }] })
      }
      if (url.startsWith('https://emby.example/Videos/file-1/stream.mp4')) {
        expect(new URL(url).searchParams.get('MediaSourceId')).toBe('ms-1')
        expect(new URL(url).searchParams.get('Static')).toBe('true')
        expect(new Headers(init.headers).get('Range')).toBe('bytes=0-5')
        return new Response('abcdef', { status: 206 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createEmbyDriver(context())
    const response = await driver.read('/movie.mp4', 'bytes=0-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcdef')
    expect(await driver.directLink!('/movie.mp4')).toBe(
      'https://emby.example/Videos/file-1/stream.mp4?api_key=api-key&MediaSourceId=ms-1&Static=true',
    )
  })

  it('uses /Items/{id}/Download when the link method is download', async () => {
    stubFetch((url) => {
      if (url.includes('/Users/u1/Items?')) return items()
      throw new Error(`unexpected ${url}`)
    })
    const driver = createEmbyDriver(context({ config: { linkMethod: 'download' } }))
    expect(await driver.directLink!('/movie.mp4')).toBe(
      'https://emby.example/Items/file-1/Download?api_key=api-key',
    )
  })

  it('has no write methods at all', async () => {
    const driver = createEmbyDriver(context())
    expect(driver.upload).toBeUndefined()
    expect(driver.mkdir).toBeUndefined()
    expect(driver.rename).toBeUndefined()
    expect(driver.move).toBeUndefined()
    expect(driver.remove).toBeUndefined()
    expect(driver.copy).toBeUndefined()
  })
})
