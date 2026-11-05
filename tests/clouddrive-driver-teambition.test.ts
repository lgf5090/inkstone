// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTeambitionDriver } from '../src/worker/clouddrive/drivers/teambition'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'
const BASE = 'https://www.teambition.com'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { cookie: 'tb=abc', ...(overrides.credentials ?? {}) }
  const config: Record<string, unknown> = {
    region: 'china',
    projectId: 'project-1',
    ...(overrides.config ?? {}),
  }
  return Object.assign<DriverContext, Partial<DriverContext>, Partial<DriverContext>>(
    {
      userId: USER,
      storageId: STORAGE,
      type: 'teambition',
      config,
      credentials,
      saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
      markNeedsReauth: vi.fn(async () => undefined),
    },
    overrides,
    { config, credentials },
  )
}

const FOLDER_A = { _id: 'c1', title: 'docs', updated: '2026-01-01T00:00:00Z' }
const FOLDER_B = { _id: 'c2', title: 'media', updated: '2026-01-02T00:00:00Z' }
const WORK_A = { _id: 'w1', fileName: 'a.txt', fileSize: 10, updated: '2026-01-03T00:00:00Z', downloadUrl: 'https://www.teambition.com/api/works/w1/download' }

function pageOf(url: string, resource: 'collections' | 'works'): { page: number; count: number } | null {
  const parsed = new URL(url)
  if (parsed.pathname !== `/api/${resource}`) return null
  return { page: Number(parsed.searchParams.get('page')), count: Number(parsed.searchParams.get('count')) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Teambition driver', () => {
  it('pages collections and works with the requested page size and returns the next page', async () => {
    const pages: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      const folders = pageOf(url, 'collections')
      if (folders) {
        pages.push(`collections:${folders.page}:${folders.count}`)
        return json(folders.page === 1 ? [FOLDER_A, FOLDER_B] : [])
      }
      const works = pageOf(url, 'works')
      if (works) {
        pages.push(`works:${works.page}:${works.count}`)
        return json(works.page === 1 ? [WORK_A] : [])
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createTeambitionDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['docs', 'media', 'a.txt'])
    expect(first.entries[2]!.kind).toBe('file')
    expect(first.entries[2]!.size).toBe(10)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries).toEqual([])
    expect(second.cursor).toBeNull()
    expect(pages).toEqual([
      'collections:1:2', 'works:1:2',
      'collections:2:2', 'works:2:2',
    ])
  })

  it('marks the storage for re-authorization when the cookie is refused twice', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ name: 'Unauthorized', message: 'login required' }, 401))

    const driver = createTeambitionDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps 429 to a rate-limit driver error', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createTeambitionDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = createTeambitionDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('resolves the download 302 and forwards Range', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const folders = pageOf(url, 'collections')
      if (folders) return json([])
      const works = pageOf(url, 'works')
      if (works) return json([WORK_A])
      if (url === WORK_A.downloadUrl) {
        expect(new Headers(init?.headers).get('Cookie')).toBe('tb=abc')
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example/a.txt' } })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createTeambitionDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping paths before any request and keeps copy defined', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createTeambitionDriver(context())
    expect(driver.capabilities.copy).toBe(true)
    expect(typeof driver.copy).toBe('function')
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/bad\u0000name')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a collection with the project and parent in the body', async () => {
    let body: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${BASE}/api/collections` && init?.method === 'POST') {
        body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
        return new Response('', { status: 201 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createTeambitionDriver(context())
    await driver.mkdir('/docs')
    expect(body).toMatchObject({ title: 'docs', _projectId: 'project-1', _parentId: '', objectType: 'collection' })
  })

  it('keeps upload unsupported instead of silently succeeding', async () => {
    const driver = createTeambitionDriver(context())
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
