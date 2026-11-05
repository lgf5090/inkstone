// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutoIndexDriver } from '../src/worker/clouddrive/drivers/autoindex'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const BASE = 'https://index.example/files'

const HTML = `<html><body><pre>
<a href="../">../</a>
<a href="movie.mp4">movie.mp4</a> 2026-01-02 10:30 123M
<a href="subdir/">subdir/</a> 2026-01-01 09:00 -
</pre></body></html>`

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { ...(overrides.credentials ?? {}) }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'autoindex',
    config: { url: BASE, rootPath: '/', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function html(body = HTML, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AutoIndex driver', () => {
  it('parses Apache-style names, sizes and modified times', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${BASE}/`)
      return html()
    })
    const driver = createAutoIndexDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['movie.mp4', 'subdir'])
    expect(result.entries[0]!.kind).toBe('file')
    expect(result.entries[0]!.size).toBe(123 * 1024 * 1024)
    expect(result.entries[0]!.modifiedAt).toBeGreaterThan(0)
    expect(result.entries[1]!.kind).toBe('folder')
  })

  it('parses the Nginx size-before-date order too', async () => {
    const nginx = '<html><body><pre><a href="image.jpg">image.jpg</a> 500K 2026-01-16 14:20</pre></body></html>'
    vi.stubGlobal('fetch', async () => html(nginx))
    const driver = createAutoIndexDriver(context())
    const result = await driver.list('/')
    expect(result.entries[0]!.size).toBe(500 * 1024)
    expect(result.entries[0]!.modifiedAt).toBeGreaterThan(0)
  })

  it('builds directory URLs from rootPath and escapes paths', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${BASE}/root/sub/`)
      return html()
    })
    const driver = createAutoIndexDriver(context({ config: { url: BASE, rootPath: '/root' } }))
    await driver.list('/sub')
  })

  it('maps 404 to not_found, 429 to rate_limit and keeps upstream messages', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = createAutoIndexDriver(context())
    await expect(driver.list('/missing')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '1' } }))
    const second = createAutoIndexDriver(context())
    await expect(second.list('/')).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 1000 })

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'index exploded' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }))
    const third = createAutoIndexDriver(context())
    await expect(third.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('index exploded'),
    })
  })

  it('forwards Range when reading a file URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${BASE}/movie.mp4`)
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
      return new Response('cdef', {
        status: 206,
        headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' },
      })
    })
    const driver = createAutoIndexDriver(context())
    const response = await driver.read('/movie.mp4', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('reports a missing entry as not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${BASE}/`) return html()
      return new Response('', { status: 404 })
    })
    const driver = createAutoIndexDriver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createAutoIndexDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares only the capabilities it has and refuses writes', async () => {
    const driver = createAutoIndexDriver(context())
    expect(driver.capabilities.write).toBe(false)
    expect(driver.capabilities.directLink).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeUndefined()
    await expect(driver.upload('/a.txt', new Uint8Array(), { size: 0 })).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
