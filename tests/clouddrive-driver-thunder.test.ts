// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThunderDriver } from '../src/worker/clouddrive/drivers/thunder'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-thunder',
): DriverContext & { saveMock: ReturnType<typeof vi.fn>; markMock: ReturnType<typeof vi.fn> } {
  const stored: Record<string, string> = {
    accessToken: 'expired',
    refreshToken: 'r1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
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
    type: 'thunder',
    config: {},
    credentials: stored,
    saveCredentials: saveMock,
    markNeedsReauth: markMock,
    saveMock,
    markMock,
  }
}

const TOKEN = 'https://xluser-ssl.xunlei.com/v1/auth/token'
const FILES = 'https://api-pan.xunlei.com/drive/v1/files'

const FOLDER = { kind: 'drive#folder', id: 'd1', name: 'docs', modified_time: '2026-01-02T00:00:00Z' }
const FILE = { kind: 'drive#file', id: 'f1', name: 'a.txt', size: '10', modified_time: '2026-01-01T00:00:00Z' }
const FILE2 = { kind: 'drive#file', id: 'f2', name: 'b.txt', size: '20', modified_time: '2026-01-03T00:00:00Z' }
const FILE3 = { kind: 'drive#file', id: 'f3', name: 'c.txt', size: '30', modified_time: '2026-01-04T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Thunder driver', () => {
  it('lists one page with a cursor and a following page through page tokens', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.startsWith(FILES)) throw new Error(`unexpected ${url}`)
      const token = new URL(url).searchParams.get('page_token')
      if (token === 'p2') return json({ files: [FILE3] })
      return json({ files: [FOLDER, FILE], next_page_token: 'p2' })
    })

    const driver = createThunderDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt'])
    expect(first.cursor).toBe('p2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['c.txt'])
    expect(second.cursor).toBeNull()
  })

  it('walks every page when no page is requested', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.startsWith(FILES)) throw new Error(`unexpected ${url}`)
      calls++
      const token = new URL(url).searchParams.get('page_token')
      if (token === 'p2') return json({ files: [FILE3] })
      return json({ files: [FOLDER, FILE], next_page_token: 'p2' })
    })

    const collected = await createThunderDriver(context()).list('/', { pageSize: 2 })
    expect(collected.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt', 'c.txt'])
    expect(collected.cursor).toBeNull()
    expect(collected.truncated).toBe(false)
    expect(calls).toBe(2)
  })

  it('refreshes once when the drive rejects the token and writes both tokens back', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url.startsWith(FILES)) {
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer expired') return json({ error_code: 4122, error: 'token expired' }, 401)
        return json({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const result = await createThunderDriver(ctx).list('/')
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
      if (url === TOKEN) return new Response('', { status: 401 })
      if (url.startsWith(FILES)) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createThunderDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('maps throttling and missing resources to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!String(input).startsWith(FILES)) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 429 })
    })
    await expect(createThunderDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!String(input).startsWith(FILES)) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 404 })
    })
    await expect(createThunderDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the file download link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://dl.example/t') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206 })
      }
      if (!url.startsWith(FILES)) throw new Error(`unexpected ${url}`)
      return json({ files: [{ ...FILE, web_content_link: 'https://dl.example/t' }] })
    })

    const response = await createThunderDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping, backslash and control paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createThunderDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/docs\\secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.list('/docs/\u0000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates a token only once for two concurrent requests', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url.startsWith(FILES)) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization !== 'Bearer fresh') return new Response('', { status: 401 })
        return json({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const first = createThunderDriver(ctx)
    const second = createThunderDriver(ctx)
    const [a, b] = await Promise.all([first.list('/'), second.list('/')])
    expect(a.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(b.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the read-only operations unsupported', async () => {
    const driver = createThunderDriver(context())
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.mkdir('/docs/new')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/a.txt', '/b.txt')).rejects.toBeInstanceOf(DriverError)
  })
})
