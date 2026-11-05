// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completeGuangYaPanLogin,
  createGuangyapanDriver,
  requestGuangYaPanVerification,
} from '../src/worker/clouddrive/drivers/guangyapan'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(
  credentials: Record<string, string> = {},
  storageId = 'storage-gyp',
): DriverContext & { saveMock: ReturnType<typeof vi.fn>; markMock: ReturnType<typeof vi.fn> } {
  const stored: Record<string, string> = {
    accessToken: 'expired',
    refreshToken: 'r1',
    clientId: 'client-1',
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
    type: 'guangyapan',
    config: { phoneNumber: '+86 13800000000' },
    credentials: stored,
    saveCredentials: saveMock,
    markNeedsReauth: markMock,
    saveMock,
    markMock,
  }
}

const ACCOUNT = 'https://account.guangyapan.com'
const API = 'https://api.guangyapan.com'
const ACCOUNT_TOKEN = `${ACCOUNT}/v1/auth/token`
const CAPTCHA_INIT = `${ACCOUNT}/v1/shield/captcha/init`
const VERIFICATION = `${ACCOUNT}/v1/auth/verification`
const VERIFICATION_VERIFY = `${ACCOUNT}/v1/auth/verification/verify`
const SIGNIN = `${ACCOUNT}/v1/auth/signin`
const FILE_LIST = `${API}/userres/v1/file/get_file_list`
const DOWNLOAD_URL = `${API}/nd.bizuserres.s/v1/get_res_download_url`
const CREATE_DIR = `${API}/nd.bizuserres.s/v1/file/create_dir`
const RENAME = `${API}/nd.bizuserres.s/v1/file/rename`
const MOVE = `${API}/nd.bizuserres.s/v1/file/move_file`
const COPY = `${API}/nd.bizuserres.s/v1/file/copy_file`
const DELETE = `${API}/nd.bizuserres.s/v1/file/delete_file`
const TASK_STATUS = `${API}/nd.bizuserres.s/v1/get_task_status`
const UPLOAD_TOKEN = `${API}/nd.bizuserres.s/v1/get_res_center_token`
const UPLOAD_INFO = `${API}/nd.bizuserres.s/v1/file/get_info_by_task_id`

