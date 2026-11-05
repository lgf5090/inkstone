// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuarkOpenDriver } from '../src/worker/clouddrive/drivers/quark-open'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const API = 'https://open-api-drive.quark.cn'
const LIST = `${API}/open/v1/file/list`
const RENEW = 'https://api.oplist.org/quarkyun/renewapi'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-quark-open',
  markNeedsReauth: DriverContext['markNeedsReauth'] = vi.fn(async () => undefined),
): DriverContext {
  const stored: Record<string, string> = {
    appId: 'app-1', signKey: 'sign-key', accessToken: 'valid', refreshToken: 'r1', ...credentials,
  }
  return {
    userId: 'user-a',
    storageId,
    type: 'quark_open',
    config: { rootFolderId: '0' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth,
  }
}

const FILE = { fid: 'f1', filename: 'a.txt', size: 10, file_type: '1', updated_at: 1767225600 }
const FOLDER = { fid: 'd1', filename: 'docs', size: 0, file_type: '0', updated_at: 1767312000 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Quark Open driver', () => {
  it('walks query-cursor pages and returns the requested page with its cursor', async () => {
    const calls: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(LIST)) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        calls.push(body)
        const cursor = body.query_cursor as { token?: string } | undefined
        return cursor?.token === 'c2'
          ? json({ status: 200, errno: 0, data: { file_list: [FOLDER], last_page: true } })
          : json({ status: 200, errno: 0, data: { file_list: [FILE], last_page: false, next_query_cursor: { token: 'c2' } } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createQuarkOpenDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toContain('c2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.truncated).toBe(false)
    expect(calls).toHaveLength(3)
    expect(calls[2]!.query_cursor).toEqual({ token: 'c2' })
  })

  it('marks the storage for re-authorization when the refresh token is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(RENEW)) return json({ text: 'refresh rejected' })
      if (url.startsWith(LIST)) return json({ status: -1, errno: 11001, error_info: 'token expired' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createQuarkOpenDriver(context({ accessToken: 'stale' }, 'storage-quark-auth', mark))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps a throttled list call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST)) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(createQuarkOpenDriver(context({}, 'storage-quark-429')).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an errno 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST)) return json({ status: 200, errno: 404, error_info: 'not found' })
      throw new Error(`unexpected ${url}`)
    })
    await expect(createQuarkOpenDriver(context({}, 'storage-quark-404')).stat('/missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createQuarkOpenDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes the token once when two requests race', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(RENEW)) {
        tokenCalls++
        return json({ access_token: 'a1', refresh_token: 'r2' })
      }
      if (url.startsWith(LIST)) return json({ status: 200, errno: 0, data: { file_list: [], last_page: true } })
      throw new Error(`unexpected ${url}`)
    })
    const first = createQuarkOpenDriver(context({ accessToken: '' }, 'storage-quark-race'))
    const second = createQuarkOpenDriver(context({ accessToken: '' }, 'storage-quark-race'))
    await Promise.all([first.list('/'), second.list('/')])
    expect(tokenCalls).toBe(1)
  })

  it('keeps mutations unsupported on the read-only mount', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createQuarkOpenDriver(context())
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
