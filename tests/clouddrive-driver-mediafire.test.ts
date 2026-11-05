// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMediaFireDriver } from '../src/worker/clouddrive/drivers/mediafire'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { cookie: 'session=abc', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-mf',
    type: 'mediafire',
    config: { chunkSize: 2 },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const HOST = 'https://www.mediafire.com'
const TOKEN_URL = `${HOST}/application/get_session_token.php`
const API = `${HOST}/api/1.5`
const CONTENT = `${API}/folder/get_content.php`
const LINKS = `${API}/file/get_links.php`
const FILE = { quickkey: 'q1', filename: 'a.txt', size: '10', created: '2026-01-01T00:00:00Z' }
const FOLDER = { folderkey: 'f1', name: 'docs', created: '2026-01-02T00:00:00Z' }

function form(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(init?.body ? String(init.body) : '')
}

function sessionToken(): Response {
  return json({ response: { session_token: 's1', result: 'Success' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MediaFire driver', () => {
  it('walks chunk pages and returns the requested page with its cursor', async () => {
    const contentCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return sessionToken()
      if (url === CONTENT) {
        const body = form(init)
        const contentType = body.get('content_type')
        const chunk = body.get('chunk')
        contentCalls.push(`${contentType}:${chunk}`)
        if (chunk === '2') {
          return contentType === 'folders'
            ? json({ response: { folder_content: { folders: [FOLDER], more_chunks: 'no' } } })
            : json({ response: { folder_content: { files: [], more_chunks: 'no' } } })
        }
        return contentType === 'folders'
          ? json({ response: { folder_content: { folders: [], more_chunks: 'no' } } })
          : json({ response: { folder_content: { files: [FILE], more_chunks: 'yes' } } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createMediaFireDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(contentCalls).toHaveLength(4)
  })

  it('maps a refused cookie exchange to auth and marks the storage', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return new Response('', { status: 401 })
      throw new Error(`unexpected ${url}`)
    })
    const ctx = context()
    await expect(createMediaFireDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markNeedsReauth).toHaveBeenCalled()
  })

  it('maps 429 to rate_limit and 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return sessionToken()
      return new Response('', { status: 429 })
    })
    await expect(createMediaFireDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) return sessionToken()
      if (url === CONTENT) return json({ response: { result: 'not found' } }, 404)
      throw new Error(`unexpected ${url}`)
    })
    await expect(createMediaFireDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('streams a direct download URL with Range and exposes it as a direct link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return sessionToken()
      if (url === CONTENT) {
        const contentType = form(init).get('content_type')
        return contentType === 'folders'
          ? json({ response: { folder_content: { folders: [], more_chunks: 'no' } } })
          : json({ response: { folder_content: { files: [FILE], more_chunks: 'no' } } })
      }
      if (url === LINKS) {
        return json({ response: { result: 'Success', links: [{ direct_download: 'https://dl.example/a.txt' }] } })
      }
      if (url === 'https://dl.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createMediaFireDriver(context())
    expect(await driver.directLink!('/a.txt')).toBe('https://dl.example/a.txt')
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
    expect(driver.capabilities.directLink).toBe(true)
    expect(driver.capabilities.write).toBe(false)
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createMediaFireDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
