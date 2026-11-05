// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGooglePhotoDriver } from '../src/worker/clouddrive/drivers/google-photo'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { refreshToken: 'r1', clientId: 'cid', clientSecret: 'secret', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-gp',
    type: 'google_photo',
    config: {},
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const API = 'https://photoslibrary.googleapis.com/v1'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const PHOTO = {
  id: 'p1',
  filename: 'a.jpg',
  baseUrl: 'https://photos.example/a1',
  mimeType: 'image/jpeg',
  mediaMetadata: { creationTime: '2026-01-01T00:00:00Z' },
}
const PHOTO2 = { ...PHOTO, id: 'p2', filename: 'b.jpg', baseUrl: 'https://photos.example/a2' }

function token(): Response {
  return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
}

function searchBody(init?: RequestInit): Record<string, string> {
  return init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Google Photos driver', () => {
  it('walks pageToken pages and returns the requested page and cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url === `${API}/mediaItems:search`) {
        const pageToken = searchBody(init).pageToken ?? ''
        calls.push(pageToken)
        if (pageToken === 'p2') return json({ mediaItems: [PHOTO2] })
        return json({ mediaItems: [PHOTO], nextPageToken: 'p2' })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGooglePhotoDriver(context())

    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.jpg'])
    expect(first.entries[0]!.kind).toBe('file')
    expect(first.cursor).toBe('p2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.jpg'])
    expect(second.cursor).toBeNull()

    const all = await driver.list('/', {})
    expect(all.entries.map((entry) => entry.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(all.truncated).toBe(false)
    // Each page restarts the token walk, so page 2 costs two search calls and the full walk costs
    // three: one for page 1 plus two for page 2.
    expect(calls).toHaveLength(6)
  })

  it('maps a rejected refresh to auth and marks the storage for reauthorization', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        return json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400)
      }
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createGooglePhotoDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markNeedsReauth).toHaveBeenCalled()
  })

  it('maps 429 to rate_limit and 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return new Response('', { status: 429 })
    })
    await expect(createGooglePhotoDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url === `${API}/mediaItems:search`) return json({ error: { message: 'not found' } }, 404)
      throw new Error(`unexpected ${url}`)
    })
    await expect(createGooglePhotoDriver(context()).stat('/missing.jpg')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('reads the baseUrl with =d, forwards Range, and does not advertise direct links', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url === `${API}/mediaItems:search`) return json({ mediaItems: [PHOTO] })
      if (url === 'https://photos.example/a1=d') {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer a1')
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGooglePhotoDriver(context())
    const response = await driver.read('/a.jpg', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
    expect(driver.capabilities.directLink).toBe(false)
    expect(driver.capabilities.write).toBe(false)
  })

  it('refreshes once when two concurrent calls share one storage', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === `${API}/mediaItems:search`) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fresh')
        return json({ mediaItems: [PHOTO] })
      }
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context({ accessToken: 'old', expiresAt: String(Date.now() - 1_000), refreshToken: 'r1' })
    const driver = createGooglePhotoDriver(ctx)
    const [first, second] = await Promise.all([driver.list('/'), driver.list('/')])
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.jpg'])
    expect(second.entries.map((entry) => entry.name)).toEqual(['a.jpg'])
    expect(tokenCalls).toBe(1)
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createGooglePhotoDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
