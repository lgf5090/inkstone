// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create189Driver } from '../src/worker/clouddrive/drivers/189'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

const RSA_KEY =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDY7mpaUysvgQkIiL9M6PxYcKGOXe0elNAk' +
  'kkh/v0fzfx6cGrJnLlh5G0H8qPUvhLHh+U4xqRMN8C7KKKHmCQ1Xq5KLJCBM6pq9W2KU2R1q' +
  'g5SrCAqHq5KXJHM7TpjD/yH0u8KpY2H5U3WwR5N9LCdTw2XP6YqOvAx8kKqM3N8mKQIDAQAB'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'SESSION=valid',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-189',
    storageId: 'storage-189',
    type: '189',
    config: { username: '', rootFolderId: '-11', pageSize: '60', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function listData(files: Array<Record<string, unknown>>, folders: Array<Record<string, unknown>> = [], count = files.length + folders.length): Response {
  return json({ res_code: 0, fileListAO: { count, fileList: files, folderList: folders } })
}

const FILE_A = { id: 101, name: 'a.txt', size: 10, lastOpTime: '2026-01-01T00:00:00Z' }
const FILE_B = { id: 102, name: 'b.pdf', size: 20, lastOpTime: '2026-01-02T00:00:00Z' }
const FOLDER = { id: 103, name: 'docs', lastOpTime: '2026-01-03T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('189 driver', () => {
  it('walks pages and returns the requested page plus its cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/open/file/listFiles.action')) {
        const params = new URL(url).searchParams
        const pageSize = Number(params.get('pageSize'))
        const pageNum = Number(params.get('pageNum'))
        if (pageSize === 1) return listData([FILE_A], [], 3)
        return pageNum === 2 ? listData([], [FOLDER], 3) : listData([FILE_A, FILE_B], [], 3)
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create189Driver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.cursor).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it('marks the storage for re-authorization when the Cookie is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/open/file/listFiles.action')) return new Response('expired', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create189Driver(context({ credentials: { cookie: 'bad' }, markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps a 429 from the listing endpoint to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/open/file/listFiles.action')) {
        const pageSize = Number(new URL(url).searchParams.get('pageSize'))
        if (pageSize === 1) return listData([FILE_A], [], 2)
        return new Response('slow down', { status: 429 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = create189Driver(context())
    await expect(driver.list('/', { page: 1, pageSize: 2 })).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a 404 on the download-info endpoint to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/open/file/listFiles.action')) return listData([FILE_A])
      if (url.includes('/portal/getFileInfo.action')) return new Response('gone', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create189Driver(context())
    await expect(driver.read('/a.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the download URL and preserves the 206 answer', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/open/file/listFiles.action')) return listData([FILE_A])
      if (url.includes('/portal/getFileInfo.action')) {
        return json({ res_code: 0, fileDownloadUrl: 'https://cdn.example/a.txt' })
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
    const driver = create189Driver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects an escaping path before issuing any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create189Driver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.remove('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploads a file in two parts and commits the upload', async () => {
    const bytes = new Uint8Array(8).fill(9)
    const puts: string[] = []
    let committed = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/open/file/listFiles.action')) return listData([])
      if (url.includes('/v2/getUserBriefInfo.action')) return json({ res_code: 0, sessionKey: 'sk' })
      if (url.includes('/security/generateRsaKey.action')) {
        return json({ res_code: 0, pubKey: RSA_KEY, pkId: 'pk-1', expire: Date.now() + 60_000 })
      }
      if (url.includes('/person/initMultiUpload')) {
        return json({ code: 'SUCCESS', data: { uploadFileId: 'upload-1', fileDataExists: 0 } })
      }
      if (url.includes('/person/getMultiUploadUrls')) {
        return json({
          code: 'SUCCESS',
          uploadUrls: {
            partNumber_1: { requestURL: 'https://upload.example/1', requestHeader: 'x-test=1' },
            partNumber_2: { requestURL: 'https://upload.example/2', requestHeader: 'x-test=2' },
          },
        })
      }
      if (url.startsWith('https://upload.example/')) {
        expect(init?.method).toBe('PUT')
        puts.push(url)
        return new Response('', { status: 200 })
      }
      if (url.includes('/person/commitMultiUploadFile')) {
        committed = true
        return json({ code: 'SUCCESS', data: {} })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create189Driver(context({ config: { username: '', rootFolderId: '-11', uploadPartSize: '4' } }))
    await driver.upload('/big.bin', bytes, { size: 8 })
    expect(puts).toHaveLength(2)
    expect(committed).toBe(true)
  })

  it('exposes the registered capabilities', () => {
    const driver = create189Driver(context())
    const definition = findCloudDriveDriver('189')!
    expect(driver.capabilities).toEqual(definition.capabilities)
    expect(driver.capabilities.copy).toBe(true)
  })
})
