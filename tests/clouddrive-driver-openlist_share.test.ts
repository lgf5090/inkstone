// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenListShareDriver } from '../src/worker/clouddrive/drivers/openlist_share'
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
    pwd: 'share-pass',
    ...(overrides.credentials ?? {}),
  }
  const config: Record<string, unknown> = {
    url: 'https://openlist.example',
    sid: 'sid123',
    rootPath: '/lib',
    ...(overrides.config ?? {}),
  }
  return {
    userId: overrides.userId ?? USER,
    storageId: overrides.storageId ?? STORAGE,
    type: overrides.type ?? 'openlist_share',
    config,
    credentials,
    saveCredentials: overrides.saveCredentials ?? vi.fn(async () => undefined),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

const FILE_A = { name: 'a.txt', size: 10, is_dir: false, modified: '2026-01-01T00:00:00Z' }
const FILE_B = { name: 'b.pdf', size: 20, is_dir: false, modified: '2026-01-02T00:00:00Z' }
const FOLDER = { name: 'docs', size: 0, is_dir: true, modified: '2026-01-03T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OpenList share driver', () => {
  it('lists the share through /@s/{sid} with real page/per_page paging', async () => {
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/api/fs/list')) {
        const body = JSON.parse(String(init.body)) as { path: string; page: number; per_page: number; password: string }
        expect(body.path).toBe('/@s/sid123/lib')
        expect(body.password).toBe('share-pass')
        return body.page === 1
          ? json({ code: 200, data: { content: [FILE_A, FOLDER], total: 3 } })
          : json({ code: 200, data: { content: [FILE_B], total: 3 } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createOpenListShareDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)
    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.pdf'])
    expect(second.cursor).toBeNull()
    expect(calls.filter((call) => call.url.endsWith('/api/fs/list'))).toHaveLength(2)
  })

  it('marks the share for re-authorization when the password is rejected twice', async () => {
    const mark = vi.fn(async () => undefined)
    stubFetch((url) => {
      if (url.endsWith('/api/fs/list')) return json({ code: 401, message: 'wrong password' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListShareDriver(context({
      credentials: { pwd: 'wrong' },
      markNeedsReauth: mark,
    }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to a rate-limit driver error', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/fs/list')) return json({ message: 'slow down' }, 429)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/fs/list')) return json({ message: 'gone' }, 404)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the upstream failure message', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/fs/list')) return json({ code: 500, message: 'share is broken' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOpenListShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('share is broken'),
    })
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createOpenListShareDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves an entry from the parent listing and downloads through /sd', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/fs/list')) {
        expect(JSON.parse(String(init.body))).toMatchObject({ path: '/@s/sid123/lib' })
        return json({ code: 200, data: { content: [FILE_A], total: 1 } })
      }
      if (url.startsWith('https://openlist.example/sd/sid123/lib/a.txt')) {
        expect(new URL(url).searchParams.get('pwd')).toBe('share-pass')
        expect(new Headers(init.headers).get('Range')).toBe('bytes=1-2')
        return new Response('bc', { status: 206 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createOpenListShareDriver(context())
    const response = await driver.read('/a.txt', 'bytes=1-2')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bc')
    expect(await driver.directLink!('/a.txt')).toBe(
      'https://openlist.example/sd/sid123/lib/a.txt?pwd=share-pass',
    )
  })

  it('has no write methods at all', async () => {
    const driver = createOpenListShareDriver(context())
    expect(driver.upload).toBeUndefined()
    expect(driver.mkdir).toBeUndefined()
    expect(driver.rename).toBeUndefined()
    expect(driver.move).toBeUndefined()
    expect(driver.remove).toBeUndefined()
    expect(driver.copy).toBeUndefined()
  })
})
