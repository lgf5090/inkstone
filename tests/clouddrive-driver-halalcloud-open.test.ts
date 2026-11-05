// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHalalCloudOpenDriver } from '../src/worker/clouddrive/drivers/halalcloud-open'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const HOST = 'openapi.2dland.cn'
const LIST_URL = `https://${HOST}/v6/userfile/list`
const DOWNLOAD_URL = `https://${HOST}/v6/userfile/get_direct_download_address`
const REFRESH_URL = `https://${HOST}/v6/oauth/refresh_token`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function parseBody(init?: RequestInit): Record<string, any> {
  const raw = init?.body
  if (!raw) return {}
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, any>
  return JSON.parse(new TextDecoder().decode(raw as unknown as Uint8Array)) as Record<string, any>
}

function context(credentials: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const stored: Record<string, string> = {
    clientId: 'client-1',
    clientSecret: 'secret',
    refreshToken: 'r1',
    accessToken: 'tok-0',
    expiresAt: String(Date.now() + 3_600_000),
    ...credentials,
  }
  const saveCredentials = vi.fn(async (patch: Record<string, string>) => {
    Object.assign(stored, patch)
    return { ...stored }
  })
  const markNeedsReauth = vi.fn(async (_message: string) => undefined)
  const ctx: DriverContext = {
    userId: 'user-a',
    storageId: 'storage-halal',
    type: 'halalcloud_open',
    config: { host: '', rootFolderId: '', ...config },
    credentials: stored,
    saveCredentials,
    markNeedsReauth,
  }
  return { ctx, saveCredentials, markNeedsReauth, stored }
}

const FILE = {
  identity: 'id-1',
  name: 'a.txt',
  path: '/a.txt',
  size: '10',
  update_ts: 1767225600,
  dir: false,
}
const FOLDER = {
  identity: 'id-2',
  name: 'docs',
  path: '/docs',
  dir: true,
  create_ts: 1767312000,
}

function listBody(files: unknown[], token: string): Response {
  return json({ files, list_info: { limit: 100, token } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HalalCloud Open driver', () => {
  it('walks cursor pages and returns the requested page plus its cursor', async () => {
    const tokens: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === LIST_URL) {
        const body = parseBody(init)
        const token = String(body.list_info?.token ?? '')
        tokens.push(token)
        return token === 't2' ? listBody([FOLDER], '') : listBody([FILE], 't2')
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createHalalCloudOpenDriver(context().ctx)
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('t2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(second.truncated).toBe(false)

    tokens.length = 0
    const all = await driver.list('/', { pageSize: 2 })
    expect(all.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(all.cursor).toBeNull()
    expect(all.truncated).toBe(false)
    expect(tokens).toEqual(['', 't2'])

    const entry = await driver.stat('/a.txt')
    expect(entry.kind).toBe('file')
    expect(entry.size).toBe(10)
    expect(entry.ref).toBe('id-1')
  })

  it('marks the storage for re-authorization when the refresh fails', async () => {
    let refreshCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === REFRESH_URL) {
        refreshCalls++
        return json({ message: 'invalid refresh token' }, 400)
      }
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, markNeedsReauth } = context({
      accessToken: 'stale',
      expiresAt: String(Date.now()),
    })
    await expect(createHalalCloudOpenDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(refreshCalls).toBe(1)
    expect(markNeedsReauth).toHaveBeenCalled()
  })

  it('maps a throttled listing to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) === LIST_URL) {
        return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      }
      throw new Error(`unexpected ${String(input)}`)
    })
    await expect(createHalalCloudOpenDriver(context().ctx).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing folder to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) === LIST_URL) return json({ message: 'not found' }, 404)
      throw new Error(`unexpected ${String(input)}`)
    })
    await expect(createHalalCloudOpenDriver(context().ctx).list('/docs')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHalalCloudOpenDriver(context().ctx).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range to the download address and exposes it as a direct link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === LIST_URL) return listBody([FILE], '')
      if (url === DOWNLOAD_URL) {
        const body = parseBody(init)
        expect(body.path).toBe('/a.txt')
        expect(body.identity).toBe('id-1')
        return json({ download_address: 'https://dl.example/a.txt' })
      }
      if (url === 'https://dl.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createHalalCloudOpenDriver(context().ctx)
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
    expect(await driver.directLink!('/a.txt')).toBe('https://dl.example/a.txt')
  })

  it('refreshes concurrently through one upstream token request', async () => {
    let refreshCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === REFRESH_URL) {
        refreshCalls++
        return json({ access_token: 'tok-1', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === LIST_URL) return listBody([FILE], '')
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, saveCredentials } = context({
      accessToken: 'stale',
      expiresAt: String(Date.now()),
    })
    const driver = createHalalCloudOpenDriver(ctx)
    await Promise.all([driver.list('/'), driver.list('/')])
    expect(refreshCalls).toBe(1)
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'tok-1' }),
      { expect: { accessToken: 'stale', refreshToken: 'r1' } },
    )
  })

  it('declares read-only capabilities and refuses writes', async () => {
    const driver = createHalalCloudOpenDriver(context().ctx)
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.rename('/a.txt', 'b.txt')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.remove('/a.txt')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
