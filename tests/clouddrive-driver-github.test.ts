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

type GitTreeEntry = { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string | null }

/** A tiny Git Data API state machine: trees by sha, an immutable branch head and failed ref moves. */
function gitFixture(state: {
  head?: string
  root: string
  trees: Record<string, GitTreeEntry[]>
  refFailures?: number[]
}) {
  const treePosts: Array<Record<string, unknown>> = []
  const commitPosts: Array<Record<string, unknown>> = []
  let refCalls = 0
  const failures = [...(state.refFailures ?? [])]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === `${REPO}/branches/main` && method === 'GET') {
      return json({ commit: { sha: state.head ?? 'c1' } })
    }
    if (url === `${REPO}/git/commits/${state.head ?? 'c1'}` && method === 'GET') {
      return json({ tree: { sha: state.root } })
    }
    if (url === `${REPO}/git/trees` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      treePosts.push(body)
      return json({ sha: `new-tree-${treePosts.length}` }, 201)
    }
    if (url === `${REPO}/git/commits` && method === 'POST') {
      commitPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return json({ sha: `new-commit-${commitPosts.length}` }, 201)
    }
    if (url === `${REPO}/git/refs/heads/main` && method === 'PATCH') {
      refCalls++
      const failure = failures.shift()
      if (failure) return json({ message: 'stale base' }, failure)
      return json({ ref: 'refs/heads/main' })
    }
    if (url.startsWith(`${REPO}/git/trees/`) && method === 'GET') {
      const sha = url.slice(`${REPO}/git/trees/`.length)
      const tree = state.trees[sha]
      if (!tree) return json({ message: 'not found' }, 404)
      return json({ sha, tree })
    }
    throw new Error(`unexpected ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, treePosts, commitPosts, get refCalls() { return refCalls } }
}

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
    expect(driver.capabilities.mkdir).toBe(true)
    expect(driver.capabilities.copy).toBe(true)
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

  it('creates a folder with an empty Git tree and one commit', async () => {
    const fixture = gitFixture({ root: 'root-tree', trees: { 'root-tree': [] } })
    await createGitHubDriver(context()).mkdir('/docs')
    expect(fixture.treePosts).toHaveLength(2)
    expect(fixture.treePosts[0]).toEqual({
      tree: [{ path: '.gitkeep', mode: '100644', type: 'blob', content: '' }],
    })
    expect(fixture.treePosts[1]).toEqual({
      base_tree: 'root-tree',
      tree: [{ path: 'docs', mode: '040000', type: 'tree', sha: 'new-tree-1' }],
    })
    expect(fixture.commitPosts[0]).toMatchObject({ tree: 'new-tree-2', parents: ['c1'] })
    expect(fixture.refCalls).toBe(1)
  })

  it('drops a parent .gitkeep when the first real entry lands', async () => {
    const fixture = gitFixture({
      root: 'root-tree',
      trees: { 'root-tree': [{ path: '.gitkeep', mode: '100644', type: 'blob', sha: 'keep' }] },
    })
    await createGitHubDriver(context()).mkdir('/docs')
    expect(fixture.treePosts[1]!.tree).toEqual(expect.arrayContaining([
      { path: 'docs', mode: '040000', type: 'tree', sha: 'new-tree-1' },
      { path: '.gitkeep', mode: '100644', type: 'blob', sha: null },
    ]))
  })

  it('renames in place by reusing the blob sha in the parent tree', async () => {
    const fixture = gitFixture({
      root: 'root-tree',
      trees: {
        'root-tree': [
          { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a' },
          { path: 'docs', mode: '040000', type: 'tree', sha: 'docs-tree' },
        ],
        'docs-tree': [],
      },
    })
    await createGitHubDriver(context()).rename('/a.txt', 'b.txt')
    expect(fixture.treePosts).toHaveLength(1)
    expect(fixture.treePosts[0]).toEqual({
      base_tree: 'root-tree',
      tree: [
        { path: 'a.txt', mode: '100644', type: 'blob', sha: null },
        { path: 'b.txt', mode: '100644', type: 'blob', sha: 'blob-a' },
      ],
    })
    expect(fixture.commitPosts).toHaveLength(1)
    expect(fixture.refCalls).toBe(1)
  })

  it('moves across directories by rewriting both parents and the root tree once', async () => {
    const fixture = gitFixture({
      root: 'root-tree',
      trees: {
        'root-tree': [
          { path: 'docs', mode: '040000', type: 'tree', sha: 'docs-tree' },
          { path: 'archive', mode: '040000', type: 'tree', sha: 'archive-tree' },
        ],
        'docs-tree': [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a' }],
        'archive-tree': [{ path: '.gitkeep', mode: '100644', type: 'blob', sha: 'keep' }],
      },
    })
    await createGitHubDriver(context()).move('/docs/a.txt', '/archive/b.txt')
    expect(fixture.treePosts).toHaveLength(3)
    const source = fixture.treePosts.find((post) => post.base_tree === 'docs-tree')!
    expect(source.tree).toEqual([
      { path: 'a.txt', mode: '100644', type: 'blob', sha: null },
      { path: '.gitkeep', mode: '100644', type: 'blob', content: '' },
    ])
    const destination = fixture.treePosts.find((post) => post.base_tree === 'archive-tree')!
    expect(destination.tree).toEqual([
      { path: 'b.txt', mode: '100644', type: 'blob', sha: 'blob-a' },
      { path: '.gitkeep', mode: '100644', type: 'blob', sha: null },
    ])
    const root = fixture.treePosts.find((post) => post.base_tree === 'root-tree')!
    expect(root.tree).toEqual([
      { path: 'docs', mode: '040000', type: 'tree', sha: 'new-tree-1' },
      { path: 'archive', mode: '040000', type: 'tree', sha: 'new-tree-2' },
    ])
    expect(fixture.commitPosts).toHaveLength(1)
    expect(fixture.refCalls).toBe(1)
  })

  it('copies by referencing the source object without touching its tree', async () => {
    const fixture = gitFixture({
      root: 'root-tree',
      trees: {
        'root-tree': [
          { path: 'docs', mode: '040000', type: 'tree', sha: 'docs-tree' },
          { path: 'archive', mode: '040000', type: 'tree', sha: 'archive-tree' },
        ],
        'docs-tree': [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a' }],
        'archive-tree': [{ path: '.gitkeep', mode: '100644', type: 'blob', sha: 'keep' }],
      },
    })
    await createGitHubDriver(context()).copy!('/docs/a.txt', '/archive/a.txt')
    expect(fixture.treePosts).toHaveLength(2)
    expect(fixture.treePosts.some((post) => post.base_tree === 'docs-tree')).toBe(false)
    const destination = fixture.treePosts.find((post) => post.base_tree === 'archive-tree')!
    expect(destination.tree).toEqual([
      { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a' },
      { path: '.gitkeep', mode: '100644', type: 'blob', sha: null },
    ])
    const root = fixture.treePosts.find((post) => post.base_tree === 'root-tree')!
    // base_tree preserves the untouched docs entry; only the changed archive entry is sent.
    expect(root.tree).toEqual([
      { path: 'archive', mode: '040000', type: 'tree', sha: 'new-tree-1' },
    ])
    expect(fixture.commitPosts).toHaveLength(1)
    expect(fixture.refCalls).toBe(1)
  })

  it('removes an entry with one tree update and one commit', async () => {
    const fixture = gitFixture({
      root: 'root-tree',
      trees: {
        'root-tree': [
          { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a' },
          { path: 'docs', mode: '040000', type: 'tree', sha: 'docs-tree' },
        ],
        'docs-tree': [],
      },
    })
    await createGitHubDriver(context()).remove('/a.txt')
    expect(fixture.treePosts).toHaveLength(1)
    expect(fixture.treePosts[0]).toEqual({
      base_tree: 'root-tree',
      tree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: null }],
    })
    expect(fixture.commitPosts).toHaveLength(1)
    expect(fixture.refCalls).toBe(1)
  })

  it('re-reads the head and retries when a ref update is answered with 409 or 422', async () => {
    for (const status of [409, 422]) {
      const fixture = gitFixture({
        root: 'root-tree',
        trees: {
          'root-tree': [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-a' }],
        },
        refFailures: [status],
      })
      await createGitHubDriver(context()).rename('/a.txt', 'b.txt')
      expect(fixture.treePosts).toHaveLength(2)
      expect(fixture.commitPosts).toHaveLength(2)
      expect(fixture.refCalls).toBe(2)
      expect(fixture.treePosts[1]).toMatchObject({ base_tree: 'root-tree' })
    }
  })
})
