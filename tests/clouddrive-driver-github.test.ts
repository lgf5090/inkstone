// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitHubDriver } from '../src/worker/clouddrive/drivers/github'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { token: 'pat', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-gh',
    type: 'github',
    config: { repo: 'owner/repo', branch: 'main' },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const API = 'https://api.github.com'
const REPO = `${API}/repos/owner/repo`
const CONTENTS = `${REPO}/contents`
const FILE = {
  name: 'a.txt',
  path: 'a.txt',
  sha: 's1',
  size: 10,
  type: 'file',
  download_url: 'https://raw.githubusercontent.com/owner/repo/main/a.txt',
}
const FOLDER = { name: 'docs', path: 'docs', sha: 's2', type: 'dir', download_url: null }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GitHub driver', () => {
  it('returns the requested page and its cursor from the directory listing', async () => {
    const contentCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === REPO) return json({ default_branch: 'main' })
      if (url.startsWith(CONTENTS)) {
        contentCalls.push(url)
        return json([FILE, FOLDER])
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGitHubDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(first.cursor).toBe('1')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 1 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(contentCalls).toHaveLength(2)
  })

  it('maps a rejected token to auth and marks the storage', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === REPO) return json({})
      return new Response('', { status: 401 })
    })
    const ctx = context()
    await expect(createGitHubDriver(ctx).list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markNeedsReauth).toHaveBeenCalled()
  })

  it('maps 429 to rate_limit and 404 to not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === REPO) return json({})
      return new Response('', { status: 429 })
    })
    await expect(createGitHubDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === REPO) return json({})
      return json({ message: 'not found' }, 404)
    })
    await expect(createGitHubDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('reads raw content with Range and returns the download_url as a direct link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === REPO) return json({})
      if (url.startsWith(`${CONTENTS}/a.txt`)) {
        const accept = new Headers(init?.headers).get('Accept')
        if (accept === 'application/vnd.github.raw') {
          expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
          return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
        }
        return json(FILE)
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGitHubDriver(context())
    expect(await driver.directLink!('/a.txt')).toBe(FILE.download_url)
    expect((await driver.read('/a.txt', 'bytes=2-5')).status).toBe(206)
    expect(driver.capabilities.directLink).toBe(true)
    expect(driver.capabilities.mkdir).toBe(false)
  })

  it('uploads with a base64 body and the branch through the Contents API', async () => {
    let putBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === REPO) return json({})
      if (url.startsWith(`${CONTENTS}/a.txt`)) {
        if (init?.method === 'GET') return json({ message: 'not found' }, 404)
        if (init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body)) as Record<string, unknown>
          return json({ content: { sha: 'new' } }, 201)
        }
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createGitHubDriver(context())
    const bytes = new TextEncoder().encode('hello')
    await driver.upload('/a.txt', bytes, { size: bytes.byteLength })
    expect(putBody).not.toBeNull()
    expect(putBody!.content).toBe('aGVsbG8=')
    expect(putBody!.branch).toBe('main')
    expect(putBody!.sha).toBeUndefined()
  })

  it('rejects an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createGitHubDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
