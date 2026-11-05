// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create189TvDriver } from '../src/worker/clouddrive/drivers/189-tv'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}, config: Record<string, unknown> = {}): DriverContext {
  const stored = { accessToken: 'tv-token', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-189-tv',
    type: '189_tv',
    config: { type: 'personal', ...config },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const LOGIN = 'https://api.cloud.189.cn/family/manage/loginFamilyMerge.action'
const LIST = 'https://api.cloud.189.cn/listFiles.action'
const DOWNLOAD = 'https://api.cloud.189.cn/getFileDownloadUrl.action'

const FOLDER = { id: 'fld-1', parentId: 0, name: 'docs', lastOpTime: '2024-01-02 10:00:00 +08' }
const FILE = { id: '100000000000000001', name: 'a.txt', size: 10, lastOpTime: '2024-01-01 10:00:00 +08' }
const FILE2 = { id: '100000000000000002', name: 'b.txt', size: 20, lastOpTime: '2024-01-03 10:00:00 +08' }

function session(): Response {
  return json({
    sessionKey: 'session-key',
    sessionSecret: 'session-secret',
    familySessionKey: 'family-key',
    familySessionSecret: 'family-secret',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('189 TV driver', () => {
  it('lists one page and exposes the next cursor, then walks all pages without a page option', async () => {
    const listCalls: number[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return session()
      if (url.startsWith(LIST)) {
        const page = Number(new URL(url).searchParams.get('pageNum'))
        listCalls.push(page)
        if (page === 1) {
          return json({ fileListAO: { count: 3, folderList: [FOLDER], fileList: [FILE] } })
        }
        if (page === 2) {
          return json({ fileListAO: { count: 3, fileList: [FILE2] } })
        }
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = create189TvDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)
    expect(first.entries[0]!.kind).toBe('folder')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['b.txt'])
    expect(second.cursor).toBeNull()
    expect(second.truncated).toBe(false)

    const collected = await driver.list('/', { pageSize: 2 })
    expect(collected.entries.map((entry) => entry.name)).toEqual(['docs', 'a.txt', 'b.txt'])
    expect(collected.cursor).toBeNull()
    expect(listCalls.filter((page) => page === 1)).toHaveLength(2)
  })

  it('marks the storage for re-authorization when the TV access token is refused', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return json({ res_code: 401, res_message: 'InvalidSessionKey' }, 401)
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(create189TvDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markNeedsReauth).toHaveBeenCalled()
  })

  it('maps throttling and missing items to rate_limit and not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return session()
      if (url.startsWith(LIST)) return new Response('', { status: 429 })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create189TvDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return session()
      if (url.startsWith(LIST)) return new Response('', { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    await expect(create189TvDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the temporary download address and returns the upstream stream', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return session()
      if (url.startsWith(LIST)) {
        return json({ fileListAO: { count: 1, fileList: [FILE] } })
      }
      if (url.startsWith(DOWNLOAD)) {
        return json({ fileDownloadUrl: 'http://cdn.example/a.txt' })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const response = await create189TvDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')

    const driver = create189TvDriver(context())
    const link = await driver.directLink!('/a.txt')
    expect(link).toBe('https://cdn.example/a.txt')
  })

  it('rejects escaping, backslash and control paths before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = create189TvDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/docs\\secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.list('/docs/\u0000')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates folders, renames, moves, copies and deletes through the real endpoints', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${url} ${String(init?.body ?? '')}`)
      if (url.startsWith(LOGIN)) return session()
      if (url.startsWith(LIST)) return json({ fileListAO: { count: 2, folderList: [FOLDER], fileList: [FILE] } })
      if (url.includes('/createFolder.action')) return json({ res_code: 0 })
      if (url.includes('/renameFile.action')) return json({ res_code: 0 })
      if (url.includes('/batch/createBatchTask.action')) return json({ taskId: 'task-1' })
      if (url.includes('/batch/checkBatchTask.action')) return json({ taskStatus: 4 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = create189TvDriver(context())
    await driver.mkdir('/new')
    await driver.rename('/a.txt', 'b.txt')
    await driver.move('/a.txt', '/docs/a.txt')
    await driver.copy!('/a.txt', '/docs/a.txt')
    await driver.remove('/docs')
    const all = calls.join('\n')
    expect(calls.some((call) => call.includes('/createFolder.action'))).toBe(true)
    expect(calls.some((call) => call.includes('/renameFile.action'))).toBe(true)
    expect(all).toContain('MOVE')
    expect(all).toContain('COPY')
    expect(all).toContain('DELETE')
  })

  it('uploads through create, PUT and commit, and skips the PUT when md5 is already stored', async () => {
    const putCalls: string[] = []
    let commitCalls = 0
    let createCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return session()
      if (url.startsWith(LIST)) return json({ fileListAO: { count: 1, folderList: [FOLDER] } })
      if (url.includes('/createUploadFile.action')) {
        createCalls++
        if (createCalls === 1) {
          return json({
            fileDataExists: 0, uploadFileId: 'u1',
            fileUploadUrl: 'https://upload.example/u1',
            fileCommitUrl: 'https://api.cloud.189.cn/commit.action',
          })
        }
        return json({ fileDataExists: 1 })
      }
      if (url === 'https://upload.example/u1') {
        putCalls.push(url)
        expect(init?.method).toBe('PUT')
        return new Response('', { status: 200 })
      }
      if (url.includes('/commit.action')) {
        commitCalls++
        return json({ res_code: 0 })
      }
      throw new Error(`unexpected ${url}`)
    })
    await create189TvDriver(context()).upload('/docs/a.txt', new Uint8Array([1, 2, 3]), { size: 3 })
    expect(createCalls).toBe(1)
    expect(putCalls).toHaveLength(1)
    expect(commitCalls).toBe(1)

    await create189TvDriver(context()).upload('/docs/a.txt', new Uint8Array([1, 2, 3]), { size: 3 })
    expect(createCalls).toBe(2)
    expect(putCalls).toHaveLength(1)
    expect(commitCalls).toBe(1)
  })

  it('maps write failures to auth and rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return session()
      return json({ res_code: 401, res_message: 'session expired' }, 401)
    })
    const ctx = context()
    await expect(create189TvDriver(ctx).mkdir('/new')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markNeedsReauth).toHaveBeenCalled()

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(LOGIN)) return session()
      return new Response('', { status: 429 })
    })
    await expect(create189TvDriver(context()).mkdir('/new')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('rejects an invalid write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(create189TvDriver(context()).mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares every reference write capability', () => {
    const driver = create189TvDriver(context())
    expect(driver.capabilities.write).toBe(true)
    expect(driver.capabilities.mkdir).toBe(true)
    expect(driver.capabilities.rename).toBe(true)
    expect(driver.capabilities.move).toBe(true)
    expect(driver.capabilities.copy).toBe(true)
    expect(driver.capabilities.delete).toBe(true)
  })
})
