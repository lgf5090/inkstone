// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSeafileDriver } from '../src/worker/clouddrive/drivers/seafile'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    token: 'seafile-token',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'seafile',
    config: { address: 'https://seafile.example.com', repoId: 'repo-1', rootPath: '/team', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const DIR_ITEMS = [
  { id: 'd1', type: 'dir', name: 'photos', size: 0, mtime: 1767600000 },
  { id: 'f1', type: 'file', name: 'a.txt', size: 9, mtime: 1767600001 },
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Seafile driver', () => {
  it('lists a library directory under the configured root path', async () => {
    let seenUrl = ''
    let authorization = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return json(DIR_ITEMS)
    })

    const driver = createSeafileDriver(context())
    const result = await driver.list('/docs')

    const url = new URL(seenUrl)
    expect(url.pathname).toBe('/api2/repos/repo-1/dir/')
    expect(url.searchParams.get('p')).toBe('/team/docs')
    expect(authorization).toBe('Token seafile-token')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.entries).toEqual([
      { name: 'photos', kind: 'folder', size: 0, modifiedAt: 1767600000 * 1000, ref: 'd1' },
      { name: 'a.txt', kind: 'file', size: 9, modifiedAt: 1767600001 * 1000, ref: 'f1', mime: 'text/plain' },
    ])
  })

  it('lists the account libraries when no repo id is configured', async () => {
    vi.stubGlobal('fetch', async () => json([
      { id: 'lib1', type: 'repo', name: 'Docs', size: 0, mtime: 1767000000 },
    ]))
    const driver = createSeafileDriver(context({ config: { address: 'https://seafile.example.com', rootPath: '/' } }))
    const result = await driver.list('/')
    expect(result.entries).toEqual([
      { name: 'Docs', kind: 'folder', size: 0, modifiedAt: 1767000000 * 1000, ref: 'lib1' },
    ])
    expect(result.truncated).toBe(false)
  })

  it('stats an object by looking it up in its parent directory', async () => {
    vi.stubGlobal('fetch', async () => json(DIR_ITEMS))
    const driver = createSeafileDriver(context())
    const entry = await driver.stat('/docs/a.txt')
    expect(entry).toMatchObject({ name: 'a.txt', kind: 'file', size: 9, ref: 'f1' })
  })

  it('maps 401 (after one re-login), 404, 429 and upstream bodies to driver errors', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('expired', { status: 401 }))
    const driver = createSeafileDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/docs')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalledTimes(1)

    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }))
    await expect(driver.list('/docs')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429 }))
    const limited = await driver.list('/docs').catch((error: unknown) => error)
    expect(limited).toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => json({ message: 'library is locked' }, 400))
    const upstream = await driver.list('/docs').catch((error: unknown) => error)
    expect(upstream).toMatchObject({ kind: 'upstream' })
    expect((upstream as Error).message).toContain('library is locked')
  })

  it('signs in with username and password and persists the rotated token', async () => {
    const saved = vi.fn(async () => ({}))
    let loginBody = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api2/auth-token/')) {
        loginBody = String(init?.body)
        return json({ token: 'fresh-token' })
      }
      if (url.includes('/dir/')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Token fresh-token')
        return json([])
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createSeafileDriver(context({
      credentials: { username: 'u', password: 'p', token: '' },
      saveCredentials: saved,
    }))
    await driver.list('/docs')
    expect(loginBody).toContain('username=u')
    expect(saved).toHaveBeenCalledWith({ token: 'fresh-token' }, undefined)
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createSeafileDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves a temporary download link and forwards Range', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api2/repos/repo-1/file/')) return json('"https://cdn.example/a.txt"')
      if (url === 'https://cdn.example/a.txt') {
        expect(init?.method).toBe('GET')
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=1-3')
        return new Response('bcd', { status: 206, headers: { 'content-range': 'bytes 1-3/9' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createSeafileDriver(context())
    const response = await driver.read('/a.txt', 'bytes=1-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bcd')
  })

  it('requests an upload link and posts the real bytes before reporting progress', async () => {
    const progress = vi.fn()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/upload-link/')) return json('"https://upload.example/abc"')
      if (url === 'https://upload.example/abc') {
        const form = init?.body as FormData
        expect(form.get('parent_dir')).toBe('/team')
        expect(form.get('replace')).toBe('1')
        const file = form.get('file') as File
        expect(file.name).toBe('up.bin')
        expect(await file.text()).toBe('abc')
        return json({ ok: true })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createSeafileDriver(context())
    await driver.upload('/up.bin', new Uint8Array([97, 98, 99]), { size: 3, onProgress: progress })
    expect(progress).toHaveBeenCalledWith(3, 3)
  })

  it('issues mkdir, rename, move, copy and delete against the file endpoints', async () => {
    const calls: Array<{ method: string; url: string; body: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: String(init?.body ?? '') })
      return json({ ok: true })
    })
    const driver = createSeafileDriver(context())

    await driver.mkdir('/new')
    await driver.rename('/a.txt', 'b.txt')
    await driver.move('/a.txt', '/sub/b.txt')
    await driver.copy!('/a.txt', '/sub/c.txt')
    await driver.remove('/a.txt')

    const forms = calls.map((call) => new URLSearchParams(call.body))
    const params = calls.map((call) => new URL(call.url).searchParams)
    expect(calls[0]!.url).toContain('/api2/repos/repo-1/dir/')
    expect(params[0]!.get('p')).toBe('/team/new')
    expect(forms[0]!.get('operation')).toBe('mkdir')

    expect(params[1]!.get('p')).toBe('/team/a.txt')
    expect(forms[1]!.get('operation')).toBe('rename')
    expect(forms[1]!.get('newname')).toBe('b.txt')

    expect(params[2]!.get('p')).toBe('/team/a.txt')
    expect(forms[2]!.get('operation')).toBe('move')
    expect(forms[2]!.get('dst_dir')).toBe('/team/sub')
    expect(params[3]!.get('p')).toBe('/team/sub/a.txt')
    expect(forms[3]!.get('newname')).toBe('b.txt')

    expect(forms[4]!.get('operation')).toBe('copy')
    expect(params[5]!.get('p')).toBe('/team/sub/a.txt')
    expect(forms[5]!.get('newname')).toBe('c.txt')

    expect(calls[6]!.method).toBe('DELETE')
    expect(params[6]!.get('p')).toBe('/team/a.txt')
  })

  it('exposes no direct link or copy capability beyond what the registry declares', async () => {
    const driver = createSeafileDriver(context())
    expect(driver.directLink).toBeUndefined()
    expect(driver.capabilities.directLink).toBe(false)
  })
})
