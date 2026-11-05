// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudreveV4Driver } from '../src/worker/clouddrive/drivers/cloudreve_v4'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    token: 'tok-1',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'cloudreve_v4',
    config: { address: 'https://crv4.example.com', rootPath: '/root', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const PAGE_ONE = [
  { id: 'd1', name: 'sub', type: 1, size: 0, updated_at: '2026-01-02T00:00:00Z' },
  { id: 'f1', name: 'a.txt', type: 0, size: 5, updated_at: '2026-01-01T00:00:00Z' },
]
const PAGE_TWO = [{ id: 'f2', name: 'b.txt', type: 0, size: 7, updated_at: '2026-01-03T00:00:00Z' }]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Cloudreve V4 driver', () => {
  it('walks the cursor and returns the requested page with its next token', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      urls.push(url.toString())
      expect(url.pathname).toBe('/api/v4/file')
      expect(url.searchParams.get('uri')).toBe('/root/docs')
      return url.searchParams.get('next_page_token')
        ? json({ files: PAGE_TWO, pagination: { next_token: '' } })
        : json({ files: PAGE_ONE, pagination: { next_token: 'n1' } })
    })

    const driver = createCloudreveV4Driver(context())
    const first = await driver.list('/docs', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['sub', 'a.txt'])
    expect(first.entries[1]).toMatchObject({ kind: 'file', size: 5, ref: 'f1', mime: 'text/plain' })
    expect(first.cursor).toBe('n1')
    expect(first.truncated).toBe(true)
    expect(new URL(urls[0]!).searchParams.get('page_size')).toBe('2')

    const second = await driver.list('/docs', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.txt'])
    expect(second.cursor).toBeNull()
    expect(second.truncated).toBe(false)
    expect(new URL(urls[2]!).searchParams.get('next_page_token')).toBe('n1')
  })

  it('collects every page when no page is requested', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      return url.searchParams.get('next_page_token')
        ? json({ files: PAGE_TWO, pagination: { next_token: '' } })
        : json({ files: PAGE_ONE, pagination: { next_token: 'n1' } })
    })
    const driver = createCloudreveV4Driver(context())
    const result = await driver.list('/docs')
    expect(result.entries.map((entry) => entry.name)).toEqual(['sub', 'a.txt', 'b.txt'])
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('reports a failed sign-in as an auth error', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/v4/session')
      expect(String(init?.body)).toContain('"username":"u"')
      return json({ msg: 'wrong password' })
    })
    const driver = createCloudreveV4Driver(context({ credentials: { username: 'u', password: 'p', token: '' } }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps an unrecoverable 401 to auth after one retry and marks re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return new Response('expired', { status: 401 })
    })
    const driver = createCloudreveV4Driver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toBe(2)
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps 404, 429 and upstream error messages to driver errors', async () => {
    const driver = createCloudreveV4Driver(context())

    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429 }))
    const limited = await driver.list('/').catch((error: unknown) => error)
    expect(limited).toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => json({ msg: 'quota exceeded' }, 400))
    const upstream = await driver.list('/').catch((error: unknown) => error)
    expect(upstream).toMatchObject({ kind: 'upstream' })
    expect((upstream as Error).message).toContain('quota exceeded')
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createCloudreveV4Driver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves /file/url and forwards Range to the returned URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v4/file/url')) return json({ urls: [{ url: 'https://cdn.example/a.txt' }] })
      if (url.includes('/api/v4/file?')) return json({ files: PAGE_ONE, pagination: {} })
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-4')
        return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 2-4/5' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createCloudreveV4Driver(context())
    const response = await driver.read('/a.txt', 'bytes=2-4')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abc')
  })

  it('issues mkdir, rename, move, copy and delete through the file endpoints', async () => {
    const calls: Array<{ method: string; url: string; body: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: String(init?.method ?? 'GET'),
        url: String(input),
        body: String(init?.body ?? ''),
      })
      return json({})
    })
    const driver = createCloudreveV4Driver(context())

    await driver.mkdir('/new')
    await driver.rename('/a.txt', 'b.txt')
    await driver.move('/a.txt', '/sub/a.txt')
    await driver.copy!('/a.txt', '/sub/a.txt')
    await driver.remove('/a.txt')

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/v4/file/create',
      'POST /api/v4/file/rename',
      'POST /api/v4/file/move',
      'POST /api/v4/file/move',
      'DELETE /api/v4/file',
    ])
    expect(JSON.parse(calls[0]!.body)).toEqual({ type: 'folder', uri: '/root/new', error_on_conflict: true })
    expect(JSON.parse(calls[1]!.body)).toEqual({ uris: ['/root/a.txt'], new_uri: '/root/b.txt' })
    expect(JSON.parse(calls[2]!.body)).toEqual({ uris: ['/root/a.txt'], dst: '/root/sub', copy: false })
    expect(JSON.parse(calls[3]!.body)).toEqual({ uris: ['/root/a.txt'], dst: '/root/sub', copy: true })
    expect(JSON.parse(calls[4]!.body)).toEqual({ uris: ['/root/a.txt'], unlink: false, skip_soft_delete: true })
  })

  it('reports upload as unsupported and exposes no direct link', async () => {
    const driver = createCloudreveV4Driver(context())
    await expect(driver.upload('/a.txt', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    expect(driver.directLink).toBeUndefined()
    expect(driver.capabilities.directLink).toBe(false)
  })
})
