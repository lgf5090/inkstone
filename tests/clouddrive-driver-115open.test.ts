// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create115OpenDriver } from '../src/worker/clouddrive/drivers/115open'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const API = 'https://proapi.115.com'
const FILES = `${API}/open/ufile/files`
const TOKEN = 'https://passportapi.115.com/open/refreshToken'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-115-open',
  markNeedsReauth: DriverContext['markNeedsReauth'] = vi.fn(async () => undefined),
): DriverContext {
  const stored: Record<string, string> = { accessToken: 'valid', refreshToken: 'r1', ...credentials }
  return {
    userId: 'user-a',
    storageId,
    type: '115open',
    config: { rootId: '0' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth,
  }
}

const FILE = { fid: 'f1', fc: '1', fn: 'a.txt', fs: 10, upt: 1767225600, pc: 'pc1' }
const FOLDER = { fid: 'd1', fc: '0', fn: 'docs', fs: 0, upt: 1767312000 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('115 Open driver', () => {
  it('walks offset pages and returns the requested page with its cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(FILES)) {
        calls.push(url)
        const offset = new URL(url).searchParams.get('offset')
        return offset === '1'
          ? json({ state: true, code: 0, data: [FOLDER], count: 2 })
          : json({ state: true, code: 0, data: [FILE], count: 2 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = create115OpenDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('1')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.truncated).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('marks the storage for re-authorization when the refresh token is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) return json({ state: false, code: 1, message: 'bad refresh token' })
      if (url.startsWith(FILES)) return json({ state: false, code: 401, message: 'token expired' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create115OpenDriver(context({ accessToken: 'stale' }, 'storage-115-auth', mark))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps a throttled list call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(FILES)) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create115OpenDriver(context({}, 'storage-115-429')).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing object code to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(FILES)) return json({ state: false, code: 430004, message: 'not found' })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create115OpenDriver(context({}, 'storage-115-404')).stat('/missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(create115OpenDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes the token once when two requests race', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        return json({ state: true, code: 0, data: { access_token: 'a1', refresh_token: 'r2' } })
      }
      if (url.startsWith(FILES)) return json({ state: true, code: 0, data: [], count: 0 })
      throw new Error(`unexpected ${url}`)
    })
    const first = create115OpenDriver(context({ accessToken: '' }, 'storage-115-race'))
    const second = create115OpenDriver(context({ accessToken: '' }, 'storage-115-race'))
    await Promise.all([first.list('/'), second.list('/')])
    expect(tokenCalls).toBe(1)
  })

  it('keeps mutations unsupported on the read-only mount', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create115OpenDriver(context())
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
