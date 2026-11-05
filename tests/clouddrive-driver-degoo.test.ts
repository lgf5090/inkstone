// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDegooDriver } from '../src/worker/clouddrive/drivers/degoo'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const GRAPHQL_HOST = 'production-appsync.degoo.com'
const TOKEN_URL = 'https://rest-api.degoo.com/access-token/v2'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fakeJwt(expiresInMs = 3_600_000): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) })).replace(/=+$/, '')
  return `e30.${payload}.sig`
}

function context(credentials: Record<string, string> = {}, config: Record<string, unknown> = {}): DriverContext {
  const stored: Record<string, string> = {
    username: 'owner@example.com',
    password: 'secret',
    accessToken: fakeJwt(),
    expiresAt: String(Date.now() + 3_600_000),
    ...credentials,
  }
  return {
    userId: 'user-a',
    storageId: 'storage-degoo',
    type: 'degoo',
    config: { rootFolderId: 'root', username: stored.username, ...config },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const FILE_A = { ID: 'f1', ParentID: 'root', Name: 'a.txt', Category: 0, Size: '10', LastModificationTime: '2026-01-01T00:00:00Z' }
const FILE_B = { ID: 'f2', ParentID: 'root', Name: 'b.pdf', Category: 0, Size: '20', LastModificationTime: '2026-01-02T00:00:00Z' }
const FOLDER = { ID: 'd1', ParentID: 'root', Name: 'docs', Category: 1, Size: '0', LastModificationTime: '2026-01-03T00:00:00Z' }

function children(items: unknown[], next?: string): Response {
  return json({ data: { getFileChildren5: { Items: items, ...(next ? { NextToken: next } : {}) } } })
}

async function bodyOf(init?: RequestInit): Promise<Record<string, unknown>> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Degoo driver', () => {
  it('walks NextToken pages and returns a requested page plus its cursor', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname !== GRAPHQL_HOST) throw new Error(`unexpected ${url}`)
      const body = await bodyOf(init)
      if (body.operationName !== 'GetFileChildren5') throw new Error(`unexpected operation ${String(body.operationName)}`)
      listCalls++
      const variables = body.variables as Record<string, unknown>
      if (variables.NextToken === 't2') return children([FOLDER])
      return children([FILE_A, FILE_B], 't2')
    })

    const driver = createDegooDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('t2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()

    const all = await driver.list('/')
    expect(all.entries).toHaveLength(3)
    expect(all.truncated).toBe(false)
    expect(listCalls).toBe(5)
  })

  it('maps an Unauthorized GraphQL error to auth and marks the storage', async () => {
    const mark = vi.fn(async () => undefined)
    let refreshCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        refreshCalls++
        return json({ message: 'refresh token revoked' }, 401)
      }
      return json({ errors: [{ errorType: 'Unauthorized', message: 'token expired' }] })
    })
    const ctx = context({ refreshToken: 'r1' })
    ctx.markNeedsReauth = mark
    const driver = createDegooDriver(ctx)
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
    expect(refreshCalls).toBe(1)
  })

  it('maps throttling to rate_limit and a missing item to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0.1' } }))
    await expect(createDegooDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    await expect(createDegooDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createDegooDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes once for two concurrent requests', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.href === TOKEN_URL) {
        tokenCalls++
        return json({ AccessToken: fakeJwt() })
      }
      if (url.hostname !== GRAPHQL_HOST) throw new Error(`unexpected ${url}`)
      const body = await bodyOf(init)
      if (body.operationName !== 'GetFileChildren5') throw new Error(`unexpected operation ${String(body.operationName)}`)
      return children([FILE_A])
    })
    const shared = context({ accessToken: '', refreshToken: 'r1', expiresAt: '0' })
    const first = createDegooDriver(shared)
    const second = createDegooDriver(shared)
    await Promise.all([first.list('/'), second.list('/')])
    expect(tokenCalls).toBe(1)
    expect(shared.credentials.accessToken).not.toBe('')
  })

  it('forwards Range to the overlay download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === GRAPHQL_HOST) {
        const body = await bodyOf(init)
        if (body.operationName === 'GetOverlay4') {
          return json({ data: { getOverlay4: { ...FILE_A, URL: 'https://dl.example/f1' } } })
        }
        return children([FILE_A])
      }
      if (url.hostname === 'dl.example') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const response = await createDegooDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('creates a folder through the SetUploadFile3 mutation', async () => {
    const seen: Array<{ operation: string; variables: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname !== GRAPHQL_HOST) throw new Error(`unexpected ${url}`)
      const body = await bodyOf(init)
      seen.push({ operation: String(body.operationName), variables: body.variables as Record<string, unknown> })
      return json({ data: { setUploadFile3: true } })
    })
    await createDegooDriver(context()).mkdir('/docs')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.operation).toBe('SetUploadFile3')
    expect(seen[0]!.variables.FileInfos).toEqual([
      { Checksum: 'CgAQAg', Name: 'docs', CreationTime: expect.any(Number), ParentID: 'root', Size: 0 },
    ])
  })

  it('renames an entry through the SetRenameFile mutation', async () => {
    const renames: unknown[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname !== GRAPHQL_HOST) throw new Error(`unexpected ${url}`)
      const body = await bodyOf(init)
      if (body.operationName === 'GetFileChildren5') return children([FILE_A, FOLDER])
      if (body.operationName !== 'SetRenameFile') throw new Error(`unexpected operation ${String(body.operationName)}`)
      renames.push((body.variables as Record<string, unknown>).FileRenames)
      return json({ data: { setRenameFile: true } })
    })
    await createDegooDriver(context()).rename('/a.txt', 'b.txt')
    expect(renames).toEqual([[{ ID: 'f1', NewName: 'b.txt' }]])
  })

  it('moves an entry through the SetMoveFile mutation', async () => {
    const moves: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname !== GRAPHQL_HOST) throw new Error(`unexpected ${url}`)
      const body = await bodyOf(init)
      if (body.operationName === 'GetFileChildren5') return children([FILE_A, FOLDER])
      if (body.operationName !== 'SetMoveFile') throw new Error(`unexpected operation ${String(body.operationName)}`)
      moves.push(body.variables as Record<string, unknown>)
      return json({ data: { setMoveFile: true } })
    })
    await createDegooDriver(context()).move('/a.txt', '/docs/a.txt')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ Copy: false, NewParentID: 'd1', FileIDs: ['f1'] })
  })

  it('deletes an entry through the SetDeleteFile5 mutation', async () => {
    const deletes: unknown[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname !== GRAPHQL_HOST) throw new Error(`unexpected ${url}`)
      const body = await bodyOf(init)
      if (body.operationName === 'GetFileChildren5') return children([FILE_A, FOLDER])
      if (body.operationName !== 'SetDeleteFile5') throw new Error(`unexpected operation ${String(body.operationName)}`)
      deletes.push((body.variables as Record<string, unknown>).IDs)
      return json({ data: { setDeleteFile5: true } })
    })
    await createDegooDriver(context()).remove('/a.txt')
    expect(deletes).toEqual([[{ FileID: 'f1' }]])
  })

  it('maps a throttled write call to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0.01' } }))
    await expect(createDegooDriver(context()).mkdir('/docs')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a 401 on a write call to auth and marks the storage', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return new Response('', { status: 401 })
      return new Response('', { status: 401 })
    })
    const ctx = context({ refreshToken: 'r1' })
    ctx.markNeedsReauth = mark
    const driver = createDegooDriver(ctx)
    await expect(driver.mkdir('/docs')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('refuses an escaping write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createDegooDriver(context())
    await expect(driver.mkdir('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.rename('/docs/../secret', 'b.txt')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.move('/docs/../secret', '/docs')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.remove('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps upload and copy unsupported', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createDegooDriver(context())
    expect(driver.capabilities).toMatchObject({
      write: false,
      mkdir: true,
      rename: true,
      move: true,
      copy: false,
      delete: true,
      range: true,
    })
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.copy!('/a.txt', '/b.txt')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
