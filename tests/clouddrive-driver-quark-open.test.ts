// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuarkOpenDriver } from '../src/worker/clouddrive/drivers/quark-open'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const API = 'https://open-api-drive.quark.cn'
const LIST = `${API}/open/v1/file/list`
const DIR = `${API}/open/v1/dir`
const RENAME = `${API}/open/v1/file/rename`
const MOVE = `${API}/open/v1/file/move`
const DELETE = `${API}/open/v1/file/delete`
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

  it('creates a folder through the signed dir endpoint', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith(DIR)) throw new Error(`unexpected ${url}`)
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return json({ status: 200, errno: 0, data: {} })
    })
    await createQuarkOpenDriver(context()).mkdir('/docs')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ dir_path: 'docs', pdir_fid: '0' })
  })

  it('renames an entry through the signed rename endpoint', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(LIST)) {
        return json({ status: 200, errno: 0, data: { file_list: [FILE, FOLDER], last_page: true } })
      }
      if (!url.startsWith(RENAME)) throw new Error(`unexpected ${url}`)
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return json({ status: 200, errno: 0, data: {} })
    })
    await createQuarkOpenDriver(context()).rename('/a.txt', 'b.txt')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ fid: 'f1', file_name: 'b.txt', conflict_mode: 'REUSE' })
  })

  it('moves an entry into the destination folder', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(LIST)) {
        return json({ status: 200, errno: 0, data: { file_list: [FILE, FOLDER], last_page: true } })
      }
      if (!url.startsWith(MOVE)) throw new Error(`unexpected ${url}`)
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return json({ status: 200, errno: 0, data: {} })
    })
    await createQuarkOpenDriver(context()).move('/a.txt', '/docs/a.txt')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ action_type: 1, fid_list: ['f1'], to_pdir_fid: 'd1' })
  })

  it('deletes an entry through the signed delete endpoint', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(LIST)) {
        return json({ status: 200, errno: 0, data: { file_list: [FILE, FOLDER], last_page: true } })
      }
      if (!url.startsWith(DELETE)) throw new Error(`unexpected ${url}`)
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return json({ status: 200, errno: 0, data: {} })
    })
    await createQuarkOpenDriver(context()).remove('/a.txt')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ action_type: 1, fid_list: ['f1'] })
  })

  it('maps a throttled write call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(DIR)) return new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(createQuarkOpenDriver(context()).mkdir('/docs')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a 401 on a write call to auth and marks the storage', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(RENEW)) return json({ text: 'refresh rejected' })
      if (url.startsWith(DIR)) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createQuarkOpenDriver(context({ accessToken: 'stale' }, 'storage-quark-write-auth', mark))
    await expect(driver.mkdir('/docs')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('refuses an escaping write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createQuarkOpenDriver(context())
    await expect(driver.mkdir('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.rename('/docs/../secret', 'b.txt')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.move('/docs/../secret', '/docs')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.remove('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps upload and copy unsupported', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createQuarkOpenDriver(context())
    expect(driver.capabilities).toMatchObject({
      write: false,
      mkdir: true,
      rename: true,
      move: true,
      copy: false,
      delete: true,
      directLink: false,
      range: true,
    })
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.copy!('/a.txt', '/b.txt')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
