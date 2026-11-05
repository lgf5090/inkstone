// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPikPakShareDriver } from '../src/worker/clouddrive/drivers/pikpak-share'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const SHARE_PATH = '/drive/v1/share'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}, config: Record<string, unknown> = {}): DriverContext {
  const stored: Record<string, string> = { sharePwd: 'pwd', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-pikpak-share',
    type: 'pikpak_share',
    config: { shareId: 'sid', rootFolderId: 'root', ...config },
    credentials: stored,
    saveCredentials: vi.fn(async () => ({ ...stored })),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const FILE_A = { id: 'f1', kind: 'drive#file', name: 'a.txt', size: '10', modified_time: '2026-01-01T00:00:00Z' }
const FILE_B = { id: 'f2', kind: 'drive#file', name: 'b.pdf', size: '20', modified_time: '2026-01-02T00:00:00Z' }
const FOLDER = { id: 'd1', kind: 'drive#folder', name: 'docs', modified_time: '2026-01-03T00:00:00Z' }

function shareList(files: unknown[], next?: string, extra: Record<string, unknown> = {}): Response {
  return json({ files, ...(next ? { next_page_token: next } : {}), ...extra })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PikPak Share driver', () => {
  it('walks page tokens and returns a requested page plus its cursor', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname !== SHARE_PATH) throw new Error(`unexpected ${url}`)
      listCalls++
      if (url.searchParams.get('page_token') === 'p2') return shareList([FOLDER])
      return shareList([FILE_A, FILE_B], 'p2')
    })

    const driver = createPikPakShareDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('p2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.cursor).toBeNull()

    const all = await driver.list('/')
    expect(all.entries).toHaveLength(3)
    expect(all.truncated).toBe(false)
    expect(listCalls).toBe(5)
  })

  it('marks the storage when the share stays unauthorized', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ share_status: 'UNAUTHORIZED' }, 401))
    const ctx = context()
    ctx.markNeedsReauth = mark
    const driver = createPikPakShareDriver(ctx)
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps throttling to rate_limit and a missing share to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '1' } }))
    await expect(createPikPakShareDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => json({ message: 'missing' }, 404))
    await expect(createPikPakShareDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createPikPakShareDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range to the share download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === SHARE_PATH) return shareList([{ ...FILE_A, web_content_link: 'https://dl.example/f1' }])
      if (url.hostname === 'dl.example') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const response = await createPikPakShareDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('keeps the read-only operations unavailable', async () => {
    const driver = createPikPakShareDriver(context())
    expect(driver.capabilities.write).toBe(false)
    await expect(driver.mkdir('/docs')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.remove('/a.txt')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
