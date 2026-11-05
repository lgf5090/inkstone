// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBaiduNetdiskDriver } from '../src/worker/clouddrive/drivers/baidu-netdisk'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'
const LIST_URL = 'https://pan.baidu.com/api/list'
const FILE_METAS_URL = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'
const XPAN_FILE_URL = 'https://pan.baidu.com/rest/2.0/xpan/file'
const SUPERFILE_URL = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2'
const SLICE_SIZE = 4 * 1024 * 1024

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function formOf(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function tokenResponse(): Response {
  return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
}

function context(credentials: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const stored: Record<string, string> = {
    clientId: 'client-1',
    clientSecret: 'secret',
    refreshToken: 'r1',
    accessToken: 'a0',
    expiresAt: '0',
    ...credentials,
  }
  const saveCredentials = vi.fn(async (patch: Record<string, string>) => {
    Object.assign(stored, patch)
    return { ...stored }
  })
  const markNeedsReauth = vi.fn(async (_message: string) => undefined)
  const ctx: DriverContext = {
    userId: 'user-a',
    storageId: 'storage-bd',
    type: 'baidu_netdisk',
    config: { downloadApi: 'official', ...config },
    credentials: stored,
    saveCredentials,
    markNeedsReauth,
  }
  return { ctx, saveCredentials, markNeedsReauth, stored }
}

const FILE = {
  fs_id: 1,
  path: '/a.txt',
  server_filename: 'a.txt',
  size: 10,
  isdir: 0,
  server_mtime: 1767225600,
}
const FOLDER = {
  fs_id: 2,
  path: '/docs',
  server_filename: 'docs',
  size: 0,
  isdir: 1,
  server_mtime: 1767312000,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Baidu Netdisk driver', () => {
  it('walks list pages and returns the requested page plus its cursor', async () => {
    const listCalls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.origin + url.pathname === LIST_URL) {
        const params = Object.fromEntries(url.searchParams.entries())
        listCalls.push(params)
        const start = Number(params.start)
        if (start === 0) return json({ errno: 0, list: [FILE, FOLDER] })
        if (start === 2) return json({ errno: 0, list: [FILE] })
        return json({ errno: 0, list: [] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const { ctx } = context()
    const driver = createBaiduNetdiskDriver(ctx)
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(first.entries[1]!.kind).toBe('folder')
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(second.cursor).toBeNull()
    expect(second.truncated).toBe(false)

    listCalls.length = 0
    const all = await driver.list('/', { pageSize: 2 })
    expect(all.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs', 'a.txt'])
    expect(all.cursor).toBeNull()
    expect(all.truncated).toBe(false)
    expect(listCalls.map((params) => params.start)).toEqual(['0', '2'])
    expect(listCalls[0]!.root).toBe('1')
  })

  it('refreshes a rejected access token once', async () => {
    let listCalls = 0
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) {
        listCalls++
        if (listCalls === 1) return json({ errno: -6 })
        return json({ errno: 0, list: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, markNeedsReauth } = context({
      accessToken: 'expired',
      expiresAt: String(Date.now() + 3_600_000),
    })
    const result = await createBaiduNetdiskDriver(ctx).list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(listCalls).toBe(2)
    expect(markNeedsReauth).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when the refresh fails', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return json({ error: 'invalid_grant' }, 400)
      if (url.startsWith(LIST_URL)) {
        listCalls++
        return json({ errno: 0, list: [] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, markNeedsReauth } = context({ accessToken: '' })
    await expect(createBaiduNetdiskDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(markNeedsReauth).toHaveBeenCalled()
    expect(listCalls).toBe(0)
  })

  it('maps a throttled listing to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST_URL)) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(createBaiduNetdiskDriver(context().ctx).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing folder to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LIST_URL)) return json({ message: 'not found' }, 404)
      throw new Error(`unexpected ${url}`)
    })
    await expect(createBaiduNetdiskDriver(context().ctx).list('/docs')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createBaiduNetdiskDriver(context().ctx).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range to the official dlink', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) return json({ errno: 0, list: [FILE] })
      if (parsed.origin + parsed.pathname === FILE_METAS_URL) {
        return json({ errno: 0, list: [{ dlink: 'https://dlink.example/f1?fid=1' }] })
      }
      if (url.startsWith('https://dlink.example/f1')) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createBaiduNetdiskDriver(context().ctx)
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('turns a refused dlink into auth and marks the storage', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) return json({ errno: 0, list: [FILE] })
      if (parsed.origin + parsed.pathname === FILE_METAS_URL) {
        return json({ errno: 0, list: [{ dlink: 'https://dlink.example/f1?fid=1' }] })
      }
      if (url.startsWith('https://dlink.example/f1')) return new Response('', { status: 403 })
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, markNeedsReauth } = context()
    await expect(createBaiduNetdiskDriver(ctx).read('/a.txt')).rejects.toMatchObject({ kind: 'auth' })
    expect(markNeedsReauth).toHaveBeenCalled()
  })

  it('returns the resolved temporary address from directLink', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.origin + parsed.pathname === LIST_URL) return json({ errno: 0, list: [FILE] })
      if (parsed.origin + parsed.pathname === FILE_METAS_URL) {
        return json({ errno: 0, list: [{ dlink: 'https://dlink.example/f1?fid=1' }] })
      }
      if (url.startsWith('https://dlink.example/f1')) {
        expect(init?.method).toBe('HEAD')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://dl.example/signed?sign=abc&access_token=secret' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    const address = await createBaiduNetdiskDriver(context().ctx).directLink!('/a.txt')
    expect(address).toBe('https://dl.example/signed?sign=abc')
  })

  it('refreshes concurrently through one token request', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      if (url.startsWith(LIST_URL)) return json({ errno: 0, list: [FILE] })
      throw new Error(`unexpected ${url}`)
    })

    const { ctx, saveCredentials } = context({
      accessToken: 'stale',
      expiresAt: String(Date.now()),
    })
    const driver = createBaiduNetdiskDriver(ctx)
    await Promise.all([driver.list('/'), driver.list('/')])
    expect(tokenCalls).toBe(1)
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'a1' }),
      { expect: { accessToken: 'stale', refreshToken: 'r1' } },
    )
  })

  it('declares the write capabilities', () => {
    const driver = createBaiduNetdiskDriver(context().ctx)
    expect(driver.capabilities.write).toBe(true)
    expect(driver.capabilities.mkdir).toBe(true)
    expect(driver.capabilities.rename).toBe(true)
    expect(driver.capabilities.move).toBe(true)
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.capabilities.delete).toBe(true)
  })

  it('creates a folder through the xpan create method', async () => {
    const requests: Array<{ params: URLSearchParams; form: URLSearchParams }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      requests.push({ params: url.searchParams, form: formOf(init) })
      return json({ errno: 0 })
    })

    await createBaiduNetdiskDriver(context().ctx).mkdir('/docs')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.params.get('method')).toBe('create')
    expect(requests[0]!.params.get('access_token')).toBe('a0')
    expect(requests[0]!.form.get('path')).toBe('/docs')
    expect(requests[0]!.form.get('isdir')).toBe('1')
    expect(requests[0]!.form.get('rtype')).toBe('3')
  })

  it('renames a path through filemanager', async () => {
    const requests: Array<{ params: URLSearchParams; form: URLSearchParams }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      requests.push({ params: url.searchParams, form: formOf(init) })
      return json({ errno: 0 })
    })

    await createBaiduNetdiskDriver(context().ctx).rename('/docs/a.txt', 'b.txt')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.params.get('method')).toBe('filemanager')
    expect(requests[0]!.params.get('opera')).toBe('rename')
    expect(requests[0]!.form.get('async')).toBe('0')
    expect(requests[0]!.form.get('ondup')).toBe('fail')
    expect(JSON.parse(requests[0]!.form.get('filelist')!)).toEqual([
      { path: '/docs/a.txt', newname: 'b.txt' },
    ])
  })

  it('moves a path into its destination folder', async () => {
    const requests: URLSearchParams[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      expect(url.searchParams.get('opera')).toBe('move')
      requests.push(formOf(init))
      return json({ errno: 0 })
    })

    await createBaiduNetdiskDriver(context().ctx).move('/docs/a.txt', '/target/a.txt')
    expect(JSON.parse(requests[0]!.get('filelist')!)).toEqual([
      { path: '/docs/a.txt', dest: '/target', newname: 'a.txt' },
    ])
  })

  it('copies a path into its destination folder', async () => {
    const requests: URLSearchParams[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      expect(url.searchParams.get('opera')).toBe('copy')
      requests.push(formOf(init))
      return json({ errno: 0 })
    })

    await createBaiduNetdiskDriver(context().ctx).copy!('/docs/a.txt', '/target/a.txt')
    expect(JSON.parse(requests[0]!.get('filelist')!)).toEqual([
      { path: '/docs/a.txt', dest: '/target', newname: 'a.txt' },
    ])
  })

  it('removes a path and accepts an asynchronous task id', async () => {
    let filelist: unknown
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      expect(url.searchParams.get('opera')).toBe('delete')
      filelist = JSON.parse(formOf(init).get('filelist')!)
      return json({ errno: 0, taskid: 17 })
    })

    await createBaiduNetdiskDriver(context().ctx).remove('/docs/a.txt')
    expect(filelist).toEqual(['/docs/a.txt'])
  })

  it('completes an upload when the rapid md5 probe hits', async () => {
    const bytes = new Uint8Array(16).fill(7)
    const creates: URLSearchParams[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      expect(url.searchParams.get('method')).toBe('create')
      creates.push(formOf(init))
      return json({ errno: 0 })
    })

    await createBaiduNetdiskDriver(context().ctx).upload('/docs/hit.bin', bytes, { size: bytes.byteLength })
    expect(creates).toHaveLength(1)
    expect(creates[0]!.get('uploadid')).toBeNull()
    expect(JSON.parse(creates[0]!.get('block_list')!)).toEqual([md5(bytes)])
  })

  it('uploads every missing slice and merges them with create', async () => {
    const bytes = new Uint8Array(SLICE_SIZE + 1024).fill(3)
    const expectedSliceMd5 = md5(bytes.subarray(0, 256 * 1024))
    const sliceCalls: Array<Record<string, string>> = []
    const createForms: URLSearchParams[] = []
    let precreateCalls = 0

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (`${url.origin}${url.pathname}` === SUPERFILE_URL) {
        expect(init?.method).toBe('POST')
        expect(init?.body).toBeInstanceOf(FormData)
        sliceCalls.push(Object.fromEntries(url.searchParams.entries()))
        return json({ error_code: 0 })
      }
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      const method = url.searchParams.get('method')
      const form = formOf(init)
      if (method === 'create') {
        createForms.push(form)
        // The first create is the rapid probe; it misses and the chunked flow continues.
        return createForms.length === 1 ? json({ errno: 31390 }) : json({ errno: 0 })
      }
      if (method === 'precreate') {
        precreateCalls++
        expect(form.get('content-md5')).toBe(md5(bytes))
        expect(form.get('slice-md5')).toBe(expectedSliceMd5)
        expect(form.get('autoinit')).toBe('1')
        return json({ errno: 0, return_type: 1, uploadid: 'up-1', block_list: [0, 1] })
      }
      throw new Error(`unexpected ${url}`)
    })

    await createBaiduNetdiskDriver(context().ctx).upload('/docs/big.bin', bytes, { size: bytes.byteLength })

    expect(precreateCalls).toBe(1)
    expect(sliceCalls.map((call) => call.partseq)).toEqual(['0', '1'])
    for (const call of sliceCalls) {
      expect(call.method).toBe('upload')
      expect(call.type).toBe('tmpfile')
      expect(call.uploadid).toBe('up-1')
      expect(call.path).toBe('/docs/big.bin')
    }
    expect(createForms).toHaveLength(2)
    expect(createForms[1]!.get('uploadid')).toBe('up-1')
    expect(JSON.parse(createForms[1]!.get('block_list')!)).toEqual([
      md5(bytes.subarray(0, SLICE_SIZE)),
      md5(bytes.subarray(SLICE_SIZE)),
    ])
  })

  it('retries a failed slice once, then merges', async () => {
    const bytes = new Uint8Array(1024).fill(9)
    let sliceAttempts = 0
    let createCalls = 0

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (`${url.origin}${url.pathname}` === SUPERFILE_URL) {
        sliceAttempts++
        return sliceAttempts === 1 ? json({ error_code: 1 }) : json({ error_code: 0 })
      }
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      const method = url.searchParams.get('method')
      if (method === 'create') {
        createCalls++
        return createCalls === 1 ? json({ errno: 31390 }) : json({ errno: 0 })
      }
      if (method === 'precreate') {
        return json({ errno: 0, return_type: 1, uploadid: 'up-2', block_list: [0] })
      }
      throw new Error(`unexpected ${url}`)
    })

    await createBaiduNetdiskDriver(context().ctx).upload('/docs/retry.bin', bytes, { size: bytes.byteLength })
    expect(sliceAttempts).toBe(2)
    expect(createCalls).toBe(2)
  })

  it('maps a throttled write to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe(XPAN_FILE_URL)
      return new Response('', { status: 429, headers: { 'retry-after': '0' } })
    })

    await expect(createBaiduNetdiskDriver(context().ctx).mkdir('/docs'))
      .rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('marks the storage for re-authorization when a write is refused', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      const parsed = new URL(url)
      expect(`${parsed.origin}${parsed.pathname}`).toBe(XPAN_FILE_URL)
      return new Response('', { status: 401 })
    })

    const { ctx, markNeedsReauth } = context()
    await expect(createBaiduNetdiskDriver(ctx).mkdir('/docs'))
      .rejects.toMatchObject({ kind: 'auth' })
    expect(tokenCalls).toBe(1)
    expect(markNeedsReauth).toHaveBeenCalled()
  })

  it('rejects invalid write paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createBaiduNetdiskDriver(context().ctx)

    await expect(driver.mkdir('/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.move('/a.txt', '/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.rename('/a.txt', 'bad/name')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.upload('/../secret', new Uint8Array([1]), { size: 1 }))
      .rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
