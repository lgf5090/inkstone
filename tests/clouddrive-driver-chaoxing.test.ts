// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChaoxingDriver } from '../src/worker/clouddrive/drivers/chaoxing'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const GROUP = 'https://groupweb.chaoxing.com'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'JSESSIONID=group-session',
    password: '',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'chaoxing',
    config: { userName: 'reader', bbsId: '123456', rootFolderId: '-1', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FOLDER = { id: 900, inserttime: 1_760_000_000, content: { folderName: 'docs' } }
const FILE_A = { id: 101, content: { name: 'a.mp3', fileId: 'f101', size: 9, uploadDate: 1_760_100_000 } }
const FILE_B = { id: 102, content: { name: 'b.txt', objectId: 'obj102', size: 5, uploadDate: 1_760_200_000 } }
const FILE_C = { id: 103, content: { name: 'c.bin', fileId: 'f103', size: 7, uploadDate: 1_760_300_000 } }

/** Resource list fixture keyed by recType and offset. */
function resourceFixture(
  pages: { folders?: Record<string, unknown[]>; files?: Record<string, unknown[]> },
) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (!url.startsWith(GROUP)) throw new Error(`unexpected ${url}`)
    const parsed = new URL(url)
    const recType = parsed.searchParams.get('recType') ?? ''
    const offset = parsed.searchParams.get('offset') ?? '0'
    const list = recType === '1'
      ? (pages.folders?.[offset] ?? [])
      : (pages.files?.[offset] ?? [])
    return json({ result: 1, list })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Chaoxing driver', () => {
  it('lists both resource kinds and continues from the requested offset', async () => {
    vi.stubGlobal('fetch', resourceFixture({
      folders: { '0': [FOLDER] },
      files: { '0': [FILE_A, FILE_B], '2': [FILE_C] },
    }))
    const driver = createChaoxingDriver(context())
    const all = await driver.list('/')
    expect(all.entries.map((entry) => entry.name)).toEqual(['docs', 'a.mp3', 'b.txt'])
    expect(all.entries[0]!.kind).toBe('folder')
    expect(all.entries[2]!.mime).toBe('text/plain')

    const page = await driver.list('/', { page: 2, pageSize: 2 })
    expect(page.entries.map((entry) => entry.name)).toEqual(['c.bin'])
    expect(page.cursor).toBeNull()
  })

  it('signs in with AES-encrypted fields and stores the returned cookie', async () => {
    const save = vi.fn(async () => undefined)
    let cookieSent = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/fanyalogin')) {
        const form = init?.body as FormData
        const uname = String(form.get('uname') ?? '')
        expect(uname).not.toBe('reader')
        expect(uname).toMatch(/^[A-Za-z0-9+/]+=*$/)
        return new Response('{}', { headers: { 'set-cookie': 'JSESSIONID=fresh; Path=/' } })
      }
      cookieSent = new Headers(init?.headers).get('cookie') ?? ''
      return json({ result: 1, list: [FOLDER] })
    })
    const driver = createChaoxingDriver(context({
      credentials: { cookie: '', password: 'secret' },
      saveCredentials: save,
    }))
    await driver.list('/')
    expect(cookieSent).toContain('JSESSIONID=fresh')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cookie: expect.stringContaining('JSESSIONID=fresh') }))
  })

  it('marks the storage for re-authorization when the cookie is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ msg: '请先登录' }, 401))
    const driver = createChaoxingDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps HTTP 429 and HTTP 404 responses to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    const limited = createChaoxingDriver(context())
    await expect(limited.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }))
    const missing = createChaoxingDriver(context())
    await expect(missing.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the link the list already handed back', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://cdn.example/a.mp3') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-3')
        return new Response('abcd', { status: 206, headers: { 'content-range': 'bytes 0-3/9' } })
      }
      return json({
        result: 1,
        list: [{ id: 101, content: { ...FILE_A.content, download: 'https://cdn.example/a.mp3' } }],
      })
    })
    const driver = createChaoxingDriver(context())
    const response = await driver.read('/a.mp3', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcd')
  })

  it('resolves a missing download address through the noteyd endpoint', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/getResourceList')) return json({ result: 1, list: [FILE_B] })
      if (url.includes('/screen/note_note/files/status/obj102')) {
        return json({ status: true, download: 'https://download.example/b.txt' })
      }
      if (url === 'https://download.example/b.txt') return new Response('hello', { status: 200 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createChaoxingDriver(context())
    const link = await driver.directLink!('/b.txt')
    expect(link).toBe('https://download.example/b.txt')
    const response = await driver.read('/b.txt')
    expect(await response.text()).toBe('hello')
  })

  it('uploads through pan-yz multipart and registers the resource', async () => {
    let token = ''
    let registered = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/pc/files/getUploadConfig')) return json({ result: 1, msg: { token: 'upload-token', puid: 42 } })
      if (url === 'https://pan-yz.chaoxing.com/upload') {
        const form = init?.body as FormData
        token = String(form.get('_token') ?? '')
        expect(form.get('puid')).toBe('42')
        expect(form.get('file')).toBeInstanceOf(Blob)
        return json({ msg: 'success', objectId: 'object-1', data: { size: 4 } })
      }
      if (url.includes('/pc/resource/addResource')) {
        registered = new URL(url).searchParams.get('params') ?? ''
        return json({ result: 1 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createChaoxingDriver(context())
    await driver.upload('/new.txt', new Uint8Array([1, 2, 3, 4]), { size: 4 })
    expect(token).toBe('upload-token')
    expect(registered).toContain('object-1')
    expect(registered).toContain('100000019')
  })

  it('rejects invalid paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createChaoxingDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/docs/../escape')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps rename unsupported and copy undefined', async () => {
    const driver = createChaoxingDriver(context())
    expect(driver.capabilities.rename).toBe(false)
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    await expect(driver.rename('/a.mp3', 'b.mp3')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
