// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCtfileDriver } from '../src/worker/clouddrive/drivers/ctfile'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const BASE = 'https://rest.ctfile.com/v1'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function payloadOf(init?: RequestInit): Record<string, unknown> {
  try {
    return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { session: 'session-valid', ...(overrides.credentials ?? {}) }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'ctfile',
    config: { cloudType: 'private', baseUrl: BASE, ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FOLDER = { key: 'd200', name: 'docs', date: 1_700_000_000 }
const FILE_A = { key: 'f101', name: 'a.txt', size: 10, date: '2026-01-01 00:00:00' }
const FILE_B = { key: 'f102', name: 'b.pdf', size: 20, date: '2026-01-02 00:00:00' }
const FILE_C = { key: 'f103', name: 'c.bin', size: 30, date: '2026-01-03 00:00:00' }

/** Folder listing plus a `start`-offset file listing that needs three rounds. */
function listFixture(starts: number[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/user/info/profile')) return json({ code: 200 })
    if (url.endsWith('/private/folder/list')) return json({ code: 200, results: [FOLDER] })
    if (url.endsWith('/private/file/list')) {
      const start = Number(payloadOf(init).start)
      starts.push(start)
      if (start === 0) return json({ code: 200, results: [FILE_A, FILE_B] })
      if (start === 2) return json({ code: 200, results: [FILE_C] })
      return json({ code: 200, results: [] })
    }
    throw new Error(`unexpected ${url}`)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CtFile driver', () => {
  it('walks file/list by start offset and stops on the empty page', async () => {
    const starts: number[] = []
    vi.stubGlobal('fetch', listFixture(starts))
    const driver = createCtfileDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt', 'b.pdf', 'c.bin'])
    expect(result.entries[0]!.kind).toBe('folder')
    expect(result.entries[1]!.mime).toBe('text/plain')
    expect(starts).toEqual([0, 2, 3])
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('slices a requested page and returns the next offset cursor', async () => {
    const starts: number[] = []
    vi.stubGlobal('fetch', listFixture(starts))
    const driver = createCtfileDriver(context())
    const page = await driver.list('/', { page: 2, pageSize: 2 })
    expect(page.entries.map((entry) => entry.name)).toEqual(['b.pdf', 'c.bin'])
    expect(page.cursor).toBeNull()
    expect(page.truncated).toBe(false)
  })

  it('marks the storage for re-authorization when the session is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ code: 401, message: 'session expired' }))
    const driver = createCtfileDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps HTTP 429 to a rate_limit error', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user/info/profile')) return json({ code: 200 })
      return new Response('', { status: 429, headers: { 'retry-after': '0' } })
    })
    const driver = createCtfileDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a business 404 for the missing download id to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user/info/profile')) return json({ code: 200 })
      if (url.endsWith('/private/folder/list')) return json({ code: 200, results: [] })
      if (url.endsWith('/private/file/list')) return json({ code: 200, results: [FILE_A] })
      if (url.endsWith('/private/file/fetch_url')) return json({ code: 404, message: 'file missing' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createCtfileDriver(context())
    await expect(driver.read('/a.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the resolved download link and keeps a 206 body', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/user/info/profile')) return json({ code: 200 })
      if (url.endsWith('/private/folder/list')) return json({ code: 200, results: [] })
      if (url.endsWith('/private/file/list')) return json({ code: 200, results: [FILE_A] })
      if (url.endsWith('/private/file/fetch_url')) {
        return json({ code: 200, download_url: 'https://cdn.example/a.txt' })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createCtfileDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects an invalid path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createCtfileDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the md5-size checksum and skips the real upload on an instant-transfer hit', async () => {
    const uploads: string[] = []
    let checksum = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/user/info/profile')) return json({ code: 200 })
      if (url.endsWith('/private/file/upload')) {
        checksum = String(payloadOf(init).checksum ?? '')
        return json({ code: 200, exists: 1 })
      }
      if (url.includes('upload')) {
        uploads.push(url)
        return json({ code: 200 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createCtfileDriver(context())
    const progress = vi.fn()
    await driver.upload('/a.txt', new Uint8Array([1, 2, 3, 4]), { size: 4, onProgress: progress })
    expect(checksum).toMatch(/^[0-9a-f]{32}-4$/)
    expect(checksum.slice(0, 32)).toBe('08d6c05a21512a79a1dfeb9d2a8f262f')
    expect(uploads).toEqual([])
    expect(progress).toHaveBeenCalledWith(4, 4)
  })

  it('declares no copy capability and keeps copy undefined', () => {
    const driver = createCtfileDriver(context())
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(driver.capabilities.directLink).toBe(false)
    expect(typeof driver.directLink).toBe('function')
  })

  it('rejects a mismatched upload size without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createCtfileDriver(context())
    await expect(
      driver.upload('/a.txt', new Uint8Array([1, 2]), { size: 3 }),
    ).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
