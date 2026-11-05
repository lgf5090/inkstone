// @vitest-environment node
import { createHash, createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create115OpenDriver } from '../src/worker/clouddrive/drivers/115open'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const API = 'https://proapi.115.com'
const FILES = `${API}/open/ufile/files`
const TOKEN = 'https://passportapi.115.com/open/refreshToken'
const UPLOAD_INIT = `${API}/open/upload/init`
const UPLOAD_TOKEN = `${API}/open/upload/get_token`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function formOf(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ''))
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-115-open',
  markNeedsReauth: DriverContext['markNeedsReauth'] = vi.fn(async () => undefined),
): DriverContext {
  const stored: Record<string, string> = { accessToken: 'valid', refreshToken: 'r1', ...credentials }
  return {
    userId: 'user-a',
    storageId,
    type: '115open',
    config: { rootId: '0' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth,
  }
}

const FILE = { fid: 'f1', fc: '1', fn: 'a.txt', fs: 10, upt: 1767225600, pc: 'pc1' }
const FOLDER = { fid: 'd1', fc: '0', fn: 'docs', fs: 0, upt: 1767312000 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('115 Open driver', () => {
  it('walks offset pages and returns the requested page with its cursor', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(FILES)) {
        calls.push(url)
        const offset = new URL(url).searchParams.get('offset')
        return offset === '1'
          ? json({ state: true, code: 0, data: [FOLDER], count: 2 })
          : json({ state: true, code: 0, data: [FILE], count: 2 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = create115OpenDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('1')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.truncated).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('marks the storage for re-authorization when the refresh token is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) return json({ state: false, code: 1, message: 'bad refresh token' })
      if (url.startsWith(FILES)) return json({ state: false, code: 401, message: 'token expired' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create115OpenDriver(context({ accessToken: 'stale' }, 'storage-115-auth', mark))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps a throttled list call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(FILES)) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create115OpenDriver(context({}, 'storage-115-429')).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing object code to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(FILES)) return json({ state: false, code: 430004, message: 'not found' })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create115OpenDriver(context({}, 'storage-115-404')).stat('/missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(create115OpenDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes the token once when two requests race', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        return json({ state: true, code: 0, data: { access_token: 'a1', refresh_token: 'r2' } })
      }
      if (url.startsWith(FILES)) return json({ state: true, code: 0, data: [], count: 0 })
      throw new Error(`unexpected ${url}`)
    })
    const first = create115OpenDriver(context({ accessToken: '' }, 'storage-115-race'))
    const second = create115OpenDriver(context({ accessToken: '' }, 'storage-115-race'))
    await Promise.all([first.list('/'), second.list('/')])
    expect(tokenCalls).toBe(1)
  })

  it('advertises the write capabilities from the shared registry', () => {
    const driver = create115OpenDriver(context())
    expect(driver.capabilities.write).toBe(true)
    expect(driver.capabilities.mkdir).toBe(true)
    expect(driver.capabilities.rename).toBe(true)
    expect(driver.capabilities.move).toBe(true)
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.capabilities.delete).toBe(true)
  })

  it('escapes every write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create115OpenDriver(context())
    await expect(driver.mkdir('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.upload('/docs/../secret', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a folder with the documented pid/file_name form', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return json({ state: true, code: 0, data: { file_id: 'd2', file_name: 'new' } })
    })
    await create115OpenDriver(context()).mkdir('/new')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${API}/open/folder/add`)
    expect(calls[0]!.init.method).toBe('POST')
    const form = formOf(calls[0]!.init)
    expect(form.get('pid')).toBe('0')
    expect(form.get('file_name')).toBe('new')
  })

  it('renames a file by its resolved id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.startsWith(FILES)) return json({ state: true, code: 0, data: [FILE], count: 1 })
      if (url === `${API}/open/ufile/update`) return json({ state: true, code: 0, data: {} })
      throw new Error(`unexpected ${url}`)
    })
    await create115OpenDriver(context()).rename('/a.txt', 'b.txt')
    expect(calls).toHaveLength(2)
    const form = formOf(calls[1]!.init)
    expect(form.get('file_id')).toBe('f1')
    expect(form.get('file_name')).toBe('b.txt')
  })

  it('moves a file into the destination folder', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.startsWith(FILES)) return json({ state: true, code: 0, data: [FILE, FOLDER], count: 2 })
      if (url === `${API}/open/ufile/move`) return json({ state: true, code: 0, data: {} })
      throw new Error(`unexpected ${url}`)
    })
    await create115OpenDriver(context()).move('/a.txt', '/docs/a.txt')
    expect(calls.at(-1)!.url).toBe(`${API}/open/ufile/move`)
    const form = formOf(calls.at(-1)!.init)
    expect(form.get('file_ids')).toBe('f1')
    expect(form.get('to_cid')).toBe('d1')
  })

  it('copies a file with no_dupli', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.startsWith(FILES)) return json({ state: true, code: 0, data: [FILE, FOLDER], count: 2 })
      if (url === `${API}/open/ufile/copy`) return json({ state: true, code: 0, data: {} })
      throw new Error(`unexpected ${url}`)
    })
    await create115OpenDriver(context()).copy!('/a.txt', '/docs/a.txt')
    expect(calls.at(-1)!.url).toBe(`${API}/open/ufile/copy`)
    const form = formOf(calls.at(-1)!.init)
    expect(form.get('pid')).toBe('d1')
    expect(form.get('file_id')).toBe('f1')
    expect(form.get('no_dupli')).toBe('1')
  })

  it('deletes a file through ufile/delete', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.startsWith(FILES)) return json({ state: true, code: 0, data: [FILE], count: 1 })
      if (url === `${API}/open/ufile/delete`) return json({ state: true, code: 0, data: {} })
      throw new Error(`unexpected ${url}`)
    })
    await create115OpenDriver(context()).remove('/a.txt')
    expect(calls.at(-1)!.url).toBe(`${API}/open/ufile/delete`)
    const form = formOf(calls.at(-1)!.init)
    expect(form.get('file_ids')).toBe('f1')
    expect(form.get('parent_id')).toBe('0')
  })

  it('returns after an instant-upload hit without fetching a token or PUT', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const expectedSha1 = createHash('sha1').update(bytes).digest('hex').toUpperCase()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === UPLOAD_INIT) {
        const form = formOf(init)
        expect(form.get('file_name')).toBe('a.txt')
        expect(form.get('file_size')).toBe('3')
        expect(form.get('target')).toBe('U_1_0')
        expect(form.get('fileid')).toBe(expectedSha1)
        expect(form.get('preid')).toBe(expectedSha1)
        expect(form.get('sign_key')).toBeNull()
        expect(form.get('sign_val')).toBeNull()
        return json({ state: true, code: 0, data: { status: 2 } })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const progress = vi.fn()
    await create115OpenDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength, onProgress: progress })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(3, 3)
  })

  it('performs a signed OSS PUT when the instant upload misses', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const callback = '{"callbackBody":"fid=${x:fid}"}'
    const callbackVar = '{"x":"y"}'
    let putCall: { url: string; init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === UPLOAD_INIT) {
        return json({
          state: true,
          code: 0,
          data: {
            status: 0,
            bucket: 'bucket-a',
            object: 'obj/a.txt',
            callback: { callback, callback_var: callbackVar },
          },
        })
      }
      if (url === UPLOAD_TOKEN) {
        return json({
          state: true,
          code: 0,
          data: { endpoint: 'oss.example.com', AccessKeyId: 'AK', AccessKeySecret: 'SK', SecurityToken: 'STS' },
        })
      }
      if (url === 'https://oss.example.com/obj/a.txt') {
        putCall = { url, init: init ?? {} }
        return new Response('', { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    })
    await create115OpenDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength })
    expect(putCall).not.toBeNull()
    expect(putCall!.init.method).toBe('PUT')
    const headers = putCall!.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/octet-stream')
    expect(headers['x-oss-security-token']).toBe('STS')
    expect(headers['x-oss-callback']).toBe(Buffer.from(callback, 'utf8').toString('base64'))
    expect(headers['x-oss-callback-var']).toBe(Buffer.from(callbackVar, 'utf8').toString('base64'))
    expect(headers['Content-Length']).toBe('3')
    expect(headers['Date']).toBeTruthy()

    const ossHeaders = `x-oss-callback:${headers['x-oss-callback']}\nx-oss-callback-var:${headers['x-oss-callback-var']}\nx-oss-security-token:STS\n`
    const stringToSign = `PUT\n\napplication/octet-stream\n${headers['Date']}\n${ossHeaders}/bucket-a/obj/a.txt`
    const signature = createHmac('sha1', 'SK').update(stringToSign).digest('base64')
    expect(headers.Authorization).toBe(`OSS AK:${signature}`)
    expect(putCall!.init.body).toBe(bytes)
  })

  it('maps a throttled write to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${API}/open/folder/add`) return json({ state: false, code: 429, message: 'slow down' })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create115OpenDriver(context({}, 'storage-115-write-429')).mkdir('/new')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('marks the storage for re-authorization when a write keeps failing auth', async () => {
    const mark = vi.fn(async () => undefined)
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        return json({ state: true, code: 0, data: { access_token: 'a1', refresh_token: 'r2' } })
      }
      if (url === `${API}/open/folder/add`) return json({ state: false, code: 401, message: 'token expired' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create115OpenDriver(context({ accessToken: 'stale' }, 'storage-115-write-auth', mark))
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'auth' })
    expect(tokenCalls).toBe(1)
    expect(mark).toHaveBeenCalled()
  })
})
