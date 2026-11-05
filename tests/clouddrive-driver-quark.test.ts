// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuarkDriver } from '../src/worker/clouddrive/drivers/quark'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'puus=valid-session; __pus=valid-refresh',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: USER,
    storageId: STORAGE,
    type: 'quark',
    config: { variant: 'Quark', rootFolderId: '0', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = { fid: 'f1', file_name: 'a.txt', file: true, size: 10, updated_at: 1_700_000_000 }
const FILE_B = { fid: 'f2', file_name: 'b.pdf', file: true, size: 20, updated_at: 1_700_000_100 }
const FOLDER = { fid: 'd1', file_name: 'docs', file: false, size: 0, updated_at: 1_700_000_200 }

function sortResponse(files: Array<Record<string, unknown>>, total: number): Response {
  return json({ status: 200, code: 0, data: { list: files }, metadata: { total } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Quark driver', () => {
  it('walks pages and returns the requested page plus its cursor', async () => {
    const pages: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/file/sort')) throw new Error(`unexpected ${url}`)
      const page = new URL(url).searchParams.get('_page') ?? ''
      pages.push(page)
      return page === '2' ? sortResponse([FOLDER], 3) : sortResponse([FILE_A, FILE_B], 3)
    })

    const driver = createQuarkDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.entries[0]!.kind).toBe('file')
    expect(first.entries[0]!.modifiedAt).toBe(FILE_A.updated_at * 1000)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(pages).toEqual(['1', '2'])
  })

  it('marks the storage for re-authorization when the cookie is refused', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ status: 401, message: 'invalid cookie' }, 401))
    const driver = createQuarkDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps a business rate-limit envelope to rate_limit without retrying', async () => {
    const fetchMock = vi.fn(async () => json({ status: 429, code: 0, message: 'too many requests' }))
    vi.stubGlobal('fetch', fetchMock)
    const driver = createQuarkDriver(context())

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a missing path as not_found after listing its parent', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/file/sort')) return sortResponse([], 0)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createQuarkDriver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range and the required Cookie/UA/Referer to the download link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/file/sort')) return sortResponse([FILE_A], 1)
      if (url.includes('/file/download')) {
        return json({ status: 200, code: 0, data: [{ download_url: 'https://cdn.example/a.txt' }] })
      }
      if (url === 'https://cdn.example/a.txt') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=2-5')
        expect(headers.get('Referer')).toBe('https://pan.quark.cn')
        expect(headers.get('User-Agent')).toContain('quark-cloud-drive')
        expect(headers.get('Cookie')).toContain('puus=valid-session')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createQuarkDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createQuarkDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('persists a rotated cookie from upstream Set-Cookie', async () => {
    const save = vi.fn(async (_patch: Record<string, string>) => undefined)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 200, code: 0, data: { list: [] }, metadata: { total: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': '__puus=rotated; Path=/; HttpOnly' },
    }))
    const driver = createQuarkDriver(context({ saveCredentials: save }))
    await driver.list('/')

    expect(save).toHaveBeenCalledTimes(1)
    const patch = save.mock.calls[0]![0] as Record<string, string>
    expect(patch.cookie).toContain('puus=valid-session')
    expect(patch.cookie).toContain('__puus=rotated')
  })

  it('keeps its capability bits in step with the registry and refuses direct upload', async () => {
    const driver = createQuarkDriver(context())
    expect(driver.definition).toBe(findCloudDriveDriver('quark'))
    expect(driver.capabilities.write).toBe(false)
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.copy).toBeTypeOf('function')
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({
      kind: 'unsupported',
    })
  })
})
