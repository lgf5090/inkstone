// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTeraboxDriver } from '../src/worker/clouddrive/drivers/terabox'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'ndus=valid-session; ndut_fmt=ok',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'terabox',
    config: { downloadApi: 'official', rootFolderPath: '/', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const FILE_A = { fs_id: 101, server_filename: 'a.txt', size: 10, isdir: 0, server_mtime: 1_700_000_000 }
const FILE_B = { fs_id: 102, server_filename: 'b.pdf', size: 20, isdir: 0, server_mtime: 1_700_000_100 }
const FOLDER = { fs_id: 103, server_filename: 'docs', size: 0, isdir: 1, server_mtime: 1_700_000_200 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TeraBox driver', () => {
  it('walks pages and returns the requested page plus its cursor', async () => {
    let lists = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/api/list')) throw new Error(`unexpected ${url}`)
      lists += 1
      return lists === 1
        ? json({ errno: 0, list: [FILE_A, FILE_B] })
        : json({ errno: 0, list: [FOLDER] })
    })

    const driver = createTeraboxDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.entries[0]!.modifiedAt).toBe(FILE_A.server_mtime * 1000)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(lists).toBe(2)
  })

  it('marks the storage for re-authorization when the cookie is refused', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
    const driver = createTeraboxDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0.001' } }))
    const driver = createTeraboxDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps an upstream 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/list')) return new Response('', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createTeraboxDriver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('signs the download, resolves its redirect, and forwards Range with the TeraBox UA', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/list')) return json({ errno: 0, list: [FILE_A] })
      if (url.includes('/api/home/info')) return json({ errno: 0, data: { sign1: 'sign-one', sign3: 'sign-three' } })
      if (url.includes('/api/download')) {
        const params = new URL(url).searchParams
        expect(params.get('type')).toBe('dlink')
        expect(params.get('fidlist')).toBe('[101]')
        expect(params.get('sign')).toBeTruthy()
        expect(Number(params.get('timestamp'))).toBeGreaterThan(0)
        return json({ errno: 0, dlink: [{ dlink: 'https://dl.example/a.txt' }] })
      }
      if (url === 'https://dl.example/a.txt') {
        return new Response('', { status: 302, headers: { location: 'https://cdn.example/a.txt' } })
      }
      if (url === 'https://cdn.example/a.txt') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=2-5')
        expect(headers.get('User-Agent')).toContain('terabox')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createTeraboxDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('refuses a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createTeraboxDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('precreates a block manifest, uploads every part, and commits with create', async () => {
    const size = 4 * 1024 * 1024 + 1
    const bytes = new Uint8Array(size)
    const uploads: string[] = []
    const progress: number[] = []
    let created = false
    let blocks = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('locateupload')) return json({ host: 'upload.example' })
      if (url.includes('/api/precreate')) {
        const form = new URLSearchParams(String(init?.body))
        expect(form.get('path')).toBe('/a.bin')
        expect(form.get('target_path')).toBe('/')
        blocks = (JSON.parse(form.get('block_list') ?? '[]') as string[]).length
        return json({ errno: 0, uploadid: 'upload-1', return_type: 1 })
      }
      if (url.startsWith('https://upload.example/')) {
        expect(init?.method).toBe('POST')
        uploads.push(url)
        return new Response('', { status: 200 })
      }
      if (url.includes('/api/create')) {
        created = true
        return json({ errno: 0 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createTeraboxDriver(context())
    await driver.upload('/a.bin', bytes, { size, onProgress: (done) => progress.push(done) })
    expect(blocks).toBe(2)
    expect(uploads).toHaveLength(2)
    expect([...progress].sort((left, right) => left - right)).toEqual([4 * 1024 * 1024, size])
    expect(created).toBe(true)
  })

  it('keeps its capability bits in step with the registry', () => {
    const driver = createTeraboxDriver(context())
    expect(driver.definition).toBe(findCloudDriveDriver('terabox'))
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.copy).toBeTypeOf('function')
    expect(driver.directLink).toBeTypeOf('function')
    expect(driver.capabilities.range).toBe(true)
  })
})
