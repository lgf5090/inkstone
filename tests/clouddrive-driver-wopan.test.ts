// @vitest-environment node
import { createDecipheriv } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWopanDriver } from '../src/worker/clouddrive/drivers/wopan'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const AES_IV = 'wNSOYIB1k1DjY5lA'
const AES_KEY = 'abcdefghijklmnop'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function dispatch(data: unknown, code = '0000', status = '200'): Response {
  return json({ STATUS: status, RSP: { RSP_CODE: code, DATA: data } })
}

function decrypt(value: string, key = AES_KEY): string {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(AES_IV, 'utf8'))
  return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8')
}

function bodyParam(init: RequestInit | undefined, key = AES_KEY): Record<string, unknown> | null {
  const body = JSON.parse(String(init?.body ?? '{}')) as { body?: { param?: string } }
  if (!body.body?.param) return null
  return JSON.parse(decrypt(body.body.param, key)) as Record<string, unknown>
}

function formParam(form: FormData, name: string, key = AES_KEY): Record<string, unknown> {
  return JSON.parse(decrypt(String(form.get(name)), key)) as Record<string, unknown>
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-wopan',
): DriverContext & { saveMock: ReturnType<typeof vi.fn>; markMock: ReturnType<typeof vi.fn> } {
  const stored: Record<string, string> = {
    accessToken: 'abcdefghijklmnop',
    refreshToken: 'r1',
    ...credentials,
  }
  const saveMock = vi.fn(async (patch: Record<string, string>) => {
    Object.assign(stored, patch)
    return { ...stored }
  })
  const markMock = vi.fn(async () => undefined)
  return {
    userId: 'user-a',
    storageId,
    type: 'wopan',
    config: {},
    credentials: stored,
    saveCredentials: saveMock,
    markNeedsReauth: markMock,
    saveMock,
    markMock,
  }
}

function requestKey(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { header?: { key?: string } }
  return body.header?.key ?? ''
}

