// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create139Driver } from '../src/worker/clouddrive/drivers/139'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

const TOKEN = btoa(`pc:13800138000:token|1|1|${Date.now() + 30 * 24 * 60 * 60 * 1000}`)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    authorization: `Basic ${TOKEN}`,
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-139',
    storageId: 'storage-139',
    type: '139',
    config: { type: 'personal_new', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function routeHost(): Response {
  return json({
    success: true,
    code: '0000',
    data: { routePolicyList: [{ modName: 'personal', httpsUrl: 'https://personal.example.com/hcy' }] },
  })
}

function personalList(items: unknown[], next = ''): Response {
  return json({ success: true, code: '0000', data: { items, nextPageCursor: next } })
}

const FILE_A = { fileId: 'f-a', name: 'a.txt', type: 'file', size: 10, updatedAt: '2026-01-01T00:00:00Z' }
const FILE_B = { fileId: 'f-b', name: 'b.pdf', type: 'file', size: 20, updatedAt: '2026-01-02T00:00:00Z' }
const FOLDER = { fileId: 'd-a', name: 'docs', type: 'folder', updatedAt: '2026-01-03T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('139 driver', () => {
  it('walks the cursor pages and returns the requested page with its cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('qryRoutePolicy')) return routeHost()
      if (url.includes('/file/list')) {
        const body = JSON.parse(String(init?.body)) as { pageInfo?: { pageCursor?: string } }
        const cursor = body.pageInfo?.pageCursor ?? ''
        return cursor === '' ? personalList([FILE_A, FILE_B], 'C1') : personalList([FOLDER])
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create139Driver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('C1')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(calls.filter((url) => url.includes('/file/list'))).toHaveLength(3)
  })

  it('marks the storage for re-authorization when the Authorization is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('qryRoutePolicy')) return new Response('expired', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create139Driver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps a 429 from the listing endpoint to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('qryRoutePolicy')) return routeHost()
      if (url.includes('/file/list')) return new Response('slow down', { status: 429 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create139Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a 404 on the download endpoint to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('qryRoutePolicy')) return routeHost()
      if (url.includes('/file/list')) return personalList([FILE_A])
      if (url.includes('/file/getDownloadUrl')) return new Response('gone', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create139Driver(context())
    await expect(driver.read('/a.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the download link and preserves the 206 answer', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('qryRoutePolicy')) return routeHost()
      if (url.includes('/file/list')) return personalList([FILE_A])
      if (url.includes('/file/getDownloadUrl')) {
        return json({ success: true, code: '0000', data: { url: 'https://cdn.example/a.txt' } })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', {
          status: 206,
          headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = create139Driver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects an escaping path before issuing any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create139Driver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploads a file in two parts and completes the multipart session', async () => {
    const size = 8
    const bytes = new Uint8Array(size).fill(7)
    const puts: string[] = []
    let completed = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('qryRoutePolicy')) return routeHost()
      if (url.includes('/file/create') && !url.includes('getUploadUrl')) {
        return json({
          success: true,
          code: '0000',
          data: {
            exist: false,
            fileId: 'ref-1',
            uploadId: 'upload-1',
            partInfos: [
              { partNumber: 1, uploadUrl: 'https://upload.example/1' },
              { partNumber: 2, uploadUrl: 'https://upload.example/2' },
            ],
          },
        })
      }
      if (url.startsWith('https://upload.example/')) {
        expect(init?.method).toBe('PUT')
        puts.push(url)
        return new Response('', { status: 200 })
      }
      if (url.includes('/file/complete')) {
        completed = true
        return json({ success: true, code: '0000', data: {} })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create139Driver(context({ config: { type: 'personal_new', uploadPartSize: '4' } }))
    await driver.upload('/big.bin', bytes, { size })
    expect(puts).toHaveLength(2)
    expect(completed).toBe(true)
  })

  it('exposes the registered capabilities', () => {
    const driver = create139Driver(context())
    const definition = findCloudDriveDriver('139')!
    expect(driver.capabilities).toEqual(definition.capabilities)
    expect(driver.capabilities.copy).toBe(true)
  })
})
