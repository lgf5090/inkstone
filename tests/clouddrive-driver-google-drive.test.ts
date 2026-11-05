// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGoogleDriveDriver } from '../src/worker/clouddrive/drivers/google-drive'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { refreshToken: 'r1', clientId: 'cid', clientSecret: 'secret', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-gd',
    type: 'google_drive',
    config: { folderId: 'root' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FILES = 'https://www.googleapis.com/drive/v3/files'
const FILE = { id: 'f1', name: 'a.txt', mimeType: 'text/plain', size: '10', modifiedTime: '2026-01-01T00:00:00Z' }
const FOLDER = { id: 'd1', name: 'docs', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-02T00:00:00Z' }

function token(): Response {
  return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Google Drive driver', () => {
  it('walks pageToken pages and returns the requested page plus its cursor', async () => {
    const listCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url.startsWith(`${FILES}?`)) {
        listCalls.push(url)
        const pageToken = new URL(url).searchParams.get('pageToken')
        if (!pageToken) return json({ files: [FILE], nextPageToken: 'p2' })
        return json({ files: [FOLDER] })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGoogleDriveDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('p2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries[0]!.name).toBe('docs')
    expect(second.entries[0]!.kind).toBe('folder')
    expect(listCalls).toHaveLength(3)
  })

  it('refreshes the access token once when Drive answers 401', async () => {
    let tokenCalls = 0
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url.startsWith(`${FILES}?`)) {
        listCalls++
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer stale') return json({ error: { code: 401 } }, 401)
        return json({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGoogleDriveDriver(context({ accessToken: 'stale', expiresAt: String(Date.now() + 3_600_000), refreshToken: 'r1' }))
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(listCalls).toBe(2)
  })

  it('maps 404 and 429', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return json({ error: { message: 'not found' } }, 404)
    })
    await expect(createGoogleDriveDriver(context()).stat('/docs')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return new Response('', { status: 429 })
    })
    await expect(createGoogleDriveDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('streams a file with the Range header and no direct link capability', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url.startsWith(`${FILES}?`)) return json({ files: [FILE] })
      if (url.startsWith(`${FILES}/f1?alt=media`)) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGoogleDriveDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(driver.capabilities.directLink).toBe(false)
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createGoogleDriveDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
