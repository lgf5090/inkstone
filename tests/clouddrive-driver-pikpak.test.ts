// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPikPakDriver } from '../src/worker/clouddrive/drivers/pikpak'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER_HOST = 'https://user.mypikpak.net'
const API_HOST = 'https://api-drive.mypikpak.net'
const TOKEN_PATH = '/v1/auth/token'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored: Record<string, string> = {
    username: 'owner@example.com',
    password: 'secret',
    accessToken: 'a1',
    expiresAt: String(Date.now() + 3_600_000),
    ...credentials,
  }
  return {
    userId: 'user-a',
    storageId: 'storage-pikpak',
    type: 'pikpak',
    config: { rootFolderId: 'root', username: stored.username },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const FILE_A = { id: 'f1', kind: 'drive#file', name: 'a.txt', size: '10', modified_time: '2026-01-01T00:00:00Z' }
const FILE_B = { id: 'f2', kind: 'drive#file', name: 'b.pdf', size: '20', modified_time: '2026-01-02T00:00:00Z' }
const FOLDER = { id: 'd1', kind: 'drive#folder', name: 'docs', modified_time: '2026-01-03T00:00:00Z' }

function fileList(files: unknown[], next?: string): Response {
  return json({ files, ...(next ? { next_page_token: next } : {}) })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PikPak driver', () => {
  it('walks the page tokens and returns a requested page plus its cursor', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'user.mypikpak.net') throw new Error(`unexpected token call ${url}`)
      if (url.pathname === '/drive/v1/files' && (init?.method ?? 'GET') === 'GET') {
        listCalls++
        if (url.searchParams.get('page_token') === 'p2') return fileList([FOLDER])
        return fileList([FILE_A, FILE_B], 'p2')
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createPikPakDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('p2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()

    const all = await driver.list('/')
    expect(all.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf', 'docs'])
    expect(all.truncated).toBe(false)
    expect(listCalls).toBe(5)
  })

  it('marks the storage for re-authorization when refreshing fails', async () => {
    const mark = vi.fn(async () => undefined)
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(`${USER_HOST}${TOKEN_PATH}`)) {
        tokenCalls++
        return json({ error_code: 4001, error_description: 'refresh token revoked' }, 401)
      }
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context({ accessToken: '', refreshToken: 'r1', username: '', password: '' })
    ctx.markNeedsReauth = mark
    const driver = createPikPakDriver(ctx)
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
    expect(tokenCalls).toBe(1)
  })

  it('maps throttling to rate_limit and a missing folder to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/drive/v1/files') {
        return new Response('', { status: 429, headers: { 'retry-after': '0.1' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    await expect(createPikPakDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(`${API_HOST}/drive/v1/files`)) return json({ error: 'not found' }, 404)
      throw new Error(`unexpected ${url}`)
    })
    await expect(createPikPakDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refreshes the token once for two concurrent requests', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/auth/token') {
        tokenCalls++
        return json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url.pathname === '/drive/v1/files') return fileList([])
      throw new Error(`unexpected ${url}`)
    })
    const shared = context({ accessToken: '', refreshToken: 'r1', username: '', password: '' })
    const first = createPikPakDriver(shared)
    const second = createPikPakDriver(shared)
    await Promise.all([first.list('/'), second.list('/')])
    expect(tokenCalls).toBe(1)
    expect(shared.credentials.accessToken).toBe('a2')
    expect(shared.credentials.refreshToken).toBe('r2')
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createPikPakDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploads through the resumable OSS session in two parts', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
    const putUrls: string[] = []
    const putSizes: number[] = []
    let completed = false
    let taskCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/drive/v1/files' && init?.method === 'POST') {
        taskCalls++
        return json({ resumable: { params: { bucket: 'b', endpoint: 'oss.example', key: 'k', security_token: 't', part_size: 4, upload_id: 'u' } } })
      }
      if (url.hostname === 'b.oss.example') {
        if (url.searchParams.get('uploadId') && !url.searchParams.get('partNumber')) {
          completed = true
          return new Response('', { status: 200 })
        }
        putUrls.push(String(input))
        putSizes.push((init?.body as Uint8Array).byteLength)
        return new Response('', { status: 200, headers: { etag: `e${url.searchParams.get('partNumber')}` } })
      }
      throw new Error(`unexpected ${url}`)
    })

    await createPikPakDriver(context()).upload('/big.bin', bytes, { size: bytes.byteLength })
    expect(taskCalls).toBe(1)
    expect(putUrls).toHaveLength(2)
    expect(putSizes).toEqual([4, 3])
    expect(completed).toBe(true)
  })

  it('forwards Range to the resolved download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/drive/v1/files' && (init?.method ?? 'GET') === 'GET') return fileList([FILE_A])
      if (url.pathname === '/drive/v1/files/f1') {
        return json({ ...FILE_A, web_content_link: 'https://dl.example/f1' })
      }
      if (url.hostname === 'dl.example') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const response = await createPikPakDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })
})
