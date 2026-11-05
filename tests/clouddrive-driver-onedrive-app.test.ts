// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOneDriveAppDriver } from '../src/worker/clouddrive/drivers/onedrive-app'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { clientId: 'cid', clientSecret: 'secret', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-oda',
    type: 'onedrive_app',
    config: { tenantId: 'tenant-1', driveId: 'drive-1' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const TOKEN_URL = 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token'
const BASE = 'https://graph.microsoft.com/v1.0/drives/drive-1'
const ROOT = `${BASE}/root`
const FILE = { id: 'f1', name: 'a.txt', size: 10, lastModifiedDateTime: '2026-01-01T00:00:00Z' }
const FOLDER = { id: 'd1', name: 'docs', folder: {}, lastModifiedDateTime: '2026-01-02T00:00:00Z' }

function token(): Response {
  return json({ access_token: 'app-token', expires_in: 3600 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OneDrive application driver', () => {
  it('walks nextLink pages and returns the requested page with its cursor', async () => {
    const childCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url.startsWith(`${ROOT}/children`)) {
        childCalls.push(url)
        if (url.includes('$skiptoken=page2')) return json({ value: [FOLDER] })
        return json({ value: [FILE], '@odata.nextLink': `${ROOT}/children?$skiptoken=page2` })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOneDriveAppDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toContain('$skiptoken=page2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(childCalls).toHaveLength(3)
    expect(driver.definition.id).toBe('onedrive_app')
    expect(driver.capabilities.write).toBe(true)
    expect(typeof driver.upload).toBe('function')
  })

  it('maps a refused application credential to auth and marks the storage', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createOneDriveAppDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markNeedsReauth).toHaveBeenCalled()
  })

  it('maps 429 to rate_limit and 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return new Response('', { status: 429 })
    })
    await expect(createOneDriveAppDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return json({ error: { message: 'not found' } }, 404)
    })
    await expect(createOneDriveAppDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createOneDriveAppDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
