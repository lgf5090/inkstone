// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLenovoNasShareDriver } from '../src/worker/clouddrive/drivers/lenovonas_share'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const HOST = 'https://siot-share.lenovo.com.cn'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    sharePwd: 'share-password',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'lenovonas_share',
    config: { shareId: 'abc123', host: HOST, rootPath: '/', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = { name: 'a.txt', size: 10, path: '/a.txt', type: 'file', time: 1, chtime: 1_700_000_000 }
const FILE_B = { name: 'b.pdf', size: 20, path: '/b.pdf', type: 'file', time: 2, chtime: 1_700_000_100 }
const FOLDER = { name: 'docs', size: 0, path: '/docs', type: 'dir', time: 3, chtime: 1_700_000_200 }

function accessBody(): Response {
  return json({ result: true, data: { stoken: 'session-token', expires_in: 3600 } })
}

function listBody(files: Array<Record<string, unknown>>): Response {
  return json({ result: true, data: { list: files } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Lenovo NAS Share driver', () => {
  it('exchanges the share password for a token and lists entries', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/oneproxy/api/share/v1/access')) {
        expect(new URL(url).searchParams.get('code')).toBe('abc123')
        expect(new URL(url).searchParams.get('password')).toBe('share-password')
        return accessBody()
      }
      if (url.includes('/oneproxy/api/share/v1/files')) {
        expect(new URL(url).searchParams.get('stoken')).toBe('session-token')
        return listBody([FILE_A, FILE_B, FOLDER])
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createLenovoNasShareDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf', 'docs'])
    expect(result.entries[2]!.kind).toBe('folder')
    expect(result.entries[0]!.size).toBe(10)
    expect(calls).toHaveLength(2)
  })

  it('applies rootPath as an upstream prefix', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access')) return accessBody()
      if (url.includes('/files')) {
        expect(new URL(url).searchParams.get('path')).toBe('/share/docs')
        return listBody([])
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLenovoNasShareDriver(context({ config: { shareId: 'abc123', host: HOST, rootPath: '/share' } }))
    await driver.list('/docs')
  })

  it('maps a rejected share password to an auth error', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access')) return json({ result: false, error: { msg: 'password is incorrect' } })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLenovoNasShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('password is incorrect') })
  })

  it('maps a 404 listing to not_found and a 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access')) return accessBody()
      if (url.includes('/files')) return new Response('', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLenovoNasShareDriver(context())
    await expect(driver.list('/missing')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access')) return accessBody()
      if (url.includes('/files')) {
        return new Response('', { status: 429, headers: { 'retry-after': '2' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const second = createLenovoNasShareDriver(context())
    await expect(second.list('/')).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 2000 })
  })

  it('keeps the upstream message of an unexpected failure', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access')) return accessBody()
      if (url.includes('/files')) return json({ message: 'upstream exploded' }, 500)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLenovoNasShareDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('upstream exploded'),
    })
  })

  it('reports a missing entry as not_found after listing its parent', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access')) return accessBody()
      if (url.includes('/files')) {
        expect(new URL(url).searchParams.get('path')).toBe('/docs')
        return listBody([])
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLenovoNasShareDriver(context())
    await expect(driver.stat('/docs/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the resolved download endpoint', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/access')) return accessBody()
      if (url.includes('/files')) {
        expect(new URL(url).searchParams.get('path')).toBe('/dir')
        return listBody([{ ...FILE_A, name: 'a.txt', path: '/dir/a.txt' }])
      }
      if (url.includes('/file/link')) {
        return json({ result: true, data: { param: { dtoken: 'download-token' } } })
      }
      if (url.includes('/file/download')) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', {
          status: 206,
          headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLenovoNasShareDriver(context())
    const response = await driver.read('/dir/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createLenovoNasShareDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares only the capabilities it has and refuses writes', async () => {
    const driver = createLenovoNasShareDriver(context())
    expect(driver.capabilities.write).toBe(false)
    expect(driver.capabilities.directLink).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeUndefined()
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('reports reachability through test()', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access')) return accessBody()
      if (url.includes('/files')) return listBody([FILE_A])
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLenovoNasShareDriver(context())
    await expect(driver.test()).resolves.toMatchObject({ ok: true })
  })

  it('is an instance of DriverError on auth failures', async () => {
    const driver = createLenovoNasShareDriver(context({ config: { shareId: '', rootPath: '/' } }))
    await expect(driver.list('/')).rejects.toBeInstanceOf(DriverError)
  })
})
