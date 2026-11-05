// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createYandexDriver } from '../src/worker/clouddrive/drivers/yandex'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { refreshToken: 'r1', clientId: 'cid', clientSecret: 'secret', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-ya',
    type: 'yandex',
    config: {},
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const TOKEN_URL = 'https://oauth.yandex.com/token'
const RESOURCES = 'https://cloud-api.yandex.net/v1/disk/resources'
const FILE = { name: 'a.txt', type: 'file', size: 10, modified: '2026-01-01T00:00:00Z', path: '/a.txt' }
const FOLDER = { name: 'docs', type: 'dir', modified: '2026-01-02T00:00:00Z', path: '/docs' }

function token(): Response {
  return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Yandex Disk driver', () => {
  it('walks offset pages and reports the next offset', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url.startsWith(`${RESOURCES}?`)) {
        calls.push(url)
        const offset = new URL(url).searchParams.get('offset')
        if (offset === '0') {
          return json({ _embedded: { items: [FILE], total: 2 } })
        }
        return json({ _embedded: { items: [FOLDER], total: 2 } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createYandexDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('1')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries[0]!.name).toBe('docs')
    expect(second.entries[0]!.kind).toBe('folder')
    expect(calls).toHaveLength(2)
  })

  it('maps 404 and 429', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return json({ message: 'Not found', description: 'not found' }, 404)
    })
    await expect(createYandexDriver(context()).stat('/docs')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return new Response('', { status: 429 })
    })
    await expect(createYandexDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('streams a file through the download href with Range and exposes a direct link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url.startsWith(`${RESOURCES}?`) && url.includes('path=%2Fa.txt')) return json(FILE)
      if (url.includes('/download?')) return json({ href: 'https://down.example/a.txt' })
      if (url === 'https://down.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createYandexDriver(context())
    expect((await driver.read('/a.txt', 'bytes=2-5')).status).toBe(206)
    expect(await driver.directLink('/a.txt')).toBe('https://down.example/a.txt')
  })

  it('refreshes once when the API rejects the token', async () => {
    let tokenCalls = 0
    let statCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url.startsWith(`${RESOURCES}?`)) {
        statCalls++
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer stale') return new Response('', { status: 401 })
        return json(FILE)
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createYandexDriver(context({ accessToken: 'stale', expiresAt: String(Date.now() + 3_600_000) }))
    expect((await driver.stat('/a.txt')).name).toBe('a.txt')
    expect(tokenCalls).toBe(1)
    expect(statCalls).toBe(2)
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createYandexDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