const FILE = { fid: 'f1', id: 'id-1', name: 'a.txt', size: 10, createTime: '20240101100000', type: 1 }
const FILE2 = { fid: 'f2', id: 'id-2', name: 'b.txt', size: 20, createTime: '20240102100000', type: 1 }
const FILE3 = { fid: 'f3', id: 'id-3', name: 'c.txt', size: 30, createTime: '20240103100000', type: 1 }
const DOC = { fid: 'dir-fid', id: 'dir-1', name: 'docs', size: 0, createTime: '20240101100000', type: 0 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WoPan driver', () => {
  it('lists one page with a cursor and a following page without one', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      if (requestKey(init) !== 'QueryAllFiles') throw new Error('unexpected method')
      listCalls++
      return dispatch({ files: listCalls === 1 ? [FILE, FILE2] : [FILE3] })
    })

    const driver = createWopanDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['c.txt'])
    expect(second.cursor).toBeNull()
  })

  it('walks every page when no page is requested', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      if (requestKey(init) !== 'QueryAllFiles') throw new Error('unexpected method')
      listCalls++
      return dispatch({ files: listCalls === 1 ? [FILE, FILE2] : [FILE3] })
    })

    const collected = await createWopanDriver(context()).list('/', { pageSize: 2 })
    expect(collected.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(collected.cursor).toBeNull()
    expect(collected.truncated).toBe(false)
    expect(listCalls).toBe(2)
  })

  it('refreshes once when the token is rejected and writes both tokens back with the observed values', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api-user/dispatcher')) {
        tokenCalls++
        return dispatch({ access_token: 'fresh-token-123', refresh_token: 'r2' })
      }
      if (url.endsWith('/wohome/dispatcher')) {
        const token = new Headers(init?.headers).get('Accesstoken')
        if (token === 'abcdefghijklmnop') return dispatch({}, '9999')
        return dispatch({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const result = await createWopanDriver(ctx).list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledWith(
      { accessToken: 'fresh-token-123', refreshToken: 'r2' },
      { expect: { accessToken: 'abcdefghijklmnop', refreshToken: 'r1' } },
    )
    expect(ctx.markMock).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when the refresh token is refused', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api-user/dispatcher')) {
        expect(requestKey(init)).toBe('AppRefreshToken')
        return new Response('', { status: 401 })
      }
      if (url.endsWith('/wohome/dispatcher')) return dispatch({}, '9999')
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createWopanDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('maps throttling and missing resources to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      return new Response('', { status: 429 })
    })
    await expect(createWopanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      return new Response('', { status: 404 })
    })
    await expect(createWopanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the resolved download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://dl.example/a') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206 })
      }
      if (!url.endsWith('/wohome/dispatcher')) throw new Error(`unexpected ${url}`)
      const key = requestKey(init)
      if (key === 'QueryAllFiles') return dispatch({ files: [FILE] })
      if (key === 'GetDownloadUrlV2') {
        return dispatch({ list: [{ fid: 'f1', downloadUrl: 'https://dl.example/a' }] })
      }
      throw new Error(`unexpected method ${key}`)
    })

    const response = await createWopanDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping, backslash and control paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createWopanDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/docs\\secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.list('/docs/\u0000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates a token only once for two concurrent requests', async () => {
    let tokenCalls = 0
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api-user/dispatcher')) {
        tokenCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return dispatch({ access_token: 'fresh-token-123', refresh_token: 'r2' })
      }
      if (url.endsWith('/wohome/dispatcher')) {
        listCalls++
        await new Promise((resolve) => setTimeout(resolve, 10))
        const token = new Headers(init?.headers).get('Accesstoken')
        if (token !== 'fresh-token-123') return dispatch({}, '9999')
        return dispatch({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const first = createWopanDriver(ctx)
    const second = createWopanDriver(ctx)
    const [a, b] = await Promise.all([first.list('/'), second.list('/')])
    expect(a.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(b.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(listCalls).toBe(4)
    expect(ctx.saveMock).toHaveBeenCalledTimes(1)
    expect(ctx.saveMock).toHaveBeenCalledWith(
      { accessToken: 'fresh-token-123', refreshToken: 'r2' },
      { expect: { accessToken: 'abcdefghijklmnop', refreshToken: 'r1' } },
    )
  })

  it('declares a writable mount', () => {
    const driver = createWopanDriver(context())
    expect(driver.capabilities.write).toBe(true)
    expect(driver.capabilities.mkdir).toBe(true)
    expect(driver.capabilities.copy).toBe(true)
  })

  it('creates a directory through CreateDirectory', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return dispatch({ id: 'new-dir' })
    })
    await createWopanDriver(context()).mkdir('/new')
    expect(calls).toHaveLength(1)
    expect(requestKey(calls[0].init)).toBe('CreateDirectory')
    expect(bodyParam(calls[0].init)).toMatchObject({
      spaceType: '0',
      familyId: '',
      parentDirectoryId: '0',
      directoryName: 'new',
      clientId: '1001000021',
    })
  })

  it('renames a file through RenameFileOrDirectory with its classified type', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      const key = requestKey(init)
      if (key === 'QueryAllFiles') return dispatch({ files: [FILE] })
      if (key === 'ClassifyRule') return dispatch({ fileTypes: { txt: { type: '1' } } })
      if (key === 'RenameFileOrDirectory') return dispatch({})
      throw new Error(`unexpected ${key}`)
    })
    await createWopanDriver(context()).rename('/a.txt', 'b.txt')
    const rename = calls.find((call) => requestKey(call.init) === 'RenameFileOrDirectory')
    expect(bodyParam(rename?.init)).toMatchObject({
      type: 1,
      fileType: '1',
      id: 'id-1',
      name: 'b.txt',
    })
  })

  it('deletes a file through DeleteFile', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      const key = requestKey(init)
      if (key === 'QueryAllFiles') return dispatch({ files: [FILE] })
      if (key === 'DeleteFile') return dispatch({})
      throw new Error(`unexpected ${key}`)
    })
    await createWopanDriver(context()).remove('/a.txt')
    const remove = calls.find((call) => requestKey(call.init) === 'DeleteFile')
    expect(bodyParam(remove?.init)).toMatchObject({
      spaceType: '0',
      vipLevel: '0',
      dirList: [],
      fileList: ['id-1'],
    })
  })

  it('moves a file through MoveFile into the target directory', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      const key = requestKey(init)
      if (key === 'QueryAllFiles') return dispatch({ files: [DOC, FILE] })
      if (key === 'MoveFile') return dispatch({})
      throw new Error(`unexpected ${key}`)
    })
    await createWopanDriver(context()).move('/a.txt', '/docs/a.txt')
    const move = calls.find((call) => requestKey(call.init) === 'MoveFile')
    expect(bodyParam(move?.init)).toMatchObject({
      targetDirId: 'dir-1',
      sourceType: '0',
      targetType: '0',
      dirList: [],
      fileList: ['id-1'],
    })
  })

  it('copies a file through CopyFile into the target directory', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      const key = requestKey(init)
      if (key === 'QueryAllFiles') return dispatch({ files: [DOC, FILE] })
      if (key === 'CopyFile') return dispatch({})
      throw new Error(`unexpected ${key}`)
    })
    await createWopanDriver(context()).copy!('/a.txt', '/docs/a.txt')
    const copy = calls.find((call) => requestKey(call.init) === 'CopyFile')
    expect(bodyParam(copy?.init)).toMatchObject({
      targetDirId: 'dir-1',
      sourceType: '0',
      targetType: '0',
      dirList: [],
      fileList: ['id-1'],
    })
  })

  it('uploads two parts and lets the final part commit the file', async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1)
    const uploads: FormData[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/wohome/dispatcher')) {
        const key = requestKey(init)
        if (key === 'GetZoneInfo') return dispatch({ url: 'https://up.example' })
        if (key === 'ClassifyRule') return dispatch({ fileTypes: { txt: { type: '1' } } })
        throw new Error(`unexpected ${key}`)
      }
      if (url === 'https://up.example/openapi/client/upload2C') {
        uploads.push(init?.body as FormData)
        return json({ code: '0000', data: { fid: 'uploaded-fid' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const progress = vi.fn()
    await createWopanDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength, onProgress: progress })
    expect(uploads).toHaveLength(2)
    expect(uploads.map((form) => form.get('partIndex'))).toEqual(['1', '2'])
    expect(uploads.map((form) => form.get('partSize'))).toEqual(['8388608', '1'])
    expect(uploads.map((form) => form.get('totalPart'))).toEqual(['2', '2'])
    expect((uploads[0].get('file') as Blob).size).toBe(8 * 1024 * 1024)
    expect((uploads[1].get('file') as Blob).size).toBe(1)
    expect(formParam(uploads[0], 'fileInfo')).toMatchObject({
      fileName: 'a.txt',
      fileSize: bytes.byteLength,
      fileType: '1',
      directoryId: '0',
      spaceType: '0',
    })
    expect(progress).toHaveBeenLastCalledWith(bytes.byteLength, bytes.byteLength)
  })

  it('retries a dropped upload part once and then succeeds', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    let attempts = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/wohome/dispatcher')) {
        const key = requestKey(init)
        if (key === 'GetZoneInfo') return dispatch({ url: 'https://up.example' })
        if (key === 'ClassifyRule') return dispatch({ fileTypes: { txt: { type: '1' } } })
        throw new Error(`unexpected ${key}`)
      }
      if (url === 'https://up.example/openapi/client/upload2C') {
        attempts++
        if (attempts === 1) throw new Error('connection reset')
        return json({ code: '0000', data: { fid: 'uploaded-fid' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const progress = vi.fn()
    await createWopanDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength, onProgress: progress })
    expect(attempts).toBe(2)
    expect(progress).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(3, 3)
  })

  it('maps a throttled write to rate_limit', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return new Response('', { status: 429 })
    })
    await expect(createWopanDriver(context()).mkdir('/throttled')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBe(3)
  })

  it('marks the storage for re-authorization when a write keeps failing auth', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api-user/dispatcher')) return new Response('', { status: 401 })
      if (url.endsWith('/wohome/dispatcher')) {
        const key = requestKey(init)
        if (key === 'QueryAllFiles') return dispatch({ files: [FILE] })
        if (key === 'DeleteFile') return dispatch({}, '9999')
        throw new Error(`unexpected ${key}`)
      }
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context({}, 'storage-wopan-write-auth')
    await expect(createWopanDriver(ctx).remove('/a.txt')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('rejects an illegal write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createWopanDriver(context())
    await expect(driver.mkdir('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.upload('/docs/../secret', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
