// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNeteaseMusicDriver } from '../src/worker/clouddrive/drivers/netease_music'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const MUSIC = 'https://music.163.com'
const COOKIE = 'MUSIC_U=music-session; __csrf=csrf-token'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { cookie: COOKIE, ...(overrides.credentials ?? {}) }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'netease_music',
    config: { songLimit: 200, ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const SONG_A = { addTime: 1_760_000_000, fileName: 'a.mp3', fileSize: 100, songId: 111 }
const SONG_B = { addTime: 1_760_100_000, fileName: 'b.m4a', fileSize: 200, songId: 112 }
const SONG_C = { addTime: 1_760_200_000, fileName: 'c.flac', fileSize: 300, songId: 113 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NetEase Cloud Music driver', () => {
  it('continues the cloud/get list with the offset until a short page', async () => {
    let cloudCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(`${MUSIC}/weapi/v1/cloud/get`)) {
        cloudCalls++
        return json({ code: 200, data: cloudCalls === 1 ? [SONG_A, SONG_B] : [SONG_C] })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createNeteaseMusicDriver(context())
    const result = await driver.list('/', { pageSize: 2 })
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.mp3', 'b.m4a', 'c.flac'])
    expect(result.entries[1]!.mime).toBe('audio/m4a')
    expect(result.cursor).toBeNull()
    expect(cloudCalls).toBe(2)
  })

  it('returns a page and its cursor without walking the rest', async () => {
    let cloudCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.startsWith(`${MUSIC}/weapi/v1/cloud/get`)) throw new Error(`unexpected ${url}`)
      cloudCalls++
      return json({ code: 200, data: [SONG_C] })
    })
    const driver = createNeteaseMusicDriver(context())
    const page = await driver.list('/', { page: 2, pageSize: 2 })
    expect(page.entries.map((entry) => entry.name)).toEqual(['c.flac'])
    expect(page.cursor).toBeNull()
    expect(cloudCalls).toBe(1)
  })

  it('requires MUSIC_U and __csrf before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createNeteaseMusicDriver(context({ credentials: { cookie: '__csrf=only' } }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when weapi answers code 301', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ code: 301, msg: 'need login' }))
    const driver = createNeteaseMusicDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps HTTP 429 and HTTP 404 to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    const limited = createNeteaseMusicDriver(context())
    await expect(limited.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }))
    const missing = createNeteaseMusicDriver(context())
    await expect(missing.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('resolves the song url through linuxapi and forwards Range', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://cdn.example/a.mp3') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-3')
        return new Response('abcd', { status: 206, headers: { 'content-range': 'bytes 0-3/100' } })
      }
      if (url.startsWith(`${MUSIC}/weapi/v1/cloud/get`)) return json({ code: 200, data: [SONG_A] })
      if (url.startsWith(`${MUSIC}/api/linux/forward`)) {
        return json({ code: 200, data: [{ url: 'https://cdn.example/a.mp3' }] })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createNeteaseMusicDriver(context())
    const response = await driver.read('/a.mp3', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcd')
  })

  it('rejects invalid paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createNeteaseMusicDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/../escape')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports upload, mkdir, rename and move as unsupported and keeps copy undefined', async () => {
    const driver = createNeteaseMusicDriver(context())
    expect(driver.capabilities.write).toBe(false)
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    await expect(driver.upload('/a.mp3', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.mkdir('/folder')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.rename('/a.mp3', 'b.mp3')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/a.mp3', '/x/b.mp3')).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('deletes a song with weapi/cloud/del and persists a rotated cookie', async () => {
    let deleted = ''
    const save = vi.fn(async () => ({}))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(`${MUSIC}/weapi/v1/cloud/get`)) {
        return json({ code: 200, data: [SONG_A] }, 200, { 'set-cookie': 'MUSIC_U=music-refresh; Path=/' })
      }
      if (url.startsWith(`${MUSIC}/weapi/cloud/del`)) {
        deleted = url
        return json({ code: 200 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createNeteaseMusicDriver(context({ saveCredentials: save }))
    await driver.remove('/a.mp3')
    expect(deleted).toContain('/weapi/cloud/del')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cookie: expect.stringContaining('MUSIC_U=music-refresh') }), undefined)
  })
})
