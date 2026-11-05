// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKodboxDriver } from '../src/worker/clouddrive/drivers/kodbox'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    username: 'u',
    password: 'p',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'kodbox',
    config: { address: 'https://kod.example.com', rootPath: '/root', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async () => ({})),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const LISTING = {
  folderList: [{ path: 'docs', name: 'docs', type: 'folder', size: 0, modifyTime: 1767600000 }],
  fileList: [{ path: 'a.txt', name: 'a.txt', type: 'file', size: 5, modifyTime: 1767600001 }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('KodBox driver', () => {
  it('signs in and lists the configured root path with both folders and files', async () => {
    const urls: string[] = []
    let listForm = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('loginSubmit')) return json({ code: true, info: 'token-1' })
      if (url.includes('explorer/list/path')) {
        listForm = String(init?.body)
        return json({ code: true, data: LISTING })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createKodboxDriver(context())
    const result = await driver.list('/docs')

    expect(urls[0]).toContain('user/index/loginSubmit')
    expect(new URLSearchParams(listForm).get('path')).toBe('/root/docs')
    expect(new URLSearchParams(listForm).get('accessToken')).toBe('token-1')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.entries).toEqual([
      { name: 'docs', kind: 'folder', size: 0, modifiedAt: 1767600000 * 1000, ref: 'docs' },
      { name: 'a.txt', kind: 'file', size: 5, modifiedAt: 1767600001 * 1000, ref: 'a.txt', mime: 'text/plain' },
    ])
  })

  it('reports a rejected login as an auth error', async () => {
    vi.stubGlobal('fetch', async () => json({ code: false, data: 'bad password' }))
    const driver = createKodboxDriver(context())
    const error = await driver.list('/').catch((failure: unknown) => failure)
    expect(error).toMatchObject({ kind: 'auth' })
    expect((error as Error).message).toContain('bad password')
  })

  it('maps an unrecoverable 401 to auth after re-login and marks re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('loginSubmit')) return json({ code: true, info: 'token-1' })
      return new Response('expired', { status: 401 })
    })
    const driver = createKodboxDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps 404, 429 and API-level failures to driver errors', async () => {
    const driver = createKodboxDriver(context())
    const login = async (input: RequestInfo | URL) => String(input).includes('loginSubmit')

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (await login(input)) return json({ code: true, info: 'token-1' })
      return new Response('gone', { status: 404 })
    })
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (await login(input)) return json({ code: true, info: 'token-1' })
      return new Response('slow down', { status: 429 })
    })
    const limited = await driver.list('/').catch((error: unknown) => error)
    expect(limited).toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (await login(input)) return json({ code: true, info: 'token-1' })
      return json({ code: false, data: 'directory is locked' })
    })
    const upstream = await driver.list('/').catch((error: unknown) => error)
    expect(upstream).toMatchObject({ kind: 'upstream' })
    expect((upstream as Error).message).toContain('directory is locked')
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createKodboxDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('downloads through fileOut with the access token and forwards Range', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('loginSubmit')) return json({ code: true, info: 'token-1' })
      if (url.includes('explorer/index/fileOut')) {
        const parsed = new URL(url)
        expect(parsed.searchParams.get('path')).toBe('/root/a.txt')
        expect(parsed.searchParams.get('accessToken')).toBe('token-1')
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=1-2')
        return new Response('bc', { status: 206, headers: { 'content-range': 'bytes 1-2/5' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createKodboxDriver(context())
    const response = await driver.read('/a.txt', 'bytes=1-2')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bc')
  })

  it('uploads the real bytes through the multipart endpoint before reporting progress', async () => {
    const progress = vi.fn()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('loginSubmit')) return json({ code: true, info: 'token-1' })
      if (url.includes('explorer/upload/fileUpload')) {
        const form = init?.body as FormData
        expect(form.get('accessToken')).toBe('token-1')
        expect(form.get('path')).toBe('/root')
        const file = form.get('file') as File
        expect(file.name).toBe('up.bin')
        expect(await file.text()).toBe('abc')
        return json({ code: true, data: {} })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createKodboxDriver(context())
    await driver.upload('/up.bin', new Uint8Array([97, 98, 99]), { size: 3, onProgress: progress })
    expect(progress).toHaveBeenCalledWith(3, 3)
  })

  it('issues mkdir, rename, move, copy and delete with the expected forms', async () => {
    const forms: Array<{ url: string; body: URLSearchParams }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('loginSubmit')) return json({ code: true, info: 'token-1' })
      forms.push({ url, body: new URLSearchParams(String(init?.body ?? '')) })
      return json({ code: true, data: {} })
    })
    const driver = createKodboxDriver(context())

    await driver.mkdir('/new')
    await driver.rename('/a.txt', 'b.txt')
    await driver.move('/a.txt', '/sub/a.txt')
    await driver.copy!('/a.txt', '/sub/a.txt')
    await driver.remove('/a.txt')

    expect(forms.map((call) => call.url.replace('https://kod.example.com/', ''))).toEqual([
      '?explorer/index/mkdir',
      '?explorer/index/pathRename',
      '?explorer/index/pathCuteTo',
      '?explorer/index/pathCopyTo',
      '?explorer/index/pathDelete',
    ])
    expect(forms[0]!.body.get('path')).toBe('/root/new')
    expect(forms[1]!.body.get('path')).toBe('/root/a.txt')
    expect(forms[1]!.body.get('newName')).toBe('b.txt')
    expect(JSON.parse(forms[2]!.body.get('dataArr')!)).toEqual([{ path: '/root/a.txt', name: 'a.txt' }])
    expect(forms[2]!.body.get('path')).toBe('/root/sub')
    expect(JSON.parse(forms[3]!.body.get('dataArr')!)).toEqual([{ path: '/root/a.txt', name: 'a.txt' }])
    expect(forms[4]!.body.get('shiftDelete')).toBe('1')
    expect(JSON.parse(forms[4]!.body.get('dataArr')!)).toEqual([{ path: '/root/a.txt', name: 'a.txt' }])
  })

  it('exposes no direct link method', async () => {
    const driver = createKodboxDriver(context())
    expect(driver.directLink).toBeUndefined()
    expect(driver.capabilities.directLink).toBe(false)
  })
})
