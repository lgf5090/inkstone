// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create123OpenDriver } from '../src/worker/clouddrive/drivers/123-open'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const API = 'https://open-api.123pan.com'
const TOKEN = `${API}/api/v1/access_token`
const LIST = `${API}/api/v2/file/list`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-123-open',
  markNeedsReauth: DriverContext['markNeedsReauth'] = vi.fn(async () => undefined),
): DriverContext {
  const stored: Record<string, string> = {
    accessToken: 'valid', clientId: 'client-1', clientSecret: 'secret', refreshToken: 'r1', ...credentials,
  }
  return {
    userId: 'user-a',
    storageId,
    type: '123_open',
    config: { rootFolderId: '0' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth,
  }
}

const FILE = { fileId: 101, filename: 'a.txt', size: 10, type: 2, updateAt: '2026-01-01 00:00:00' }
const FOLDER = { fileId: 103, filename: 'docs', size: 0, type: 1, updateAt: '2026-01-02 00:00:00' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('123 Open driver', () => {
  it('walks lastFileId pages and returns the requested page with its cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST)) {
        calls.push(url)
        const cursor = new URL(url).searchParams.get('lastFileId')
        return cursor === '105'
          ? json({ code: 0, data: { fileList: [FOLDER], lastFileId: -1 } })
          : json({ code: 0, data: { fileList: [FILE], lastFileId: 105 } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = create123OpenDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('105')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.truncated).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('marks the storage for re-authorization when the client token endpoint rejects the credentials', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) return json({ code: 1, message: 'bad credentials' })
      if (url.startsWith(LIST)) return json({ code: 401, message: 'token expired' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create123OpenDriver(context({ accessToken: 'stale' }, 'storage-123-auth', mark))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps a throttled list call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST)) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create123OpenDriver(context({}, 'storage-123-429')).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST)) return new Response('', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create123OpenDriver(context({}, 'storage-123-404')).stat('/missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(create123OpenDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes the token once when two requests race', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        return json({ code: 0, data: { access_token: 'fresh' } })
      }
      if (url.startsWith(LIST)) return json({ code: 0, data: { fileList: [], lastFileId: -1 } })
      throw new Error(`unexpected ${url}`)
    })
    const first = create123OpenDriver(context({ accessToken: '' }, 'storage-123-race'))
    const second = create123OpenDriver(context({ accessToken: '' }, 'storage-123-race'))
    await Promise.all([first.list('/'), second.list('/')])
    expect(tokenCalls).toBe(1)
  })

  it('uploads a file in slices and completes the session', async () => {
    const slices: string[] = []
    let completed = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${API}/upload/v2/file/create`) {
        return json({ code: 0, data: { preuploadID: 'p1', sliceSize: 5, servers: ['https://upload.123.example'], reuse: false } })
      }
      if (url === 'https://upload.123.example/upload/v2/file/slice') {
        expect(init?.method).toBe('POST')
        slices.push(url)
        return json({ code: 0 })
      }
      if (url === `${API}/upload/v2/file/upload_complete`) {
        completed = true
        return json({ code: 0, data: { completed: true, fileID: 7 } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = create123OpenDriver(context())
    await driver.upload('/big.bin', new Uint8Array(10), { size: 10 })
    expect(slices).toHaveLength(2)
    expect(completed).toBe(true)
  })
})
