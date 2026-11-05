// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMopanDriver } from '../src/worker/clouddrive/drivers/mopan'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    password: 'secret',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'mopan',
    config: { phone: '13800000000', rootFolderId: 'root-1', cloudId: '', uploadThread: 3, ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function loginResponse(): Response {
  return json({ code: 200, data: { token: 'session-token', userCloudStorageRelations: [{ folderID: 'root-1', path: '/文件' }] } })
}

function userResponse(): Response {
  return json({ code: 200, data: { userID: 'user-1', nickname: 'owner' } })
}

function listResponse(folders: Array<Record<string, unknown>>, files: Array<Record<string, unknown>>): Response {
  return json({ code: 200, data: { fileListAO: { folderList: folders, fileList: files } } })
}

const FILE_A = { id: 'f1', name: 'a.txt', size: 10, lastOpTime: '2026-01-01T00:00:00Z' }
const FILE_B = { id: 'f2', name: 'b.pdf', size: 20, lastOpTime: '2026-01-02T00:00:00Z' }
const FOLDER = { id: 'd1', name: 'docs', lastOpTime: '2026-01-03T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MoPan driver', () => {
  it('walks pages and returns the requested page plus its cursor', async () => {
    let queries = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/login')) return loginResponse()
      if (url.endsWith('/getUserInfo')) return userResponse()
      if (url.endsWith('/queryFiles')) {
        queries += 1
        return queries === 1 ? listResponse([], [FILE_A, FILE_B]) : listResponse([FOLDER], [])
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMopanDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.entries[0]!.modifiedAt).toBe(Date.parse(FILE_A.lastOpTime))
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(queries).toBe(2)
  })

  it('marks the storage for re-authorization when the session is refused', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/login')) return loginResponse()
      if (url.endsWith('/getUserInfo')) return userResponse()
      if (url.endsWith('/queryFiles')) return json({ code: 401, message: 'session expired' })
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMopanDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0.001' } }))
    const driver = createMopanDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/login')) return loginResponse()
      if (url.endsWith('/getUserInfo')) return userResponse()
      if (url.endsWith('/queryFiles')) return new Response('', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createMopanDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the resolved download link and returns the 206 body', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/login')) return loginResponse()
      if (url.endsWith('/getUserInfo')) return userResponse()
      if (url.endsWith('/queryFiles')) return listResponse([], [FILE_A])
      if (url.endsWith('/getFileDownloadUrl')) {
        return json({ code: 200, data: { downloadUrl: 'https://cdn.example/file.bin' } })
      }
      if (url === 'https://cdn.example/file.bin') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=2-5')
        expect(headers.get('User-Agent')).toContain('inkstone-clouddrive')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMopanDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createMopanDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploads two or more parts, reports progress after each PUT, and commits', async () => {
    const size = 10
    const bytes = new Uint8Array(size)
    const uploaded: string[] = []
    const progress: number[] = []
    let committed = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/login')) return loginResponse()
      if (url.endsWith('/getUserInfo')) return userResponse()
      if (url.endsWith('/initMultiUpload')) {
        return json({ code: 200, data: { uploadFileID: 'up-1', partInfos: ['p1', 'p2', 'p3'], fileDataExists: false, partSize: 4 } })
      }
      if (url.endsWith('/getAllMultiUploadUrls')) {
        return json({
          code: 200,
          data: [
            { partNumber: 1, uploadUrl: 'https://upload.example/1' },
            { partNumber: 2, uploadUrl: 'https://upload.example/2' },
            { partNumber: 3, uploadUrl: 'https://upload.example/3' },
          ],
        })
      }
      if (url.startsWith('https://upload.example/')) {
        expect(init?.method).toBe('PUT')
        uploaded.push(url)
        return new Response('', { status: 200 })
      }
      if (url.endsWith('/commitMultiUploadFile')) {
        committed = true
        return json({ code: 200, data: {} })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMopanDriver(context())
    await driver.upload('/big.bin', bytes, {
      size,
      contentType: 'application/octet-stream',
      onProgress: (done) => progress.push(done),
    })
    expect(uploaded).toHaveLength(3)
    expect([...progress].sort((left, right) => left - right)).toEqual([4, 8, 10])
    expect(committed).toBe(true)
  })

  it('keeps its capability bits in step with the registry', () => {
    const driver = createMopanDriver(context())
    expect(driver.definition).toBe(findCloudDriveDriver('mopan'))
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.copy).toBeTypeOf('function')
    expect(driver.directLink).toBeTypeOf('function')
  })
})
