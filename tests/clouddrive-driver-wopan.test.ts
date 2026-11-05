// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWopanDriver } from '../src/worker/clouddrive/drivers/wopan'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function dispatch(data: unknown, code = '0000', status = '200'): Response {
  return json({ STATUS: status, RSP: { RSP_CODE: code, DATA: data } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-wopan',
): DriverContext & { saveMock: ReturnType<typeof vi.fn>; markMock: ReturnType<typeof vi.fn> } {
  const stored: Record<string, string> = {
    accessToken: 'abcdefghijklmnop',
    refreshToken: 'r1',
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
    type: 'wopan',
    config: {},
    credentials: stored,
    saveCredentials: saveMock,
    markNeedsReauth: markMock,
    saveMock,
    markMock,
  }
}

function requestKey(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { header?: { key?: string } }
  return body.header?.key ?? ''
}

const FILE = { fid: 'f1', id: 'id-1', name: 'a.txt', size: 10, createTime: '20240101100000', type: 1 }
const FILE2 = { fid: 'f2', id: 'id-2', name: 'b.txt', size: 20, createTime: '20240102100000', type: 1 }
const FILE3 = { fid: 'f3', id: 'id-3', name: 'c.txt', size: 30, createTime: '20240103100000', type: 1 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WoPan driver', () => {
  it('lists one page with a cursor and a following page without one', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      if (requestKey(init) !== 'QueryAllFiles') throw new Error('unexpected method')
      listCalls++
      return dispatch({ files: listCalls === 1 ? [FILE, FILE2] : [FILE3] })
    })

    const driver = createWopanDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['c.txt'])
    expect(second.cursor).toBeNull()
  })

  it('walks every page when no page is requested', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      if (requestKey(init) !== 'QueryAllFiles') throw new Error('unexpected method')
      listCalls++
      return dispatch({ files: listCalls === 1 ? [FILE, FILE2] : [FILE3] })
    })

    const collected = await createWopanDriver(context()).list('/', { pageSize: 2 })
    expect(collected.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(collected.cursor).toBeNull()
    expect(collected.truncated).toBe(false)
    expect(listCalls).toBe(2)
  })

  it('refreshes once when the token is rejected and writes both tokens back with the observed values', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api-user/dispatcher')) {
        tokenCalls++
        return dispatch({ access_token: 'fresh-token-123', refresh_token: 'r2' })
      }
      if (url.endsWith('/wohome/dispatcher')) {
        const token = new Headers(init?.headers).get('Accesstoken')
        if (token === 'abcdefghijklmnop') return dispatch({}, '9999')
        return dispatch({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const result = await createWopanDriver(ctx).list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledWith(
      { accessToken: 'fresh-token-123', refreshToken: 'r2' },
      { expect: { accessToken: 'abcdefghijklmnop', refreshToken: 'r1' } },
    )
    expect(ctx.markMock).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when the refresh token is refused', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api-user/dispatcher')) {
        expect(requestKey(init)).toBe('AppRefreshToken')
        return new Response('', { status: 401 })
      }
      if (url.endsWith('/wohome/dispatcher')) return dispatch({}, '9999')
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createWopanDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('maps throttling and missing resources to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      return new Response('', { status: 429 })
    })
    await expect(createWopanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      return new Response('', { status: 404 })
    })
    await expect(createWopanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the resolved download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://dl.example/a') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206 })
      }
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      const key = requestKey(init)
      if (key === 'QueryAllFiles') return dispatch({ files: [FILE] })
      if (key === 'GetDownloadUrlV2') {
        return dispatch({ list: [{ fid: 'f1', downloadUrl: 'https://dl.example/a' }] })
      }
      throw new Error(`unexpected method ${key}`)
    })

    const response = await createWopanDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping, backslash and control paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createWopanDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/docs\\secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.list('/docs/\u0000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates a token only once for two concurrent requests', async () => {
    let tokenCalls = 0
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api-user/dispatcher')) {
        tokenCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return dispatch({ access_token: 'fresh-token-123', refresh_token: 'r2' })
      }
      if (url.endsWith('/wohome/dispatcher')) {
        listCalls++
        await new Promise((resolve) => setTimeout(resolve, 10))
        const token = new Headers(init?.headers).get('Accesstoken')
        if (token !== 'fresh-token-123') return dispatch({}, '9999')
        return dispatch({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const first = createWopanDriver(ctx)
    const second = createWopanDriver(ctx)
    const [a, b] = await Promise.all([first.list('/'), second.list('/')])
    expect(a.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(b.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(listCalls).toBe(4)
    expect(ctx.saveMock).toHaveBeenCalledTimes(1)
    expect(ctx.saveMock).toHaveBeenCalledWith(
      { accessToken: 'fresh-token-123', refreshToken: 'r2' },
      { expect: { accessToken: 'abcdefghijklmnop', refreshToken: 'r1' } },
    )
  })

  it('keeps the read-only operations unsupported', async () => {
    const driver = createWopanDriver(context())
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.mkdir('/docs/new')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.rename('/docs/a.txt', 'b.txt')).rejects.toBeInstanceOf(DriverError)
  })
})
