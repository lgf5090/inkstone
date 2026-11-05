// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWeiyunDriver } from '../src/worker/clouddrive/drivers/weiyun'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function envelope(body: unknown): Response {
  return json({ ret: 0, data: { rsp_body: { RspMsg_body: body } } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookies: 'uid=10001; wxopenid=openid-1; wy_uf=2; wyctoken=token-1',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'weiyun',
    config: { rootFolderId: 'root', uploadThread: 3, ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function folderPathResponse(): Response {
  return envelope({ items: [{ dir_key: 'root', pdir_key: '', dir_name: 'root' }] })
}

function listResponse(folders: Array<Record<string, unknown>>, files: Array<Record<string, unknown>>, finish: boolean): Response {
  return envelope({ dir_list: folders, file_list: files, finish_flag: finish })
}

const FILE_A = { file_id: 'f1', filename: 'a.txt', file_size: 10, file_mtime: 1_700_000_000 }
const FILE_B = { file_id: 'f2', filename: 'b.pdf', file_size: 20, file_mtime: 1_700_000_100 }
const FOLDER = { dir_key: 'd1', dir_name: 'docs', dir_mtime: 1_700_000_200 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Weiyun driver', () => {
  it('walks pages and returns the requested offset page plus its cursor', async () => {
    let lists = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('LibDirPathGet')) return folderPathResponse()
      if (url.includes('DiskDirList')) {
        lists += 1
        return lists === 1 ? listResponse([], [FILE_A, FILE_B], false) : listResponse([FOLDER], [], true)
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createWeiyunDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.entries[1]!.modifiedAt).toBe(FILE_B.file_mtime * 1000)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(lists).toBe(2)
  })

  it('marks the storage for re-authorization when the cookie is refused', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('LibDirPathGet')) return folderPathResponse()
      if (url.includes('DiskDirList')) return new Response('', { status: 403 })
      throw new Error(`unexpected ${url}`)
    })

    const driver = createWeiyunDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('LibDirPathGet')) return folderPathResponse()
      return new Response('', { status: 429, headers: { 'retry-after': '0.001' } })
    })
    const driver = createWeiyunDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('LibDirPathGet')) return folderPathResponse()
      return new Response('', { status: 404 })
    })
    const driver = createWeiyunDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range and the download cookie pair and returns the 206 body', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('LibDirPathGet')) return folderPathResponse()
      if (url.includes('DiskDirList')) return listResponse([], [FILE_A], true)
      if (url.includes('DiskFileBatchDownload')) {
        return envelope({ file_list: [{ download_url: 'https://cdn.example/a.txt', cookie_name: 'dl', cookie_value: 'v1' }] })
      }
      if (url === 'https://cdn.example/a.txt') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=2-5')
        expect(headers.get('Cookie')).toBe('dl=v1')
        expect(headers.get('User-Agent')).toContain('Chrome/120')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createWeiyunDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createWeiyunDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pre-uploads, posts every chunk and waits for the completion state', async () => {
    const size = 2 * 1024 * 1024 + 1
    const bytes = new Uint8Array(size)
    let uploads = 0
    const progress: number[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('LibDirPathGet')) return folderPathResponse()
      if (url.includes('ftn_pre_upload')) {
        return envelope({ weiyunPreUploadMsgRsp_body: { file_exist: false, upload_key: 'key-1', ex: 'ex-1' } })
      }
      if (url.startsWith('https://upload.weiyun.com/')) {
        expect(init?.method).toBe('POST')
        uploads += 1
        return envelope({ 'weiyun.UploadPieceMsgRsp_body': { upload_state: uploads >= 3 ? 2 : 1 } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createWeiyunDriver(context())
    await driver.upload('/big.bin', bytes, { size, onProgress: (done) => progress.push(done) })
    expect(uploads).toBe(3)
    expect([...progress].sort((left, right) => left - right)).toEqual([1024 * 1024, 2 * 1024 * 1024, size])
  })

  it('keeps its capability bits in step with the registry and omits copy', () => {
    const driver = createWeiyunDriver(context())
    expect(driver.definition).toBe(findCloudDriveDriver('weiyun'))
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeTypeOf('function')
  })
})
