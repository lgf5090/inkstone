// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create115ShareDriver } from '../src/worker/clouddrive/drivers/115_share'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    receiveCode: 'abcd',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: USER,
    storageId: STORAGE,
    type: '115_share',
    config: { shareCode: 'sw1abc', pageSize: 100, ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = { file_id: 'f1', file_name: 'a.txt', file_size: 10, is_file: 1, user_utime: 1_700_000_000 }
const FILE_B = { file_id: 'f2', file_name: 'b.pdf', file_size: 20, is_file: 1, user_utime: 1_700_000_100 }
const FOLDER = { category_id: 'c1', file_name: 'docs', is_file: 0, user_utime: 1_700_000_200 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('115 Share driver', () => {
  it('continues the offset pagination and returns the next cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      calls.push(url.toString())
      if (!url.pathname.endsWith('/share/snap')) throw new Error(`unexpected ${url}`)
      const offset = Number(url.searchParams.get('offset'))
      return offset === 0
        ? json({ state: true, data: { count: 3, list: [FILE_A, FILE_B] } })
        : json({ state: true, data: { count: 3, list: [FOLDER] } })
    })

    const driver = create115ShareDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.entries[0]!.kind).toBe('file')
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('offset=2')
    expect(calls[1]).toContain('limit=2')
  })

  it('marks the storage for re-authorization when the share refuses the credentials', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
    const driver = create115ShareDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = create115ShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = create115ShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the download link with the 115 Referer and User-Agent', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/share/snap')) {
        return json({ state: true, data: { count: 1, list: [FILE_A] } })
      }
      if (url.pathname.endsWith('/app/share/downurl')) {
        return json({ state: true, data: { url: { url: 'https://cdn.example/115.bin' } } })
      }
      if (url.toString() === 'https://cdn.example/115.bin') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=0-3')
        expect(headers.get('Referer')).toBe('https://115.com/')
        expect(headers.get('User-Agent')).toContain('Mozilla/5.0')
        return new Response('data', { status: 206, headers: { 'content-range': 'bytes 0-3/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create115ShareDriver(context())
    const response = await driver.read('/a.txt', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('data')
  })

  it('rejects an invalid path before any network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create115ShareDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/a/../b.txt')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the read-only capabilities honest and exposes a direct link', async () => {
    const driver = create115ShareDriver(context())
    expect(driver.capabilities.write).toBe(false)
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeDefined()
    await expect(driver.upload('/a.txt', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.mkdir('/docs')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.rename('/a.txt', 'b.txt')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/a.txt', '/b.txt')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.remove('/a.txt')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
