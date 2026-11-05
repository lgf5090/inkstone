// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBaiduNetdiskDriver } from '../src/worker/clouddrive/drivers/baidu-netdisk'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'
const LIST_URL = 'https://pan.baidu.com/api/list'
const FILE_METAS_URL = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function tokenResponse(): Response {
  return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
}

function context(credentials: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const stored: Record<string, string> = {
    clientId: 'client-1',
    clientSecret: 'secret',
    refreshToken: 'r1',
    accessToken: 'a0',
    expiresAt: '0',
    ...credentials,
  }
  const saveCredentials = vi.fn(async (patch: Record<string, string>) => {
    Object.assign(stored, patch)
    return { ...stored }
  })
  const markNeedsReauth = vi.fn(async (_message: string) => undefined)
  const ctx: DriverContext = {
    userId: 'user-a',
    storageId: 'storage-bd',
    type: 'baidu_netdisk',
    config: { downloadApi: 'official', ...config },
    credentials: stored,
    saveCredentials,
    markNeedsReauth,
  }
  return { ctx, saveCredentials, markNeedsReauth, stored }
}

const FILE = {
  fs_id: 1,
  path: '/a.txt',
  server_filename: 'a.txt',
  size: 10,
  isdir: 0,
  server_mtime: 1767225600,
}
const FOLDER = {
  fs_id: 2,
  path: '/docs',
  server_filename: 'docs',
  size: 0,
  isdir: 1,
  server_mtime: 1767312000,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Baidu Netdisk driver', () => {
  it('walks list pages and returns the requested page plus its cursor', async () => {
    const listCalls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.origin + url.pathname === LIST_URL) {
        const params = Object.fromEntries(url.searchParams.entries())
        listCalls.push(params)
        const start = Number(params.start)
        if (start === 0) return json({ errno: 0, list: [FILE, FOLDER] })
        if (start === 2) return json({ errno: 0, list: [FILE] })
        return json({ errno: 0, list: [] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const { ctx } = context()
    const driver = createBaiduNetdiskDriver(ctx)
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(first.entries[1]!.kind).toBe('folder')
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(second.cursor).toBeNull()
    expect(second.truncated).toBe(false)

    listCalls.length = 0
    const all = await driver.list('/', { pageSize: 2 })
    expect(all.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs', 'a.txt'])
    expect(all.cursor).toBeNull()
    expect(all.truncated).toBe(false)
    expect(listCalls.map((params) => params.start)).toEqual(['0', '2'])
    expect(listCalls[0]!.root).toBe('1')
  })

  it('refreshes a rejected access token once', async () => {
    let listCalls = 0
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) {
        listCalls++
        if (listCalls === 1) return json({ errno: -6 })
        return json({ errno: 0, list: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, markNeedsReauth } = context({
      accessToken: 'expired',
      expiresAt: String(Date.now() + 3_600_000),
    })
    const result = await createBaiduNetdiskDriver(ctx).list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(listCalls).toBe(2)
    expect(markNeedsReauth).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when the refresh fails', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return json({ error: 'invalid_grant' }, 400)
      if (url.startsWith(LIST_URL)) {
        listCalls++
        return json({ errno: 0, list: [] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, markNeedsReauth } = context({ accessToken: '' })
    await expect(createBaiduNetdiskDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(markNeedsReauth).toHaveBeenCalled()
    expect(listCalls).toBe(0)
  })

  it('maps a throttled listing to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST_URL)) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(createBaiduNetdiskDriver(context().ctx).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing folder to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST_URL)) return json({ message: 'not found' }, 404)
      throw new Error(`unexpected ${url}`)
    })
    await expect(createBaiduNetdiskDriver(context().ctx).list('/docs')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createBaiduNetdiskDriver(context().ctx).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range to the official dlink', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) return json({ errno: 0, list: [FILE] })
      if (parsed.origin + parsed.pathname === FILE_METAS_URL) {
        return json({ errno: 0, list: [{ dlink: 'https://dlink.example/f1?fid=1' }] })
      }
      if (url.startsWith('https://dlink.example/f1')) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createBaiduNetdiskDriver(context().ctx)
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('turns a refused dlink into auth and marks the storage', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) return json({ errno: 0, list: [FILE] })
      if (parsed.origin + parsed.pathname === FILE_METAS_URL) {
        return json({ errno: 0, list: [{ dlink: 'https://dlink.example/f1?fid=1' }] })
      }
      if (url.startsWith('https://dlink.example/f1')) return new Response('', { status: 403 })
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, markNeedsReauth } = context()
    await expect(createBaiduNetdiskDriver(ctx).read('/a.txt')).rejects.toMatchObject({ kind: 'auth' })
    expect(markNeedsReauth).toHaveBeenCalled()
  })

  it('returns the resolved temporary address from directLink', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) return json({ errno: 0, list: [FILE] })
      if (parsed.origin + parsed.pathname === FILE_METAS_URL) {
        return json({ errno: 0, list: [{ dlink: 'https://dlink.example/f1?fid=1' }] })
      }
      if (url.startsWith('https://dlink.example/f1')) {
        expect(init?.method).toBe('HEAD')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://dl.example/signed?sign=abc&access_token=secret' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    const address = await createBaiduNetdiskDriver(context().ctx).directLink!('/a.txt')
    expect(address).toBe('https://dl.example/signed?sign=abc')
  })

  it('refreshes concurrently through one token request', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      if (url.startsWith(LIST_URL)) return json({ errno: 0, list: [FILE] })
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, saveCredentials } = context({
      accessToken: 'stale',
      expiresAt: String(Date.now()),
    })
    const driver = createBaiduNetdiskDriver(ctx)
    await Promise.all([driver.list('/'), driver.list('/')])
    expect(tokenCalls).toBe(1)
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'a1' }),
      { expect: { accessToken: 'stale', refreshToken: 'r1' } },
    )
  })

  it('declares read-only capabilities and refuses writes', async () => {
    const driver = createBaiduNetdiskDriver(context().ctx)
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.mkdir('/x')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/x', new Uint8Array(), { size: 0 })).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
