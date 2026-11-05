// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOneDriveDriver } from '../src/worker/clouddrive/drivers/onedrive'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = {
    refreshToken: 'r1', clientId: 'client-1', clientSecret: 'secret', ...credentials,
  }
  return {
    userId: 'user-a',
    storageId: 'storage-od',
    type: 'onedrive',
    config: {},
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const ROOT = 'https://graph.microsoft.com/v1.0/me/drive/root'
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

function tokenResponse(): Response {
  return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
}

const FILE = { id: 'f1', name: 'a.txt', size: 10, lastModifiedDateTime: '2026-01-01T00:00:00Z' }
const FOLDER = { id: 'd1', name: 'docs', folder: {}, lastModifiedDateTime: '2026-01-02T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OneDrive driver', () => {
  it('walks the skiptoken pages and returns the requested page with its cursor', async () => {
    const childCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return tokenResponse()
      if (url.startsWith(`${ROOT}/children`)) {
        childCalls.push(url)
        if (url.includes('$skiptoken=page2')) return json({ value: [FOLDER] })
        return json({ value: [FILE], '@odata.nextLink': `${ROOT}/children?$skiptoken=page2` })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOneDriveDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toContain('$skiptoken=page2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(childCalls).toHaveLength(3)
  })

  it('refreshes once and retries when Graph rejects the access token', async () => {
    let tokenCalls = 0
    let childCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url.startsWith(`${ROOT}/children`)) {
        childCalls++
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer expired') return json({ error: { code: 'InvalidAuthenticationToken' } }, 401)
        return json({ value: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOneDriveDriver(context({ accessToken: 'expired', expiresAt: String(Date.now() + 3_600_000), refreshToken: 'r1' }))
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(childCalls).toBe(2)
  })

  it('maps a missing folder to not_found and a throttled call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return tokenResponse()
      if (url.startsWith(`${ROOT}:/docs:/children`)) return json({ error: { message: 'not found' } }, 404)
      if (url.startsWith(`${ROOT}/children`)) return json({ error: { message: 'not found' } }, 404)
      throw new Error(`unexpected ${url}`)
    })
    await expect(createOneDriveDriver(context()).list('/docs')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return tokenResponse()
      return new Response('', { status: 429, headers: { 'retry-after': '1' } })
    })
    await expect(createOneDriveDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('forwards Range to the preauthorized download URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return tokenResponse()
      if (url.startsWith(`${ROOT}:/a.txt`)) {
        return json({ ...FILE, '@microsoft.graph.downloadUrl': 'https://download.example/f1' })
      }
      if (url === 'https://download.example/f1') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const response = await createOneDriveDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createOneDriveDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not expose copy when the capability is absent', () => {
    const driver = createOneDriveDriver(context())
    expect(driver.capabilities.copy).toBe(true)
    expect(typeof driver.copy).toBe('function')
    expect(driver.capabilities.share).toBe(false)
  })

  it('maps an unexpected upstream status through DriverError', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }))
    await expect(createOneDriveDriver(context()).list('/')).rejects.toBeInstanceOf(DriverError)
  })
})
