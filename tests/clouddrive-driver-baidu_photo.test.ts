// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBaiduPhotoDriver } from '../src/worker/clouddrive/drivers/baidu_photo'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'
const UPLOAD_CHUNK = 4 * 1024 * 1024

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'BDUSS=session',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: USER,
    storageId: STORAGE,
    type: 'baidu_photo',
    config: { showType: 'root_only_file', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = { fsid: 11, path: '/photos/a.jpg', size: 10, mtime: 1_700_000_000 }
const FILE_B = { fsid: 12, path: '/photos/b.jpg', size: 20, mtime: 1_700_000_100 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Baidu Photo driver', () => {
  it('follows the cursor until the listing reports no more pages', async () => {
    const cursors: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/file/v1/list')) throw new Error(`unexpected ${url}`)
      const cursor = url.searchParams.get('cursor') ?? ''
      cursors.push(cursor)
      return cursor === ''
        ? json({ list: [FILE_A], has_more: 1, cursor: 'c2' })
        : json({ list: [FILE_B], has_more: 0 })
    })

    const driver = createBaiduPhotoDriver(context())
    const listing = await driver.list('/')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(cursors).toEqual(['', 'c2'])
    expect(listing.truncated).toBe(false)
  })

  it('marks the storage for re-authorization when the cookie is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
    const driver = createBaiduPhotoDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createBaiduPhotoDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = createBaiduPhotoDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to a root photo link with the Baidu Photo Referer', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/file/v1/list')) return json({ list: [FILE_A], has_more: 0 })
      if (url.pathname.endsWith('/file/v2/download')) return json({ dlink: 'https://cdn.example/photo.jpg' })
      if (url.toString() === 'https://cdn.example/photo.jpg') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=0-3')
        expect(headers.get('Referer')).toBe('https://photo.baidu.com/')
        expect(headers.get('User-Agent')).toContain('Mozilla/5.0')
        return new Response('jpeg', { status: 206 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createBaiduPhotoDriver(context())
    const response = await driver.read('/a.jpg', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('jpeg')
  })

  it('uploads through superfile2 in 4 MiB parts', async () => {
    const size = UPLOAD_CHUNK + 1
    const bytes = new Uint8Array(size)
    const parts: string[] = []
    const progress: number[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/user/v1/getuinfo')) return json({ youa_id: '123' })
      if (url.hostname === 'pan.baidu.com') return json({ result: { bdstoken: 'bd-token' } })
      if (url.pathname.endsWith('/file/v1/precreate')) {
        return json({ return_type: 1, uploadid: 'up-1', block_list: [0, 1] })
      }
      if (url.hostname === 'c3.pcs.baidu.com') {
        expect(init?.method).toBe('POST')
        parts.push(url.searchParams.get('partseq') ?? '')
        return new Response('', { status: 200 })
      }
      if (url.pathname.endsWith('/file/v1/create')) return json({ return_type: 1, data: { fs_id: 77 } })
      throw new Error(`unexpected ${url}`)
    })

    const driver = createBaiduPhotoDriver(context())
    await driver.upload('/upload.jpg', bytes, {
      size,
      onProgress: (uploaded) => progress.push(uploaded),
    })
    expect(parts).toEqual(['0', '1'])
    expect(progress.at(-1)).toBe(size)
  })

  it('rejects an invalid path before any network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createBaiduPhotoDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/a/../b.jpg')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.upload('/a/../b.jpg', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps mkdir/copy unsupported while exposing the declared write methods', async () => {
    const driver = createBaiduPhotoDriver(context())
    expect(driver.capabilities.mkdir).toBe(false)
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.capabilities.rename).toBe(true)
    expect(driver.capabilities.move).toBe(true)
    expect(driver.copy).toBeUndefined()
    await expect(driver.mkdir('/new-album')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
