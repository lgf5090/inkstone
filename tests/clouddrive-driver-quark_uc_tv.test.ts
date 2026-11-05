// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuarkUcTvDriver } from '../src/worker/clouddrive/drivers/quark_uc_tv'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    refreshToken: 'refresh-token',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'quark_uc_tv',
    config: { variant: 'quark', deviceId: 'device-1', linkMethod: 'download', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = { fid: 'f1', filename: 'a.txt', size: 10, isdir: 0, updated_at: 1_700_000_000 }
const FILE_B = { fid: 'f2', filename: 'b.mp4', size: 20, isdir: 0, updated_at: 1_700_000_100 }
const FOLDER = { fid: 'd1', filename: 'docs', size: 0, isdir: 1, updated_at: 1_700_000_200 }

function refreshResponse(): Response {
  return json({ code: 200, data: { access_token: 'access-1', refresh_token: 'refresh-token' } })
}

function fileResponse(files: Array<Record<string, unknown>>, total: number): Response {
  return json({ status: 0, errno: 0, data: { files, total_count: total } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Quark UC TV driver', () => {
  it('refreshes the token and walks pages with the requested cursor', async () => {
    const listPages: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/token')) return refreshResponse()
      if (url.includes('open-api-drive.quark.cn/file')) {
        const index = new URL(url).searchParams.get('page_index') ?? ''
        listPages.push(index)
        return index === '1' ? fileResponse([FOLDER], 3) : fileResponse([FILE_A, FILE_B], 3)
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createQuarkUcTvDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.mp4'])
    expect(first.entries[0]!.modifiedAt).toBe(FILE_A.updated_at * 1000)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(listPages).toEqual(['0', '1'])
  })

  it('reports a failed refresh as auth and marks the storage for re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
    const driver = createQuarkUcTvDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps the TV rate-limit errno to rate_limit', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/token')) return refreshResponse()
      return json({ status: 429, errno: 0, error_info: 'too many requests' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const driver = createQuarkUcTvDriver(context())

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports a missing folder as not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/token')) return refreshResponse()
      if (url.includes('/file')) return fileResponse([], 0)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createQuarkUcTvDriver(context())
    await expect(driver.list('/missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the resolved TV download URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/token')) return refreshResponse()
      if (url.includes('method=list')) return fileResponse([FILE_A], 1)
      if (url.includes('method=download')) {
        return json({ status: 0, errno: 0, data: { download_url: 'https://cdn.example/a.txt' } })
      }
      if (url === 'https://cdn.example/a.txt') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=0-3')
        expect(headers.get('User-Agent')).toContain('Android')
        return new Response('abcd', { status: 206, headers: { 'content-range': 'bytes 0-3/10', 'content-length': '4' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createQuarkUcTvDriver(context())
    const response = await driver.read('/a.txt', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcd')
  })

  it('refuses an escaping path before it refreshes the token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createQuarkUcTvDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exposes only the read capabilities and leaves copy undefined', async () => {
    const driver = createQuarkUcTvDriver(context())
    expect(driver.definition).toBe(findCloudDriveDriver('quark_uc_tv'))
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    await expect(driver.mkdir('/docs')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({
      kind: 'unsupported',
    })
  })
})
