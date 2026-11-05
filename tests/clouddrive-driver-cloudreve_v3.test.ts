// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudreveV3Driver } from '../src/worker/clouddrive/drivers/cloudreve_v3'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function envelope(data: unknown, code = 0, msg = ''): Response {
  return json({ code, msg, data })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    token: 'sess-1',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'cloudreve_v3',
    config: { address: 'https://cr.example.com', rootPath: '/root', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const OBJECTS = [
  { id: 'd1', name: 'sub', type: 'dir', size: 0, date: '2026-01-02T00:00:00Z' },
  { id: 'f1', name: 'a.txt', type: 'file', size: 5, date: '2026-01-01T00:00:00Z' },
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Cloudreve V3 driver', () => {
  it('lists a path-addressed directory and maps its objects', async () => {
    let seenUrl = ''
    let cookie = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      cookie = new Headers(init?.headers).get('Cookie') ?? ''
      return envelope({ parent: '/root', objects: OBJECTS })
    })

    const driver = createCloudreveV3Driver(context())
    const result = await driver.list('/docs')

    expect(new URL(seenUrl).pathname).toBe('/api/v3/directory/root/docs')
    expect(cookie).toBe('cloudreve-session=sess-1')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.entries).toEqual([
      { name: 'sub', kind: 'folder', size: 0, modifiedAt: Date.parse('2026-01-02T00:00:00Z'), ref: 'd1' },
      { name: 'a.txt', kind: 'file', size: 5, modifiedAt: Date.parse('2026-01-01T00:00:00Z'), ref: 'f1', mime: 'text/plain' },
    ])
  })

  it('reports a failed sign-in as an auth error with the upstream message', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      expect(new URL(String(input)).pathname).toBe('/api/v3/user/session')
      expect(String(init?.body)).toContain('"username":"u"')
      return json({ code: 400, msg: 'wrong password' })
    })
    const driver = createCloudreveV3Driver(context({ credentials: { username: 'u', password: 'p', token: '' } }))
    const error = await driver.list('/').catch((failure: unknown) => failure)
    expect(error).toMatchObject({ kind: 'auth' })
    expect((error as Error).message).toContain('wrong password')
    expect(calls).toBe(1)
  })

  it('maps an unrecoverable 401 to auth after one retry and marks re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return new Response('expired', { status: 401 })
    })
    const driver = createCloudreveV3Driver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toBe(2)
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps 404, 429 and JSON error codes to driver errors', async () => {
    const driver = createCloudreveV3Driver(context())

    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429 }))
    const limited = await driver.list('/').catch((error: unknown) => error)
    expect(limited).toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => envelope(null, 500, 'internal boom'))
    const upstream = await driver.list('/').catch((error: unknown) => error)
    expect(upstream).toMatchObject({ kind: 'upstream' })
    expect((upstream as Error).message).toContain('internal boom')
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createCloudreveV3Driver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves a download id and forwards Range to the returned URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v3/directory/root')) return envelope({ objects: OBJECTS })
      if (url.includes('/api/v3/file/download/f1')) {
        expect(init?.method).toBe('PUT')
        return envelope('https://cdn.example/a.txt')
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-1')
        return new Response('ab', { status: 206, headers: { 'content-range': 'bytes 0-1/5' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createCloudreveV3Driver(context())
    const response = await driver.read('/a.txt', 'bytes=0-1')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('ab')
  })

  it('issues mkdir, rename, move, copy and delete through the object endpoints', async () => {
    const calls: Array<{ method: string; url: string; body: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET')
      calls.push({ method, url: String(input), body: String(init?.body ?? '') })
      if (method === 'GET') return envelope({ objects: OBJECTS })
      return envelope({})
    })
    const driver = createCloudreveV3Driver(context())

    await driver.mkdir('/new')
    await driver.rename('/a.txt', 'b.txt')
    await driver.move('/a.txt', '/sub/a.txt')
    await driver.copy!('/a.txt', '/sub/a.txt')
    await driver.remove('/a.txt')

    const writes = calls.filter((call) => !call.url.includes('/directory/'))
    expect(writes.map((call) => call.method)).toEqual(['PUT', 'PATCH', 'PATCH', 'POST', 'DELETE'])
    expect(JSON.parse(writes[0]!.body)).toEqual({ path: '/root/new' })
    expect(JSON.parse(writes[1]!.body)).toMatchObject({ action: 'rename', new_name: 'b.txt', src: { items: ['f1'] } })
    expect(JSON.parse(writes[2]!.body)).toMatchObject({
      action: 'move',
      src_dir: '/root',
      dst: '/root/sub',
      src: { items: ['f1'] },
    })
    expect(JSON.parse(writes[3]!.body)).toMatchObject({ src_dir: '/root', dst: '/root/sub', src: { items: ['f1'] } })
    expect(JSON.parse(writes[4]!.body)).toEqual({ dirs: [], items: ['f1'] })
  })

  it('reports upload as unsupported and exposes no direct link', async () => {
    const driver = createCloudreveV3Driver(context())
    await expect(driver.upload('/a.txt', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    expect(driver.directLink).toBeUndefined()
    expect(driver.capabilities.directLink).toBe(false)
  })
})
