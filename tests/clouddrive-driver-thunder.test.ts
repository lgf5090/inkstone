// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThunderDriver } from '../src/worker/clouddrive/drivers/thunder'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-thunder',
): DriverContext & { saveMock: ReturnType<typeof vi.fn>; markMock: ReturnType<typeof vi.fn> } {
  const stored: Record<string, string> = {
    accessToken: 'expired',
    refreshToken: 'r1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
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
    type: 'thunder',
    config: {},
    credentials: stored,
    saveCredentials: saveMock,
    markNeedsReauth: markMock,
    saveMock,
    markMock,
  }
}

const TOKEN = 'https://xluser-ssl.xunlei.com/v1/auth/token'
const FILES = 'https://api-pan.xunlei.com/drive/v1/files'

const FOLDER = { kind: 'drive#folder', id: 'd1', name: 'docs', modified_time: '2026-01-02T00:00:00Z' }
const FILE = { kind: 'drive#file', id: 'f1', name: 'a.txt', size: '10', modified_time: '2026-01-01T00:00:00Z' }
const FILE2 = { kind: 'drive#file', id: 'f2', name: 'b.txt', size: '20', modified_time: '2026-01-03T00:00:00Z' }
const FILE3 = { kind: 'drive#file', id: 'f3', name: 'c.txt', size: '30', modified_time: '2026-01-04T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Thunder driver', () => {
  it('lists one page with a cursor and a following page through page tokens', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.startsWith(FILES)) throw new Error(`unexpected ${url}`)
      const token = new URL(url).searchParams.get('page_token')
      if (token === 'p2') return json({ files: [FILE3] })
      return json({ files: [FOLDER, FILE], next_page_token: 'p2' })
    })

    const driver = createThunderDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt'])
    expect(first.cursor).toBe('p2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['c.txt'])
    expect(second.cursor).toBeNull()
  })

  it('walks every page when no page is requested', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.startsWith(FILES)) throw new Error(`unexpected ${url}`)
      calls++
      const token = new URL(url).searchParams.get('page_token')
      if (token === 'p2') return json({ files: [FILE3] })
      return json({ files: [FOLDER, FILE], next_page_token: 'p2' })
    })

    const collected = await createThunderDriver(context()).list('/', { pageSize: 2 })
    expect(collected.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt', 'c.txt'])
    expect(collected.cursor).toBeNull()
    expect(collected.truncated).toBe(false)
    expect(calls).toBe(2)
  })

  it('refreshes once when the drive rejects the token and writes both tokens back', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url.startsWith(FILES)) {
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer expired') return json({ error_code: 4122, error: 'token expired' }, 401)
        return json({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const result = await createThunderDriver(ctx).list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledWith(
      {
        accessToken: 'fresh',
        refreshToken: 'r2',
        expiresAt: expect.any(String),
      },
      { expect: { accessToken: 'expired', refreshToken: 'r1' } },
    )
    expect(ctx.markMock).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when the refresh token is refused', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN) return new Response('', { status: 401 })
      if (url.startsWith(FILES)) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createThunderDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('maps throttling and missing resources to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!String(input).startsWith(FILES)) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 429 })
    })
    await expect(createThunderDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!String(input).startsWith(FILES)) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 404 })
    })
    await expect(createThunderDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the file download link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://dl.example/t') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206 })
      }
      if (!url.startsWith(FILES)) throw new Error(`unexpected ${url}`)
      return json({ files: [{ ...FILE, web_content_link: 'https://dl.example/t' }] })
    })

    const response = await createThunderDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping, backslash and control paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createThunderDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/docs\\secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.list('/docs/\u0000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates a token only once for two concurrent requests', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN) {
        tokenCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url.startsWith(FILES)) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization !== 'Bearer fresh') return new Response('', { status: 401 })
        return json({ files: [FILE] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const first = createThunderDriver(ctx)
    const second = createThunderDriver(ctx)
    const [a, b] = await Promise.all([first.list('/'), second.list('/')])
    expect(a.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(b.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledTimes(1)
  })

  it('declares a writable mount', () => {
    const driver = createThunderDriver(context())
    expect(driver.capabilities.write).toBe(true)
    expect(driver.capabilities.mkdir).toBe(true)
    expect(driver.capabilities.copy).toBe(true)
  })

  it('creates a folder through files with a POST body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return json({ kind: 'drive#folder', id: 'new-dir', name: 'new' })
    })
    await createThunderDriver(context()).mkdir('/new')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(FILES)
    expect(calls[0].init.method).toBe('POST')
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(body.kind).toBe('drive#folder')
    expect(body.name).toBe('new')
    expect(body.parent_id).toBe('')
  })

  it('renames through a PATCH on the resolved file id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === `${FILES}/f1`) return json({ id: 'f1', name: 'b.txt' })
      if (url.startsWith(FILES)) return json({ files: [FILE] })
      throw new Error(`unexpected ${url}`)
    })
    await createThunderDriver(context()).rename('/a.txt', 'b.txt')
    const patch = calls.find((call) => call.url === `${FILES}/f1`)
    expect(patch?.init.method).toBe('PATCH')
    const body = JSON.parse(String(patch?.init.body)) as Record<string, unknown>
    expect(body.name).toBe('b.txt')
  })

  it('moves a file into the trash through the trash endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.startsWith(`${FILES}/f1/trash`)) return json({})
      if (url.startsWith(FILES)) return json({ files: [FILE] })
      throw new Error(`unexpected ${url}`)
    })
    await createThunderDriver(context()).remove('/a.txt')
    const trash = calls.find((call) => call.url.startsWith(`${FILES}/f1/trash`))
    expect(trash?.init.method).toBe('PATCH')
    expect(trash?.url).toContain('space=')
  })

  it('moves a file with batchMove', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === `${FILES}:batchMove`) return json({})
      if (url.startsWith(FILES)) return json({ files: [FOLDER, FILE] })
      throw new Error(`unexpected ${url}`)
    })
    await createThunderDriver(context()).move('/a.txt', '/docs/a.txt')
    const batch = calls.find((call) => call.url === `${FILES}:batchMove`)
    expect(batch?.init.method).toBe('POST')
    const body = JSON.parse(String(batch?.init.body)) as Record<string, unknown>
    expect(body.to).toEqual({ parent_id: 'd1' })
    expect(body.ids).toEqual(['f1'])
  })

  it('copies a file with batchCopy', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === `${FILES}:batchCopy`) return json({})
      if (url.startsWith(FILES)) return json({ files: [FOLDER, FILE] })
      throw new Error(`unexpected ${url}`)
    })
    await createThunderDriver(context()).copy!('/a.txt', '/docs/a.txt')
    const batch = calls.find((call) => call.url === `${FILES}:batchCopy`)
    expect(batch?.init.method).toBe('POST')
    const body = JSON.parse(String(batch?.init.body)) as Record<string, unknown>
    expect(body.to).toEqual({ parent_id: 'd1' })
    expect(body.ids).toEqual(['f1'])
  })

  it('uploads two parts and commits the multipart session', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const creates: Array<Record<string, unknown>> = []
    const parts: Array<{ number: string; length: number }> = []
    let commit: { url: string; body: string } | null = null
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === FILES && init?.method === 'POST') {
        creates.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json({
          upload_type: 'UPLOAD_TYPE_RESUMABLE',
          resumable: {
            params: {
              endpoint: 'bucket-a.oss.example.com',
              bucket: 'bucket-a',
              key: 'obj/k',
              security_token: 'sts',
              part_size: 2,
              upload_id: 'u1',
            },
          },
        })
      }
      if (url.startsWith('https://oss.example.com/bucket-a/obj/k?partNumber=')) {
        const parsed = new URL(url)
        const number = parsed.searchParams.get('partNumber') ?? ''
        expect(parsed.searchParams.get('uploadId')).toBe('u1')
        expect(new Headers(init?.headers).get('x-amz-security-token')).toBe('sts')
        parts.push({ number, length: (init?.body as Uint8Array).byteLength })
        return new Response('', { status: 200, headers: { etag: `"e${number}"` } })
      }
      if (url === 'https://oss.example.com/bucket-a/obj/k?uploadId=u1') {
        commit = { url, body: String(init?.body) }
        return new Response('', { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const progress = vi.fn()
    await createThunderDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength, onProgress: progress })
    expect(parts.map((part) => part.number)).toEqual(['1', '2'])
    expect(parts.map((part) => part.length)).toEqual([2, 2])
    expect(creates[0]).toMatchObject({
      kind: 'drive#file',
      name: 'a.txt',
      size: '4',
      upload_type: 'UPLOAD_TYPE_RESUMABLE',
    })
    expect(String(creates[0].hash)).toMatch(/^[0-9a-f]{40}$/)
    expect(commit).not.toBeNull()
    expect(commit!.body).toContain('<PartNumber>1</PartNumber>')
    expect(commit!.body).toContain('<ETag>"e1"</ETag>')
    expect(commit!.body).toContain('<ETag>"e2"</ETag>')
    expect(progress).toHaveBeenLastCalledWith(4, 4)
  })

  it('treats a create answer without a resumable session as an instant upload', async () => {
    const bytes = new Uint8Array([7, 7, 7])
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== FILES) throw new Error(`unexpected ${String(input)}`)
      return json({ upload_type: 'UPLOAD_TYPE_RESUMABLE', file: FILE })
    })
    vi.stubGlobal('fetch', fetchMock)
    const progress = vi.fn()
    await createThunderDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength, onProgress: progress })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(3, 3)
  })

  it('retries a dropped upload part once and then completes', async () => {
    const bytes = new Uint8Array([9, 9, 9, 9])
    const puts: number[] = []
    let attempts = 0
    let commitBody = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === FILES) {
        return json({
          resumable: {
            params: {
              endpoint: 'oss.example.com',
              bucket: 'bucket-a',
              key: 'obj/k',
              security_token: 'sts',
              part_size: 4,
              upload_id: 'u2',
            },
          },
        })
      }
      if (url.startsWith('https://oss.example.com/bucket-a/obj/k?partNumber=')) {
        attempts++
        if (attempts === 1) throw new Error('socket hang up')
        puts.push((init?.body as Uint8Array).byteLength)
        return new Response('', { status: 200, headers: { etag: '"e1"' } })
      }
      if (url === 'https://oss.example.com/bucket-a/obj/k?uploadId=u2') {
        commitBody = String(init?.body)
        return new Response('', { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    })

    await createThunderDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength })
    expect(attempts).toBe(2)
    expect(puts).toEqual([4])
    expect(commitBody).toContain('<PartNumber>1</PartNumber>')
  })

  it('maps a throttled write to rate_limit', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return new Response('', { status: 429 })
    })
    await expect(createThunderDriver(context()).mkdir('/throttled')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBe(3)
  })

  it('marks the storage for re-authorization when a write keeps failing auth', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN) return new Response('', { status: 401 })
      if (url === `${FILES}/f1` && init?.method === 'PATCH') return new Response('', { status: 401 })
      if (url.startsWith(FILES)) return json({ files: [FILE] })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context({}, 'storage-thunder-write-auth')
    await expect(createThunderDriver(ctx).rename('/a.txt', 'b.txt')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('rejects an illegal write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createThunderDriver(context())
    await expect(driver.mkdir('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.upload('/docs/../secret', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
