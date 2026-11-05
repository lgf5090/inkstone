// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create123ShareDriver } from '../src/worker/clouddrive/drivers/123_share'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    sharePassword: 'pwd',
    accessToken: 'access-token',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: '123_share',
    config: { shareKey: 'share-key', rootFolderId: '0', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FOLDER = { FileId: 101, FileName: 'folder_a', Type: 1, Size: 0, UpdateAt: '2026-08-24T12:00:00Z' }
const FILE_B = { FileId: 102, FileName: 'file_b.mp4', Type: 0, Size: 1_048_576, UpdateAt: '2026-08-24T12:00:00Z' }
const FILE_C = { FileId: 103, FileName: 'file_c.txt', Type: 0, Size: 10, UpdateAt: '2026-08-25T12:00:00Z' }

function sharePage(files: Array<Record<string, unknown>>, next: string): Response {
  return json({ code: 200, message: 'ok', data: { InfoList: files, Next: next, Total: files.length } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('123Pan share driver', () => {
  it('walks Page while following the Next cursor', async () => {
    const pages: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/share/get')) throw new Error(`unexpected ${url}`)
      const params = new URL(url).searchParams
      expect(params.get('shareKey')).toBe('share-key')
      expect(params.get('SharePwd')).toBe('pwd')
      const page = params.get('Page') ?? ''
      pages.push(page)
      return page === '2' ? sharePage([FILE_C], '-1') : sharePage([FOLDER, FILE_B], '2')
    })

    const driver = create123ShareDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['folder_a', 'file_b.mp4'])
    expect(first.entries[0]!.kind).toBe('folder')
    expect(first.entries[1]!.size).toBe(1_048_576)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['file_c.txt'])
    expect(second.cursor).toBeNull()
    expect(pages).toEqual(['1', '2'])
  })

  it('marks the storage for re-authorization when the share token is refused', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ code: 401, message: 'token expired' }))
    const driver = create123ShareDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps a business rate-limit code to rate_limit', async () => {
    const fetchMock = vi.fn(async () => json({ code: 429, message: 'too many requests' }))
    vi.stubGlobal('fetch', fetchMock)
    const driver = create123ShareDriver(context())

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a missing file as not_found', async () => {
    vi.stubGlobal('fetch', async () => sharePage([], '-1'))
    const driver = create123ShareDriver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range and Referer to the resolved share download link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/share/get')) return sharePage([FILE_C], '-1')
      if (url.includes('/share/download/info')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          shareKey: 'share-key',
          SharePwd: 'pwd',
          fileId: FILE_C.FileId,
          size: FILE_C.Size,
        })
        return json({ code: 200, data: { DownloadURL: 'https://download.123pan.cn/file_c.txt' } })
      }
      if (url === 'https://download.123pan.cn/file_c.txt') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=0-4')
        expect(headers.get('Referer')).toBe('https://yun.123pan.com/')
        return new Response('abcde', { status: 206, headers: { 'content-range': 'bytes 0-4/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create123ShareDriver(context())
    const response = await driver.read('/file_c.txt', 'bytes=0-4')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcde')
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create123ShareDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps read-only capabilities and leaves copy undefined', async () => {
    const driver = create123ShareDriver(context())
    expect(driver.definition).toBe(findCloudDriveDriver('123_share'))
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    await expect(driver.mkdir('/folder_a')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/file.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({
      kind: 'unsupported',
    })
  })
})
