// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAlistV3Driver } from '../src/worker/clouddrive/drivers/alist_v3'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

function stubFetch(handler: FetchHandler) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const options = init ?? {}
    calls.push({ url, init: options })
    return await handler(url, options)
  })
  return calls
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    token: 'valid-token',
    password: 'secret',
    ...(overrides.credentials ?? {}),
  }
  const config: Record<string, unknown> = {
    url: 'https://alist.example',
    username: 'owner',
    metaPassword: 'meta',
    rootPath: '/drive',
    ...(overrides.config ?? {}),
  }
  return {
    userId: overrides.userId ?? USER,
    storageId: overrides.storageId ?? STORAGE,
    type: overrides.type ?? 'alist_v3',
    config,
    credentials,
    saveCredentials: overrides.saveCredentials ?? vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

const FILE_A = { name: 'a.txt', size: 10, is_dir: false, modified: '2026-01-01T00:00:00Z', sign: 's1' }
const FILE_B = { name: 'b.pdf', size: 20, is_dir: false, modified: '2026-01-02T00:00:00Z', sign: 's2' }
const FOLDER = { name: 'docs', size: 0, is_dir: true, modified: '2026-01-03T00:00:00Z', sign: 's3' }

function me(): Response {
  return json({ code: 200, data: { username: 'owner' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AList V3 driver', () => {
  it('returns the requested page with a real next-page cursor and prefixes the mount root', async () => {
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) {
        const body = JSON.parse(String(init.body)) as { path: string; page: number; per_page: number }
        expect(body.path).toBe('/drive')
        expect(body.page).toBeGreaterThanOrEqual(1)
        return body.page === 1
          ? json({ code: 200, data: { content: [FILE_A, FOLDER], total: 3 } })
          : json({ code: 200, data: { content: [FILE_B], total: 3 } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createAlistV3Driver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.pdf'])
    expect(second.cursor).toBeNull()
    expect(calls.filter((call) => call.url.endsWith('/api/fs/list'))).toHaveLength(2)
  })

  it('marks the storage for re-authorization when the token cannot be refreshed', async () => {
    const mark = vi.fn(async () => undefined)
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) return json({ code: 401, message: 'token expired' })
      if (url.endsWith('/api/auth/login')) return json({ code: 401, message: 'bad credentials' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAlistV3Driver(context({
      credentials: { token: 'expired', password: 'wrong' },
      markNeedsReauth: mark,
    }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to a rate-limit driver error', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) return json({ code: 429, message: 'slow down' }, 429)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAlistV3Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/get')) return json({ message: 'missing' }, 404)
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAlistV3Driver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the upstream failure message', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/list')) return json({ code: 500, message: 'disk broken' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAlistV3Driver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('disk broken'),
    })
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createAlistV3Driver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes Range to the raw_url and returns the upstream 206 answer', async () => {
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/get')) {
        const body = JSON.parse(String(init.body)) as { path: string }
        if (body.path === '/drive/folder') {
          return json({ code: 200, data: { name: 'folder', size: 0, is_dir: true } })
        }
        return json({
          code: 200,
          data: { name: 'a.txt', size: 10, is_dir: false, modified: '2026-01-01T00:00:00Z', raw_url: 'https://cdn.example/a.txt' },
        })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createAlistV3Driver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
    expect(await driver.directLink!('/a.txt')).toBe('https://cdn.example/a.txt')
    expect(await driver.directLink!('/folder')).toBeNull()
    expect(calls.some((call) => call.url === 'https://cdn.example/a.txt')).toBe(true)
  })

  it('uploads through PUT /api/fs/put with the encoded File-Path header and reports progress', async () => {
    const progress: Array<[number, number]> = []
    const body = new Uint8Array([1, 2, 3, 4])
    let put: RequestInit | null = null
    stubFetch((url, init) => {
      if (url.endsWith('/api/me')) return me()
      if (url.endsWith('/api/fs/put')) {
        put = init
        return json({ code: 200, data: {} })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createAlistV3Driver(context())
    await driver.upload('/new.bin', body, {
      size: body.byteLength,
      contentType: 'application/octet-stream',
      onProgress: (uploaded, total) => progress.push([uploaded, total]),
    })
    expect(put).not.toBeNull()
    expect(put!.method).toBe('PUT')
    const headers = new Headers(put!.headers)
    expect(headers.get('File-Path')).toBe(encodeURIComponent('/drive/new.bin'))
    expect(headers.get('Authorization')).toBe('valid-token')
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(progress.at(-1)).toEqual([4, 4])
  })

  it('routes mutations to the documented /api/fs endpoints', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    stubFetch((url, init) => {
      if (url.endsWith('/api/me')) return me()
      requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return json({ code: 200, data: {} })
    })
    const driver = createAlistV3Driver(context())
    await driver.mkdir('/docs')
    await driver.rename('/docs', 'notes')
    await driver.remove('/docs/a.txt')
    await driver.move('/docs/a.txt', '/archive/a.txt')
    await driver.copy!('/docs/a.txt', '/archive/b.txt')

    expect(requests.map((request) => request.url.split('/api')[1])).toEqual([
      '/fs/mkdir',
      '/fs/rename',
      '/fs/remove',
      '/fs/move',
      '/fs/copy',
      '/fs/rename',
    ])
    expect(requests[0]!.body).toEqual({ path: '/drive/docs' })
    expect(requests[1]!.body).toEqual({ path: '/drive/docs', name: 'notes' })
    expect(requests[2]!.body).toEqual({ dir: '/drive/docs', names: ['a.txt'] })
    expect(requests[3]!.body).toEqual({ src_dir: '/drive/docs', dst_dir: '/drive/archive', names: ['a.txt'] })
    expect(requests[4]!.body).toEqual({ src_dir: '/drive/docs', dst_dir: '/drive/archive', names: ['a.txt'] })
    expect(requests[5]!.body).toEqual({ path: '/drive/archive/a.txt', name: 'b.txt' })
  })
})
