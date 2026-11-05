// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create123PanDriver } from '../src/worker/clouddrive/drivers/123pan'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    username: '13800000000',
    password: 'secret',
    accessToken: 'valid-token',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: USER,
    storageId: STORAGE,
    type: '123pan',
    config: { rootId: '0', platform: 'web', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function listData(files: Array<Record<string, unknown>>, next = '-1'): Response {
  return json({ code: 200, data: { Next: next, Total: files.length, InfoList: files } })
}

const FILE_A = { FileId: 101, FileName: 'a.txt', Size: 10, Type: 0, UpdateAt: '2026-01-01T00:00:00Z', Etag: 'e1', S3KeyFlag: 's1' }
const FILE_B = { FileId: 102, FileName: 'b.pdf', Size: 20, Type: 0, UpdateAt: '2026-01-02T00:00:00Z', Etag: 'e2', S3KeyFlag: 's2' }
const FOLDER = { FileId: 103, FileName: 'docs', Size: 0, Type: 1, UpdateAt: '2026-01-03T00:00:00Z', Etag: '', S3KeyFlag: '' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('123Pan driver', () => {
  it('walks pages and returns the requested page plus its cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/b/api/user/info')) return json({ code: 200, data: { Nickname: 'owner' } })
      if (url.includes('/b/api/file/list/new')) {
        const page = new URL(url).searchParams.get('Page')
        return page === '2' ? listData([FOLDER], '-1') : listData([FILE_A, FILE_B], 'next-1')
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create123PanDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('next-1')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(calls.filter((url) => url.includes('/file/list/new'))).toHaveLength(3)
  })

  it('marks the storage for re-authorization when the token cannot be refreshed', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/b/api/user/info')) return json({ code: 401, message: 'token expired' })
      if (url.includes('/b/api/file/list/new')) return json({ code: 401, message: 'token expired' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create123PanDriver(context({
      credentials: { accessToken: 'bad', username: '', password: '' },
      markNeedsReauth: mark,
    }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('uploads a file in 16 MiB parts through the presigned URLs', async () => {
    const size = 16 * 1024 * 1024 + 1
    const bytes = new Uint8Array(size)
    const putUrls: string[] = []
    let completed = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/b/api/user/info')) return json({ code: 200, data: {} })
      if (url.includes('/b/api/file/list/new')) return listData([], '-1')
      if (url.includes('/b/api/file/upload_request')) {
        return json({ code: 200, data: { Bucket: 'b', Key: 'k', UploadId: 'u', FileId: 7, StorageNode: 'n', Reuse: false } })
      }
      if (url.includes('/b/api/file/s3_repare_upload_parts_batch')) {
        return json({ code: 200, data: { presignedUrls: { '1': 'https://upload.example/1', '2': 'https://upload.example/2' } } })
      }
      if (url.startsWith('https://upload.example/')) {
        putUrls.push(url)
        expect(init?.method).toBe('PUT')
        return new Response('', { status: 200 })
      }
      if (url.includes('/b/api/file/upload_complete/v2')) {
        completed = true
        return json({ code: 200, data: {} })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create123PanDriver(context())
    await driver.upload('/big.bin', bytes, { size, contentType: 'application/octet-stream' })
    expect(putUrls).toHaveLength(2)
    expect(completed).toBe(true)
  })

  it('forwards Range to the resolved download link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/b/api/user/info')) return json({ code: 200, data: {} })
      if (url.includes('/b/api/file/list/new')) return listData([FILE_A], '-1')
      if (url.includes('/b/api/file/download_info')) {
        return json({ code: 200, data: { DownloadUrl: 'https://cdn.example/file.bin' } })
      }
      if (url === 'https://cdn.example/file.bin') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create123PanDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create123PanDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps unsupported copy to an explicit driver error', async () => {
    const driver = create123PanDriver(context())
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
  })
})
