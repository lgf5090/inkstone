// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMisskeyDriver } from '../src/worker/clouddrive/drivers/misskey'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

function stubFetch(handler: FetchHandler) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const options = init ?? {}
    calls.push({ url, init: options })
    return await handler(url, options)
  })
  return calls
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    accessToken: 'misskey-token',
    ...(overrides.credentials ?? {}),
  }
  const config: Record<string, unknown> = {
    endpoint: 'https://misskey.example',
    rootPath: '/',
    ...(overrides.config ?? {}),
  }
  return {
    userId: overrides.userId ?? USER,
    storageId: overrides.storageId ?? STORAGE,
    type: overrides.type ?? 'misskey',
    config,
    credentials,
    saveCredentials: overrides.saveCredentials ?? vi.fn(async () => ({})),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

const FOLDER = { id: 'folder-1', name: 'docs', createdAt: '2026-01-01T00:00:00Z' }
const FILE = { id: 'file-1', name: 'a.bin', size: 7, createdAt: '2026-01-02T00:00:00Z', url: 'https://cdn.example/a.bin' }
const ROOT_DRIVE = { id: 'root-drive', name: 'drive', createdAt: '2025-12-01T00:00:00Z' }

function driveBody(init: RequestInit): Record<string, unknown> {
  return init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Misskey driver', () => {
  it('lists folders and files from /api/drive without pagination and follows rootPath', async () => {
    const calls = stubFetch((url, init) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer misskey-token')
      const body = driveBody(init)
      if (url.endsWith('/api/drive/folders')) {
        return body.folderId === 'root-drive' ? json([FOLDER]) : json([ROOT_DRIVE])
      }
      if (url.endsWith('/api/drive/files')) return json([FILE])
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMisskeyDriver(context({ config: { rootPath: '/drive' } }))
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['docs', 'a.bin'])
    expect(result.entries[0]!.kind).toBe('folder')
    expect(result.entries[1]!.ref).toBe('file-1')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
    expect(calls.filter((call) => call.url.endsWith('/api/drive/folders'))).toHaveLength(2)
    expect(calls.filter((call) => call.url.endsWith('/api/drive/files'))).toHaveLength(1)
  })

  it('marks the storage for re-authorization when the token is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    stubFetch(() => json({ error: { message: 'unauthorized' } }, 401))
    const driver = createMisskeyDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to a rate-limit driver error', async () => {
    stubFetch(() => json({ error: { message: 'slow down' } }, 429))
    const driver = createMisskeyDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    stubFetch(() => json({ error: { message: 'gone' } }, 404))
    const driver = createMisskeyDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the nested upstream error message', async () => {
    stubFetch(() => json({ error: { message: 'drive is full' } }, 400))
    const driver = createMisskeyDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('drive is full'),
    })
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createMisskeyDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves the file url and forwards Range to it', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/drive/files')) return json([FILE])
      if (url.endsWith('/api/drive/folders')) return json([])
      if (url.endsWith('/api/drive/files/show')) return json(FILE)
      if (url === 'https://cdn.example/a.bin') {
        expect(new Headers(init.headers).get('Range')).toBe('bytes=0-2')
        return new Response('abc', { status: 206 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createMisskeyDriver(context())
    const response = await driver.read('/a.bin', 'bytes=0-2')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abc')
    expect(await driver.directLink!('/a.bin')).toBe('https://cdn.example/a.bin')
  })

  it('creates folders with folders/create and updates entries by native id', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    stubFetch((url, init) => {
      requests.push({ url, body: driveBody(init) })
      if (url.endsWith('/api/drive/folders')) return json([])
      if (url.endsWith('/api/drive/files')) return json([FILE])
      return json({})
    })

    const driver = createMisskeyDriver(context())
    await driver.mkdir('/docs')
    await driver.rename('/a.bin', 'b.bin')
    await driver.remove('/a.bin')

    const create = requests.find((request) => request.url.endsWith('/api/drive/folders/create'))
    expect(create).toBeDefined()
    expect(create!.body).toEqual({ name: 'docs' })
    const update = requests.find((request) => request.url.endsWith('/api/drive/files/update'))
    expect(update!.body).toEqual({ fileId: 'file-1', name: 'b.bin' })
    const del = requests.find((request) => request.url.endsWith('/api/drive/files/delete'))
    expect(del!.body).toEqual({ fileId: 'file-1' })
  })

  it('copies a file through upload-from-url and rejects folder copies', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    stubFetch((url, init) => {
      requests.push({ url, body: driveBody(init) })
      if (url.endsWith('/api/drive/folders')) return json([FOLDER])
      if (url.endsWith('/api/drive/files')) return json([FILE])
      if (url.endsWith('/api/drive/files/show')) return json(FILE)
      if (url.endsWith('/api/drive/files/upload-from-url')) return json({ ...FILE, id: 'file-2' })
      return json({})
    })
    const driver = createMisskeyDriver(context())
    await driver.copy!('/a.bin', '/b.bin')
    const upload = requests.find((request) => request.url.endsWith('/api/drive/files/upload-from-url'))
    expect(upload!.body).toEqual({ url: 'https://cdn.example/a.bin' })
    const update = requests.find((request) => request.url.endsWith('/api/drive/files/update'))
    expect(update!.body).toEqual({ fileId: 'file-2', name: 'b.bin', folderId: null })

    await expect(driver.copy!('/docs', '/docs-copy')).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('has no upload capability but exposes copy', async () => {
    const driver = createMisskeyDriver(context())
    expect(driver.upload).toBeUndefined()
    expect(driver.copy).toBeTypeOf('function')
    expect(driver.capabilities.copy).toBe(true)
  })
})
