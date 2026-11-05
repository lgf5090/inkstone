// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMediatrackDriver } from '../src/worker/clouddrive/drivers/mediatrack'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'
const JAYCE = 'https://jayce.api.mediatrack.cn'
const KAYN = 'https://kayn.api.mediatrack.cn'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { accessToken: 'tok', ...(overrides.credentials ?? {}) }
  const config: Record<string, unknown> = {
    projectId: 'project-1',
    rootFolderId: '',
    ...(overrides.config ?? {}),
  }
  return Object.assign<DriverContext, Partial<DriverContext>, Partial<DriverContext>>(
    {
      userId: USER,
      storageId: STORAGE,
      type: 'mediatrack',
      config,
      credentials,
      saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
      markNeedsReauth: vi.fn(async () => undefined),
    },
    overrides,
    { config, credentials },
  )
}

const FOLDER = { id: 'f1', title: 'docs', updated_at: '2026-01-02T00:00:00Z' }
const FILE_A = { id: 'a1', title: 'a.txt', size: '10', updated_at: '2026-01-01T00:00:00Z', file: { src: 's1' } }
const FILE_B = { id: 'b1', title: 'b.pdf', size: '20', updated_at: '2026-01-03T00:00:00Z', file: { src: 's2' } }

function childrenPage(url: string): { page: number; size: number } | null {
  const parsed = new URL(url)
  if (!parsed.pathname.includes('/v4/assets/') || !parsed.pathname.endsWith('/children')) return null
  return { page: Number(parsed.searchParams.get('page')), size: Number(parsed.searchParams.get('size')) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MediaTrack driver', () => {
  it('requests the right page/size pair and returns the next page token', async () => {
    const pages: Array<{ page: number; size: number }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const page = childrenPage(String(input))
      if (!page) throw new Error(`unexpected ${String(input)}`)
      pages.push(page)
      if (page.page === 1) return json({ status: 'SUCCESS', data: { total: 3, assets: [FOLDER, FILE_A] } })
      if (page.page === 2) return json({ status: 'SUCCESS', data: { total: 3, assets: [FILE_B] } })
      return json({ status: 'SUCCESS', data: { total: 3, assets: [] } })
    })

    const driver = createMediatrackDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt'])
    expect(first.entries[0]!.kind).toBe('folder')
    expect(first.entries[1]!.size).toBe(10)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.pdf'])
    expect(second.cursor).toBeNull()
    expect(pages).toEqual([{ page: 1, size: 2 }, { page: 2, size: 2 }])
  })

  it('marks the storage for re-authorization when the token is refused twice', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ message: 'unauthorized' }, 401))

    const driver = createMediatrackDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps 429 to a rate-limit driver error', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createMediatrackDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = createMediatrackDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('resolves the download redirect and forwards Range', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (childrenPage(url)) {
        return json({ status: 'SUCCESS', data: { total: 1, assets: [FILE_A] } })
      }
      if (url.startsWith(`${KAYN}/v1/download_token/asset`)) {
        return json({ status: 'SUCCESS', data: { token: 't1' } })
      }
      if (url.startsWith(`${KAYN}/v1/download/redirect?token=t1`)) {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example/a.txt' } })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMediatrackDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping paths before any request and keeps copy defined', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createMediatrackDriver(context())
    expect(driver.capabilities.copy).toBe(true)
    expect(typeof driver.copy).toBe('function')
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/bad\u0000name')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reserves a COS object, uploads the bytes and registers the child', async () => {
    const requests: string[] = []
    let registered: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.startsWith(`${JAYCE}/v3/storage/tokens/asset`)) {
        return json({ status: 'SUCCESS', data: { url: 'https://cos.example/put' } })
      }
      if (url === 'https://cos.example/put') {
        expect(init?.method).toBe('PUT')
        return new Response('', { status: 200 })
      }
      if (url.startsWith(`${JAYCE}/v3/assets/`) && url.endsWith('/children')) {
        registered = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return json({ status: 'SUCCESS' })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMediatrackDriver(context())
    await driver.upload('/a.txt', new Uint8Array(5), { size: 5, contentType: 'text/plain' })
    expect(requests).toHaveLength(3)
    expect(registered).toMatchObject({ title: 'a.txt', size: '5', mime: 'text/plain', type: 0 })
    expect(String(registered!.src)).toMatch(/^assets\//)
  })
})
