// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudflareImgbedDriver } from '../src/worker/clouddrive/drivers/cloudflare_imgbed'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'
const ADDRESS = 'https://img.example.com'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { token: 'tok', ...(overrides.credentials ?? {}) }
  const config: Record<string, unknown> = {
    address: ADDRESS,
    rootFolderPath: '/',
    smallChannelName: 'small',
    largeChannelName: '',
    uploadThread: 3,
    ...(overrides.config ?? {}),
  }
  return Object.assign<DriverContext, Partial<DriverContext>, Partial<DriverContext>>(
    {
      userId: USER,
      storageId: STORAGE,
      type: 'cloudflare_imgbed',
      config,
      credentials,
      saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
      markNeedsReauth: vi.fn(async () => undefined),
    },
    overrides,
    { config, credentials },
  )
}

function pageRequest(url: string): { start: number; count: number } | null {
  const parsed = new URL(url)
  if (parsed.pathname !== '/api/manage/list') return null
  return { start: Number(parsed.searchParams.get('start')), count: Number(parsed.searchParams.get('count')) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CloudFlare-ImgBed driver', () => {
  it('polls the manage list with start/count and returns the next start as its cursor', async () => {
    const starts: number[] = []
    const counts: number[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const page = pageRequest(String(input))
      if (!page) throw new Error(`unexpected ${String(input)}`)
      starts.push(page.start)
      counts.push(page.count)
      if (page.start === 0) {
        return json({
          files: [{ name: 'a.txt', metadata: { FileSizeBytes: '10', TimeStamp: 1700000000000 } }],
          directories: ['/docs'],
        })
      }
      if (page.start === 2) return json({ files: [{ name: 'b.pdf', metadata: { size: 20 } }], directories: [] })
      throw new Error(`unexpected start ${page.start}`)
    })

    const driver = createCloudflareImgbedDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt'])
    expect(first.entries[1]!.kind).toBe('file')
    expect(first.entries[1]!.size).toBe(10)
    expect(first.entries[1]!.modifiedAt).toBe(1700000000000)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.pdf'])
    expect(second.cursor).toBeNull()
    expect(starts).toEqual([0, 2])
    expect(counts).toEqual([2, 2])
  })

  it('marks the storage for re-authorization when the token is rejected twice', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ error: 'unauthorized' }, 401))

    const driver = createCloudflareImgbedDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps 429 to a rate-limit driver error', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createCloudflareImgbedDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = createCloudflareImgbedDriver(context())
    await expect(driver.stat('/a.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('streams the public /file URL and forwards Range', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (pageRequest(url)) {
        return json({ files: [{ name: 'a.txt', metadata: { FileSizeBytes: 10 } }], directories: [] })
      }
      if (url === `${ADDRESS}/file/a.txt`) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createCloudflareImgbedDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping paths and control characters before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createCloudflareImgbedDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/bad\u0000name')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps undeclared optional capabilities undefined and refuses mkdir explicitly', async () => {
    const driver = createCloudflareImgbedDriver(context())
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.capabilities.mkdir).toBe(false)
    expect(driver.copy).toBeUndefined()
    await expect(driver.mkdir('/photos')).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('uploads with the channel and folder query and learns the public host', async () => {
    let uploadUrl = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(`${ADDRESS}/upload?`)) {
        uploadUrl = url
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok')
        const form = init?.body
        expect(form).toBeInstanceOf(FormData)
        expect((form as FormData).get('file')).toBeTruthy()
        return json([{ src: '/file/docs/a.jpg', publicUrl: 'https://cdn.example.com/docs/a.jpg' }])
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createCloudflareImgbedDriver(context())
    await driver.upload('/docs/a.jpg', new Uint8Array(5), { size: 5, contentType: 'image/jpeg' })
    const params = new URL(uploadUrl).searchParams
    expect(params.get('returnFormat')).toBe('default')
    expect(params.get('channelName')).toBe('small')
    expect(params.get('uploadFolder')).toBe('/docs')
    expect(params.get('autoRetry')).toBe('true')
  })
})
