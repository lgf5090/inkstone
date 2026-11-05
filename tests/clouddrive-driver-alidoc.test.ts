// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAlidocDriver } from '../src/worker/clouddrive/drivers/alidoc'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'
const ROOT = 'root-dentry'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'session=1',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: USER,
    storageId: STORAGE,
    type: 'alidoc',
    config: { rootFolderId: ROOT, ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = { dentryType: 'file', dentryUuid: 'f1', name: 'a.txt', fileSize: 10, updatedTime: 1_700_000_000_000 }
const FILE_B = { dentryType: 'file', dentryUuid: 'f2', name: 'b.pdf', fileSize: 20, updatedTime: 1_700_000_100_000 }
const FOLDER = { dentryType: 'folder', dentryUuid: 'd1', name: 'docs', fileSize: 0, updatedTime: 1_700_000_200_000 }

function listResponse(children: unknown[]): Response {
  return json({ isSuccess: true, status: 200, data: { children } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AliDoc driver', () => {
  it('paginates the single 1000-child upstream answer with the requested page size', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return listResponse([FILE_A, FILE_B, FOLDER])
    })

    const driver = createAlidocDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('pageSize=1000')
    expect(calls[0]).toContain(`dentryUuid=${ROOT}`)
  })

  it('marks the storage for re-authorization when the cookie is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
    const driver = createAlidocDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createAlidocDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = createAlidocDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('reads the pre-signed URL with the AliDoc Cookie, Referer, Origin and Range', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/box/api/v2/dentry/list')) return listResponse([FILE_A])
      if (url.pathname.endsWith('/box/api/v2/file/download')) {
        return json({
          isSuccess: true,
          status: 200,
          data: { ossUrlPreSignatureInfo: { preSignUrls: ['https://cdn.example/alidoc.bin'] } },
        })
      }
      if (url.toString() === 'https://cdn.example/alidoc.bin') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=1-2')
        expect(headers.get('Cookie')).toBe('session=1')
        expect(headers.get('Referer')).toBe('https://alidocs.dingtalk.com/')
        expect(headers.get('Origin')).toBe('https://alidocs.dingtalk.com')
        return new Response('ok', { status: 206 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createAlidocDriver(context())
    const response = await driver.read('/a.txt', 'bytes=1-2')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('ok')
  })

  it('rejects an invalid path before any network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createAlidocDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/a/../b.txt')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/a/../dir')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the declared capabilities and reports the missing upload honestly', async () => {
    const driver = createAlidocDriver(context())
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.copy).toBeDefined()
    expect(driver.directLink).toBeDefined()
    expect(driver.upload).toBeDefined()
    await expect(driver.upload('/a.txt', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
