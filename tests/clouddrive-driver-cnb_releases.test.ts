// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCnbReleasesDriver } from '../src/worker/clouddrive/drivers/cnb_releases'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const RELEASE = {
  id: 'rel-1',
  name: 'v1.0.0',
  tag_name: 'v1.0.0',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  assets: [
    {
      id: 'asset-1',
      name: 'file.zip',
      size: 5,
      path: '/org/repo/-/releases/download/file.zip',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    },
  ],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    ...overrides,
    userId: overrides.userId ?? 'user-a',
    storageId: overrides.storageId ?? 'storage-a',
    type: overrides.type ?? 'cnb_releases',
    config: { repo: 'org/repo', useTagName: false, defaultBranch: 'main', ...(overrides.config ?? {}) },
    credentials: { token: 'tkn', ...(overrides.credentials ?? {}) },
    saveCredentials: overrides.saveCredentials ?? vi.fn(async () => undefined),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CNB Releases driver', () => {
  it('lists releases at the root and their assets inside a release folder', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://api.cnb.cool/org/repo/-/releases') return json([RELEASE])
      throw new Error(`unexpected ${url}`)
    })

    const driver = createCnbReleasesDriver(context())
    const root = await driver.list('/')
    expect(root.entries).toHaveLength(1)
    expect(root.entries[0]).toMatchObject({
      name: 'v1.0.0',
      kind: 'folder',
      size: 5,
      ref: 'rel-1',
    })

    const assets = await driver.list('/v1.0.0')
    expect(assets.entries[0]).toMatchObject({
      name: 'file.zip',
      kind: 'file',
      size: 5,
      ref: 'asset-1',
    })
  })

  it('maps an expired token to auth and marks the storage for re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ message: 'token expired' }, 401))
    const driver = createCnbReleasesDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps rate limiting to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    const driver = createCnbReleasesDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing repository to not_found', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'repo not found' }, 404))
    const driver = createCnbReleasesDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the upstream message on an unexpected status', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'cnb exploded' }, 400))
    const driver = createCnbReleasesDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('cnb exploded'),
    })
  })

  it('forwards Range to the real asset download URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://api.cnb.cool/org/repo/-/releases') return json([RELEASE])
      if (url === 'https://cnb.cool/org/repo/-/releases/download/file.zip') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=1-4')
        return new Response('abcd', {
          status: 206,
          headers: { 'content-range': 'bytes 1-4/5', 'content-length': '4' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createCnbReleasesDriver(context())
    const response = await driver.read('/v1.0.0/file.zip', 'bytes=1-4')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcd')
  })

  it('rejects a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createCnbReleasesDriver(context())
    await expect(driver.list('/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a release at the root and renames it through the API', async () => {
    const calls: Array<{ method: string; url: string; body: unknown; contentType: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === 'https://api.cnb.cool/org/repo/-/releases' && method === 'GET') return json([RELEASE])
      if (url === 'https://api.cnb.cool/org/repo/-/releases' && method === 'POST') {
        calls.push({ method, url, body: init?.body, contentType: new Headers(init?.headers).get('content-type') ?? '' })
        return new Response('', { status: 201 })
      }
      if (url === 'https://api.cnb.cool/org/repo/-/releases/rel-1' && method === 'PATCH') {
        calls.push({ method, url, body: init?.body, contentType: new Headers(init?.headers).get('content-type') ?? '' })
        return new Response('', { status: 200 })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })

    const driver = createCnbReleasesDriver(context())
    await driver.mkdir('/v2.0.0')
    await driver.rename('/v1.0.0', 'v1.1.0')

    const created = JSON.parse(String(calls[0]!.body)) as Record<string, string>
    expect(created).toEqual({ name: 'v2.0.0', tag_name: 'v2.0.0', target_commitish: 'main' })
    expect(calls[1]!.contentType).toContain('application/x-www-form-urlencoded')
    expect(String(calls[1]!.body)).toBe('name=v1.1.0')
  })

  it('declares only the operations it implements', async () => {
    const driver = createCnbReleasesDriver(context())
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeUndefined()
    await expect(driver.move('/v1.0.0', '/v2.0.0')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/v1.0.0/file.zip', new Uint8Array(), { size: 0 })).rejects.toMatchObject({
      kind: 'unsupported',
    })
  })
})
