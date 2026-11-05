// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAliyunDriveOpenDriver } from '../src/worker/clouddrive/drivers/aliyundrive-open'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const API = 'https://openapi.aliyundrive.com/adrive/v1.0'
const TOKEN = 'https://openapi.alipan.com/oauth/access_token'
const LIST = `${API}/openFile/list`
const PART_SIZE = 20 * 1024 * 1024

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-aliyun-open',
  markNeedsReauth: DriverContext['markNeedsReauth'] = vi.fn(async () => undefined),
): DriverContext {
  const stored: Record<string, string> = {
    accessToken: 'valid', refreshToken: 'r1', clientId: 'client-1', clientSecret: 'secret', ...credentials,
  }
  return {
    userId: 'user-a',
    storageId,
    type: 'aliyundrive_open',
    config: { driveId: 'drive-1', driveType: 'default', rootFolderId: 'root' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth,
  }
}

const FILE = { file_id: 'f1', name: 'a.txt', type: 'file', size: 10, updated_at: '2026-01-01T00:00:00Z' }
const FOLDER = { file_id: 'd1', name: 'docs', type: 'folder', updated_at: '2026-01-02T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Aliyundrive Open driver', () => {
  it('walks marker pages and returns the requested page with its cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === LIST) {
        calls.push(url)
        const marker = JSON.parse(String(init?.body ?? '{}')).marker
        return marker === 'm2'
          ? json({ items: [FOLDER] })
          : json({ items: [FILE], next_marker: 'm2' })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAliyunDriveOpenDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('m2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.truncated).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('marks the storage for re-authorization when the token refresh is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === LIST) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAliyunDriveOpenDriver(context({
      accessToken: 'stale',
      expiresAt: String(Date.now() + 3_600_000),
    }, 'storage-aliyun-auth', mark))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps a throttled list call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === LIST) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(createAliyunDriveOpenDriver(context({}, 'storage-aliyun-429')).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === LIST) return new Response('', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    await expect(createAliyunDriveOpenDriver(context({}, 'storage-aliyun-404')).stat('/missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createAliyunDriveOpenDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes the token once when two requests race', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === LIST) return json({ items: [] })
      throw new Error(`unexpected ${url}`)
    })
    const first = createAliyunDriveOpenDriver(context({ accessToken: '', expiresAt: '0' }, 'storage-aliyun-race'))
    await Promise.all([first.list('/'), first.list('/')])
    expect(tokenCalls).toBe(1)
  })

  it('uploads two parts and completes the session', async () => {
    const puts: string[] = []
    let completed = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${API}/openFile/create`) {
        return json({
          file_id: 'f1',
          upload_id: 'u1',
          rapid_upload: false,
          part_info_list: [
            { part_number: 1, upload_url: 'https://upload.aliyun.example/1' },
            { part_number: 2, upload_url: 'https://upload.aliyun.example/2' },
          ],
        })
      }
      if (url.startsWith('https://upload.aliyun.example/')) {
        expect(init?.method).toBe('PUT')
        puts.push(url)
        return new Response('', { status: 200 })
      }
      if (url === `${API}/openFile/complete`) {
        completed = true
        return json({ file_id: 'f1' })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAliyunDriveOpenDriver(context())
    await driver.upload('/big.bin', new Uint8Array(PART_SIZE + 1), { size: PART_SIZE + 1 })
    expect(puts).toHaveLength(2)
    expect(completed).toBe(true)
  })
})
