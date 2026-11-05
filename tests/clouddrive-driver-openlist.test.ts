// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenListDriver } from '../src/worker/clouddrive/drivers/openlist'
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
    token: 'valid-token',
    password: 'secret',
    ...(overrides.credentials ?? {}),
  }
  const config: Record<string, unknown> = {
    url: 'https://openlist.example',
    username: 'owner',
    metaPassword: 'meta',
    rootPath: '/drive',
    ...(overrides.config ?? {}),
  }
  return {
    userId: overrides.userId ?? USER,
    storageId: overrides.storageId ?? STORAGE,
    type: overrides.type ?? 'openlist',
    config,
    credentials,
    saveCredentials: overrides.saveCredentials ?? vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

const FILE_A = { name: 'a.txt', size: 10, is_dir: false, modified: '2026-01-01T00:00:00Z' }
const FILE_B = { name: 'b.pdf', size: 20, is_dir: false, modified: '2026-01-02T00:00:00Z' }
const FOLDER = { name: 'docs', size: 0, is_dir: true, modified: '2026-01-03T00:00:00Z' }

function me(): Response {
  return json({ code: 200, data: { username: 'owner' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OpenList driver', () => {
  it('pages through /api/fs/list and sends the Meta-Password header', async () => {
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) {
        expect(new Headers(init.headers).get('Meta-Password')).toBe('meta')
        const body = JSON.parse(String(init.body)) as { path: string; page: number; per_page: number }
        expect(body.path).toBe('/drive')
        return body.page === 1
          ? json({ code: 200, data: { content: [FILE_A, FOLDER], total: 3 } })
          : json({ code: 200, data: { content: [FILE_B], total: 3 } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createOpenListDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)
    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.pdf'])
    expect(second.cursor).toBeNull()
    expect(calls.filter((call) => call.url.endsWith('/api/fs/list'))).toHaveLength(2)
  })

  it('marks the storage for re-authorization when the token cannot be refreshed', async () => {
    const mark = vi.fn(async () => undefined)
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) return json({ code: 401, message: 'token expired' })
      if (url.endsWith('/api/auth/login')) return json({ code: 401, message: 'bad credentials' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListDriver(context({
      credentials: { token: 'expired', password: 'wrong' },
      markNeedsReauth: mark,
    }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to a rate-limit driver error', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) return json({ message: 'slow down' }, 429)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/get')) return json({ message: 'missing' }, 404)
      if (url.endsWith('/api/fs/list')) return json({ message: 'missing' }, 404)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListDriver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('treats a directory as an entry when /api/fs/get does not answer', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/get')) return json({ code: 404, message: 'not a file' })
      if (url.endsWith('/api/fs/list')) return json({ code: 200, data: { content: [FOLDER], total: 1 } })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListDriver(context())
    const entry = await driver.stat('/docs')
    expect(entry.kind).toBe('folder')
    expect(entry.name).toBe('docs')
  })

  it('keeps the upstream failure message', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) return json({ code: 500, message: 'disk broken' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('disk broken'),
    })
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createOpenListDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.remove('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes raw_url through directLink and Range through read', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/get')) {
        const body = JSON.parse(String(init.body)) as { path: string }
        if (body.path === '/drive/folder') {
          return json({ code: 200, data: { name: 'folder', size: 0, is_dir: true } })
        }
        return json({
          code: 200,
          data: { name: 'a.txt', size: 10, is_dir: false, modified: '2026-01-01T00:00:00Z', raw_url: 'https://cdn.example/a.txt' },
        })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init.headers).get('Range')).toBe('bytes=0-3')
        return new Response('abcd', { status: 206, headers: { 'content-range': 'bytes 0-3/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createOpenListDriver(context())
    const response = await driver.read('/a.txt', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcd')
    expect(await driver.directLink!('/a.txt')).toBe('https://cdn.example/a.txt')
    expect(await driver.directLink!('/folder')).toBeNull()
  })

  it('reports a direct put as unsupported instead of pretending it succeeded', async () => {
    const driver = createOpenListDriver(context())
    await expect(driver.upload('/a.bin', new Uint8Array([1]), { size: 1 }))
      .rejects.toMatchObject({ kind: 'unsupported' })
  })
})