const FILE = { fileId: 'f1', fileName: 'a.txt', fileSize: 10, resType: 1, utime: 1700000000 }
const FILE2 = { fileId: 'f2', fileName: 'b.txt', fileSize: 20, resType: 1, utime: 1700000100 }
const FILE3 = { fileId: 'f3', fileName: 'c.txt', fileSize: 30, resType: 1, utime: 1700000200 }
const FOLDER = { fileId: 'd1', fileName: 'docs', resType: 2 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GuangYaPan driver', () => {
  it('lists one page with a cursor and a following page', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url !== FILE_LIST) throw new Error(`unexpected ${url}`)
      const body = JSON.parse(String(init?.body)) as { page: number }
      return json({
        code: 0,
        msg: 'success',
        data: { total: 3, list: body.page === 0 ? [FILE, FILE2] : [FILE3] },
      })
    })

    const driver = createGuangyapanDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['c.txt'])
    expect(second.cursor).toBeNull()
  })

  it('walks every page when no page is requested', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url !== FILE_LIST) throw new Error(`unexpected ${url}`)
      calls++
      const body = JSON.parse(String(init?.body)) as { page: number }
      return json({
        code: 0,
        msg: 'success',
        data: { total: 3, list: body.page === 0 ? [FILE, FILE2] : [FILE3] },
      })
    })

    const collected = await createGuangyapanDriver(context()).list('/', { pageSize: 2 })
    expect(collected.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(collected.cursor).toBeNull()
    expect(collected.truncated).toBe(false)
    expect(calls).toBe(2)
  })

  it('refreshes once when the API rejects the token and writes both tokens back', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === ACCOUNT_TOKEN) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === FILE_LIST) {
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer expired') return new Response('', { status: 401 })
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const result = await createGuangyapanDriver(ctx).list('/')
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
      if (url === ACCOUNT_TOKEN) return new Response('', { status: 401 })
      if (url === FILE_LIST) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createGuangyapanDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markMock).toHaveBeenCalled()
  })

  it('maps throttling and missing resources to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) !== FILE_LIST) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 429 })
    })
    await expect(createGuangyapanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) !== FILE_LIST) throw new Error(`unexpected ${String(input)}`)
      return new Response('', { status: 404 })
    })
    await expect(createGuangyapanDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the signed download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://dl.example/g') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206 })
      }
      if (url === FILE_LIST) {
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      if (url === DOWNLOAD_URL) {
        return json({ code: 0, msg: 'success', data: { signedURL: 'https://dl.example/g' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const response = await createGuangyapanDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping, backslash and control paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createGuangyapanDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/docs\\secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.list('/docs/\u0000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates a token only once for two concurrent requests', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === ACCOUNT_TOKEN) {
        tokenCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === FILE_LIST) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization !== 'Bearer fresh') return new Response('', { status: 401 })
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const ctx = context()
    const first = createGuangyapanDriver(ctx)
    const second = createGuangyapanDriver(ctx)
    const [a, b] = await Promise.all([first.list('/'), second.list('/')])
    expect(a.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(b.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(ctx.saveMock).toHaveBeenCalledTimes(1)
  })

  it('advertises the write capabilities from the shared registry', () => {
    const driver = createGuangyapanDriver(context())
    expect(driver.capabilities.write).toBe(true)
    expect(driver.capabilities.mkdir).toBe(true)
    expect(driver.capabilities.rename).toBe(true)
    expect(driver.capabilities.move).toBe(true)
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.capabilities.delete).toBe(true)
    expect(driver.capabilities.directLink).toBe(true)
  })

  it('creates a folder under the resolved parent id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === FILE_LIST) {
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FOLDER] } })
      }
      if (url === CREATE_DIR) return json({ code: 0, msg: 'success', data: {} })
      throw new Error(`unexpected ${url}`)
    })

    await createGuangyapanDriver(context()).mkdir('/docs/new')
    expect(calls.at(-1)!.url).toBe(CREATE_DIR)
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ parentId: 'd1', dirName: 'new' })
  })

  it('renames a file by its resolved id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === FILE_LIST) {
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      if (url === RENAME) return json({ code: 0, msg: 'success', data: {} })
      throw new Error(`unexpected ${url}`)
    })

    await createGuangyapanDriver(context()).rename('/a.txt', 'b.txt')
    expect(calls.at(-1)!.url).toBe(RENAME)
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ fileId: 'f1', newName: 'b.txt' })
  })

  it('moves a file into the destination folder and waits for the task', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === FILE_LIST) {
        return json({ code: 0, msg: 'success', data: { total: 2, list: [FILE, FOLDER] } })
      }
      if (url === MOVE) return json({ code: 0, msg: 'success', data: { taskId: 't1' } })
      if (url === TASK_STATUS) return json({ code: 0, msg: 'success', data: { status: 2 } })
      throw new Error(`unexpected ${url}`)
    })

    await createGuangyapanDriver(context()).move('/a.txt', '/docs/a.txt')
    const move = calls.find((call) => call.url === MOVE)!
    expect(JSON.parse(String(move.init.body))).toEqual({ fileIds: ['f1'], parentId: 'd1' })
    expect(calls.some((call) => call.url === TASK_STATUS)).toBe(true)
  })

  it('copies a file into the destination folder and waits for the task', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === FILE_LIST) {
        return json({ code: 0, msg: 'success', data: { total: 2, list: [FILE, FOLDER] } })
      }
      if (url === COPY) return json({ code: 0, msg: 'success', data: { taskId: 't2' } })
      if (url === TASK_STATUS) return json({ code: 0, msg: 'success', data: { status: 2 } })
      throw new Error(`unexpected ${url}`)
    })

    await createGuangyapanDriver(context()).copy!('/a.txt', '/docs/a.txt')
    const copy = calls.find((call) => call.url === COPY)!
    expect(JSON.parse(String(copy.init.body))).toEqual({ fileIds: ['f1'], parentId: 'd1' })
    expect(calls.some((call) => call.url === TASK_STATUS)).toBe(true)
  })

  it('deletes a file by its resolved id and waits for the task', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === FILE_LIST) {
        return json({ code: 0, msg: 'success', data: { total: 1, list: [FILE] } })
      }
      if (url === DELETE) return json({ code: 0, msg: 'success', data: { taskId: 't3' } })
      if (url === TASK_STATUS) return json({ code: 0, msg: 'success', data: { status: 2 } })
      throw new Error(`unexpected ${url}`)
    })

    await createGuangyapanDriver(context()).remove('/a.txt')
    const remove = calls.find((call) => call.url === DELETE)!
    expect(JSON.parse(String(remove.init.body))).toEqual({ fileIds: ['f1'] })
    expect(calls.some((call) => call.url === TASK_STATUS)).toBe(true)
  })

  it('uploads a large file in two OSS parts and completes the multipart request', async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1024)
    const partCalls: Array<{ part: number; size: number; headers: Headers }> = []
    let completeBody = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === UPLOAD_TOKEN) {
        const body = JSON.parse(String(init?.body)) as { name: string; parentId: string; res: { fileSize: number; md5: string } }
        expect(body.name).toBe('a.bin')
        expect(body.parentId).toBe('')
        expect(body.res.fileSize).toBe(bytes.byteLength)
        expect(body.res.md5).toBe(createHash('md5').update(bytes).digest('hex'))
        return json({
          code: 0,
          msg: 'success',
          data: {
            taskId: 't1',
            objectPath: 'obj/a.bin',
            bucketName: 'bucket-a',
            endPoint: 'oss.example.com',
            creds: { accessKeyID: 'AK', secretAccessKey: 'SK', sessionToken: 'STS' },
          },
        })
      }
      if (url === 'https://bucket-a.oss.example.com/obj/a.bin?uploads') {
        expect(init?.method).toBe('POST')
        return new Response('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>')
      }
      if (url.includes('partNumber=')) {
        const parsed = new URL(url)
        const part = Number(parsed.searchParams.get('partNumber'))
        partCalls.push({
          part,
          size: (init?.body as Uint8Array).byteLength,
          headers: new Headers(init?.headers),
        })
        return new Response('', { status: 200, headers: { etag: `"e${part}"` } })
      }
      if (url === 'https://bucket-a.oss.example.com/obj/a.bin?uploadId=u1') {
        completeBody = String(init?.body ?? '')
        return new Response('', { status: 200 })
      }
      if (url === UPLOAD_INFO) return json({ code: 0, msg: 'success', data: { fileId: 'fnew' } })
      throw new Error(`unexpected ${url}`)
    })

    const progress = vi.fn()
    await createGuangyapanDriver(context()).upload('/a.bin', bytes, { size: bytes.byteLength, onProgress: progress })
    expect(partCalls.map((call) => call.part)).toEqual([1, 2])
    expect(partCalls[0]!.size).toBe(5 * 1024 * 1024)
    expect(partCalls[1]!.size).toBe(1024)
    expect(partCalls[0]!.headers.get('x-oss-security-token')).toBe('STS')
    expect(partCalls[0]!.headers.get('Authorization')).toMatch(/^OSS AK:/)
    expect(completeBody).toContain('<PartNumber>1</PartNumber>')
    expect(completeBody).toContain('<PartNumber>2</PartNumber>')
    expect(progress).toHaveBeenLastCalledWith(bytes.byteLength, bytes.byteLength)
  })

  it('returns after an instant-upload hit without a PUT', async () => {
    const bytes = new Uint8Array([4, 5, 6])
    let putCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === UPLOAD_TOKEN) {
        const body = JSON.parse(String(init?.body)) as { res: { md5: string } }
        expect(body.res.md5).toBe(createHash('md5').update(bytes).digest('hex'))
        return json({ code: 156, msg: '上传已完成', data: { taskId: 't1' } })
      }
      if (url === UPLOAD_INFO) return json({ code: 0, msg: 'success', data: { fileId: 'fnew' } })
      if (init?.method === 'PUT') putCalls++
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const progress = vi.fn()
    await createGuangyapanDriver(context()).upload('/a.txt', bytes, { size: bytes.byteLength, onProgress: progress })
    expect(putCalls).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenCalledWith(3, 3)
  })

  it('retries a failed OSS part once before giving up', async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1024)
    let partTwoCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === UPLOAD_TOKEN) {
        return json({
          code: 0,
          msg: 'success',
          data: {
            taskId: 't1',
            objectPath: 'obj/a.bin',
            bucketName: 'bucket-a',
            endPoint: 'oss.example.com',
            creds: { accessKeyID: 'AK', secretAccessKey: 'SK', sessionToken: 'STS' },
          },
        })
      }
      if (url === 'https://bucket-a.oss.example.com/obj/a.bin?uploads') {
        return new Response('<UploadId>u1</UploadId>')
      }
      if (url.includes('partNumber=2')) {
        partTwoCalls++
        if (partTwoCalls === 1) return new Response('', { status: 500 })
        return new Response('', { status: 200, headers: { etag: '"e2"' } })
      }
      if (url.includes('partNumber=1')) return new Response('', { status: 200, headers: { etag: '"e1"' } })
      if (url === 'https://bucket-a.oss.example.com/obj/a.bin?uploadId=u1') return new Response('')
      if (url === UPLOAD_INFO) return json({ code: 0, msg: 'success', data: { fileId: 'fnew' } })
      throw new Error(`unexpected ${url}`)
    })

    await createGuangyapanDriver(context()).upload('/a.bin', bytes, { size: bytes.byteLength })
    expect(partTwoCalls).toBe(2)
  })

  it('maps a throttled write to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) !== CREATE_DIR) throw new Error(`unexpected ${String(input)}`)
      return json({ code: 429, msg: 'slow down', data: {} })
    })
    await expect(createGuangyapanDriver(context()).mkdir('/new')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('marks the storage for re-authorization when a write keeps failing auth', async () => {
    const mark = vi.fn(async () => undefined)
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === ACCOUNT_TOKEN) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === CREATE_DIR) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context({}, 'storage-gyp-write-auth')
    ctx.markNeedsReauth = mark
    await expect(createGuangyapanDriver(ctx).mkdir('/new')).rejects.toMatchObject({ kind: 'auth' })
    expect(tokenCalls).toBe(1)
    expect(mark).toHaveBeenCalled()
  })

  it('rejects every invalid write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createGuangyapanDriver(context())
    await expect(driver.mkdir('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.rename('/a.txt', '../escape')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.move('/a.txt', '/docs/../x')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.copy!('/docs/../a', '/b')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.remove('/docs/../a')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.upload('/docs/../a', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GuangYaPan SMS login', () => {
  it('initialises the captcha and sends a verification code', async () => {
    const ctx = context({ accessToken: '', refreshToken: '' })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === CAPTCHA_INIT) {
        const body = JSON.parse(String(init?.body)) as { client_id: string; action: string; device_id: string; meta: { phone_number: string } }
        expect(body.client_id).toBe('client-1')
        expect(body.action).toBe('POST:/v1/auth/verification')
        expect(body.device_id).toBeTruthy()
        expect(body.meta.phone_number).toBe('+86 13800000000')
        return json({ captcha_token: 'cap1' })
      }
      if (url === VERIFICATION) {
        expect(new Headers(init?.headers).get('X-Captcha-Token')).toBe('cap1')
        const body = JSON.parse(String(init?.body)) as { phone_number: string; target: string; client_id: string }
        expect(body).toEqual({ phone_number: '+86 13800000000', target: 'ANY', client_id: 'client-1' })
        return json({ verification_id: 'vid1' })
      }
      throw new Error(`unexpected ${url}`)
    })

    await expect(requestGuangYaPanVerification(ctx)).resolves.toBe('vid1')
    expect(ctx.saveMock).toHaveBeenCalledWith({ captchaToken: 'cap1' })
    expect(ctx.saveMock).toHaveBeenCalledWith({ verificationId: 'vid1' })
  })

  it('maps a rejected verification code to auth without signing in', async () => {
    const ctx = context({ accessToken: '', refreshToken: '', verificationId: 'vid1' })
    let signinCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === VERIFICATION_VERIFY) {
        return json({ error: 'invalid_verification_code', error_description: 'wrong code' }, 400)
      }
      if (url === SIGNIN) signinCalls++
      throw new Error(`unexpected ${url}`)
    })

    await expect(completeGuangYaPanLogin(ctx, '000000')).rejects.toMatchObject({ kind: 'auth' })
    expect(signinCalls).toBe(0)
  })

  it('exchanges the verification code for tokens and writes them back', async () => {
    const ctx = context({ accessToken: '', refreshToken: '', verificationId: 'vid1' })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === VERIFICATION_VERIFY) {
        expect(JSON.parse(String(init?.body))).toEqual({
          verification_id: 'vid1',
          verification_code: '123456',
          client_id: 'client-1',
        })
        return json({ verification_token: 'vt1' })
      }
      if (url === SIGNIN) {
        expect(JSON.parse(String(init?.body))).toEqual({
          verification_code: '123456',
          verification_token: 'vt1',
          username: '+86 13800000000',
          client_id: 'client-1',
        })
        return json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 })
      }
      throw new Error(`unexpected ${url}`)
    })

    await expect(completeGuangYaPanLogin(ctx, '123456')).resolves.toEqual({
      accessToken: 'at1',
      refreshToken: 'rt1',
    })
    expect(ctx.saveMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'at1',
      refreshToken: 'rt1',
      expiresAt: expect.any(String),
      verificationId: '',
    }))
  })
})
