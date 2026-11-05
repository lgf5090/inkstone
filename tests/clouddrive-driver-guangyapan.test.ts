// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuangyapanDriver } from '../src/worker/clouddrive/drivers/guangyapan'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-gyp',
): DriverContext & { saveMock: ReturnType<typeof vi.fn>; markMock: ReturnType<typeof vi.fn> } {
  const stored: Record<string, string> = {
    accessToken: 'expired',
    refreshToken: 'r1',
    clientId: 'client-1',
    ...credentials,
  }
  const saveMock = vi.fn(async (patch: Record<string, string>) => {
    Object.assign(stored, patch)
    return { ...stored }
  })
  const markMock = vi.fn(async () => undefined)
  return {
    userId: 'user-a',
    storageId,
    type: 'guangyapan',
    config: { phoneNumber: '+86 13800000000' },
    credentials: stored,
    saveCredentials: saveMock,
    markNeedsReauth: markMock,
    saveMock,
    markMock,
  }
}

const ACCOUNT_TOKEN = 'https://account.guangyapan.com/v1/auth/token'
const FILE_LIST = 'https://api.guangyapan.com/userres/v1/file/get_file_list'
const DOWNLOAD_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/get_res_download_url'

const FILE = { fileId: 'f1', fileName: 'a.txt', fileSize: 10, resType: 1, utime: 1700000000 }
const FILE2 = { fileId: 'f2', fileName: 'b.txt', fileSize: 20, resType: 1, utime: 1700000100 }
const FILE3 = { fileId: 'f3', fileName: 'c.txt', fileSize: 30, resType: 1, utime: 1700000200 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GuangYaPan driver', () => {
  it('lists one page with a cursor and a following page', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url !== FILE_LIST) throw new Error(`unexpected ${url}`)
      const body = JSON.parse(String(init?.body)) as { page: number }
      return json({
        code: 0,
        msg: 'success',
        data: { total: 3, list: body.page === 0 ? [FILE, FILE2] : [FILE3] },
      })
    })

    const driver = createGuangyapanDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['c.txt'])
    expect(second.cursor).toBeNull()
  })

  it('walks every page when no page is requested', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url !== FILE_LIST) throw new Error(`unexpected ${url}`)
      calls++
      const body = JSON.parse(String(init?.body)) as { page: number }
      return json({
        code: 0,
        msg: 'success',
        data: { total: 3, list: body.page === 0 ? [FILE, FILE2] : [FILE3] },
      })
    })

    const collected = await createGuangyapanDriver(context()).list('/', { pageSize: 2 })
    expect(collected.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(collected.cursor).toBeNull()
    expect(collected.truncated).toBe(false)
    expect(calls).toBe(2)
  })

  it('refreshes once when the API rejects the token and writes both tokens back', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === ACCOUNT_TOKEN) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === FILE_LIST) {
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer expired') return new Response('', { status: 401 })
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const result = await createGuangyapanDriver(ctx).list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledWith(
      {
        accessToken: 'fresh',
        refreshToken: 'r2',
        expiresAt: expect.any(String),
      },
      { expect: { accessToken: 'expired', refreshToken: 'r1' } },
    )
    expect(ctx.markMock).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when the refresh token is refused', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === ACCOUNT_TOKEN) return new Response('', { status: 401 })
      if (url === FILE_LIST) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createGuangyapanDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('maps throttling and missing resources to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) !== FILE_LIST) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 429 })
    })
    await expect(createGuangyapanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) !== FILE_LIST) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 404 })
    })
    await expect(createGuangyapanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the signed download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://dl.example/g') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206 })
      }
      if (url === FILE_LIST) {
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      if (url === DOWNLOAD_URL) {
        return json({ code: 0, msg: 'success', data: { signedURL: 'https://dl.example/g' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const response = await createGuangyapanDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping, backslash and control paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createGuangyapanDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/docs\\secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.list('/docs/\u0000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates a token only once for two concurrent requests', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === ACCOUNT_TOKEN) {
        tokenCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === FILE_LIST) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization !== 'Bearer fresh') return new Response('', { status: 401 })
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const first = createGuangyapanDriver(ctx)
    const second = createGuangyapanDriver(ctx)
    const [a, b] = await Promise.all([first.list('/'), second.list('/')])
    expect(a.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(b.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the read-only operations unsupported', async () => {
    const driver = createGuangyapanDriver(context())
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.mkdir('/docs/new')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.remove('/a.txt')).rejects.toBeInstanceOf(DriverError)
  })
})
