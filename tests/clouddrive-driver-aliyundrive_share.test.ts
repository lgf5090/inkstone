// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAliyundriveShareDriver } from '../src/worker/clouddrive/drivers/aliyundrive_share'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    sharePwd: 'pwd1',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: USER,
    storageId: STORAGE,
    type: 'aliyundrive_share',
    config: { shareId: 'share-1', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = {
  drive_id: 'drive-1', file_id: 'f1', name: 'a.txt', size: 10, type: 'file',
  updated_at: '2026-01-01T00:00:00Z',
}
const FOLDER = {
  drive_id: 'drive-1', file_id: 'd1', name: 'docs', type: 'folder',
  updated_at: '2026-01-02T00:00:00Z',
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Aliyundrive Share driver', () => {
  it('walks markers so a later page continues where the previous page ended', async () => {
    const markers: Array<string | null> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/v2/share_link/get_share_token')) {
        return json({ share_token: 'share-token', expires_in: 7200 })
      }
      if (url.pathname.endsWith('/adrive/v3/file/list')) {
        const body = requestBody(init)
        const marker = typeof body.marker === 'string' ? body.marker : null
        markers.push(marker)
        return marker === null
          ? json({ items: [FILE_A], next_marker: 'm2' })
          : json({ items: [FOLDER] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createAliyundriveShareDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('m2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(markers.at(-1)).toBe('m2')
  })

  it('marks the storage for re-authorization when the share token is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
    const driver = createAliyundriveShareDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createAliyundriveShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/v2/share_link/get_share_token')) {
        return json({ share_token: 'share-token', expires_in: 7200 })
      }
      return new Response('', { status: 404 })
    })
    const driver = createAliyundriveShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the download URL with the Alipan Referer', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/v2/share_link/get_share_token')) {
        return json({ share_token: 'share-token', expires_in: 7200 })
      }
      if (url.pathname.endsWith('/adrive/v3/file/list')) {
        return json({ items: [FILE_A] })
      }
      if (url.pathname.endsWith('/v2/file/get_share_link_download_url')) {
        return json({ download_url: 'https://cdn.example/ali.bin' })
      }
      if (url.toString() === 'https://cdn.example/ali.bin') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=4-7')
        expect(headers.get('Referer')).toBe('https://www.aliyundrive.com/')
        expect(headers.get('User-Agent')).toContain('Mozilla/5.0')
        return new Response('body', { status: 206, headers: { 'content-range': 'bytes 4-7/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createAliyundriveShareDriver(context())
    const response = await driver.read('/a.txt', 'bytes=4-7')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('body')
  })

  it('uses the refresh token as the visitor identity and persists its rotation', async () => {
    const save = vi.fn(async () => undefined)
    const authorization: Array<string | null> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'auth.alipan.com') {
        return json({ access_token: 'visitor-token', refresh_token: 'rotated', expires_in: 7200 })
      }
      if (url.pathname.endsWith('/v2/share_link/get_share_token')) {
        return json({ share_token: 'share-token', expires_in: 7200 })
      }
      if (url.pathname.endsWith('/adrive/v3/file/list')) {
        authorization.push(new Headers(init?.headers).get('authorization'))
        return json({ items: [FILE_A] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createAliyundriveShareDriver(context({
      credentials: { sharePwd: 'pwd1', refreshToken: 'visitor-refresh' },
      saveCredentials: save,
    }))
    const listing = await driver.list('/')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(save).toHaveBeenCalledWith({ refreshToken: 'rotated' })
    expect(authorization).toEqual(['Bearer visitor-token'])
    expect(driver.copy).toBeUndefined()
    expect(driver.capabilities.write).toBe(false)
  })

  it('rejects an invalid path before any network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createAliyundriveShareDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/a/../b.txt')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
