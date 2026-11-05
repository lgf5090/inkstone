// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDropboxDriver } from '../src/worker/clouddrive/drivers/dropbox'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { refreshToken: 'r1', clientId: 'cid', clientSecret: 'secret', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-dbx',
    type: 'dropbox',
    config: {},
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const RPC = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
const FILE = { '.tag': 'file', name: 'a.txt', path_display: '/a.txt', size: 10, server_modified: '2026-01-01T00:00:00Z' }
const FOLDER = { '.tag': 'folder', name: 'docs', path_display: '/docs' }

function token(): Response {
  return json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Dropbox driver', () => {
  it('walks list_folder and continue pages', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url === `${RPC}/files/list_folder`) {
        calls.push('list')
        return json({ entries: [FILE], cursor: 'c1', has_more: true })
      }
      if (url === `${RPC}/files/list_folder/continue`) {
        calls.push('continue')
        return json({ entries: [FOLDER], cursor: 'c2', has_more: false })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createDropboxDriver(context())
    const first = await driver.list('/', { page: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('c1')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2 })
    expect(second.entries[0]!.name).toBe('docs')
    expect(second.truncated).toBe(false)
    expect(calls).toEqual(['list', 'list', 'continue'])
  })

  it('maps a 409 not_found body and a 429 response', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), { status: 409 })
    })
    await expect(createDropboxDriver(context()).stat('/missing')).rejects.toMatchObject({ kind: 'not_found' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      return new Response('', { status: 429 })
    })
    await expect(createDropboxDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('streams download content with Range and returns a temporary direct link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return token()
      if (url === `${RPC}/files/get_metadata`) return json(FILE)
      if (url === `${CONTENT}/files/download`) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      if (url === `${RPC}/files/get_temporary_link`) return json({ link: 'https://dl.example/a.txt' })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createDropboxDriver(context())
    expect((await driver.read('/a.txt', 'bytes=2-5')).status).toBe(206)
    expect(await driver.directLink?.('/a.txt')).toBe('https://dl.example/a.txt')
  })

  it('refreshes once on a rejected token', async () => {
    let tokenCalls = 0
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url === `${RPC}/files/list_folder`) {
        listCalls++
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization === 'Bearer stale') return new Response('', { status: 401 })
        return json({ entries: [FILE], cursor: 'c', has_more: false })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createDropboxDriver(context({ accessToken: 'stale', expiresAt: String(Date.now() + 3_600_000) }))
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(listCalls).toBe(2)
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createDropboxDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
