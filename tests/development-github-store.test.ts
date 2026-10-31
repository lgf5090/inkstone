import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GithubBootstrap,
  GithubTag,
  SavedGist,
  SavedGithubRepo,
} from '@shared/development/github/types'
import { useGithubStore } from '../src/client/features/development/github/store'
import { useUi } from '../src/client/store/ui'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function envelope(data: unknown): Response {
  return json({ ok: true, data })
}

function tag(id: string, parentId: string | null = null): GithubTag {
  return { id, name: id, color: '#64748b', parentId, sortOrder: 0, createdAt: 1, updatedAt: 1 }
}

function account(id: string) {
  return { id, username: id, avatarUrl: '', createdAt: 1, updatedAt: 1 }
}

function repo(id: string, tagIds: string[] = []): SavedGithubRepo {
  return {
    id,
    fullName: `acme/${id}`,
    url: `https://github.com/acme/${id}`,
    data: {
      id: 1,
      name: id,
      fullName: `acme/${id}`,
      url: `https://github.com/acme/${id}`,
      description: null,
      homepage: null,
      owner: { login: 'acme', avatarUrl: '' },
      language: null,
      stargazersCount: 0,
      forksCount: 0,
      openIssuesCount: 0,
      topics: [],
      license: null,
      isArchived: false,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
      defaultBranch: 'main',
      size: 0,
    },
    tagIds,
    pinned: false,
    favorited: false,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

function gist(id: string): SavedGist {
  return {
    id,
    description: id,
    url: `https://gist.github.com/acme/${id}`,
    data: {
      id,
      description: id,
      url: `https://gist.github.com/acme/${id}`,
      isPublic: true,
      owner: { login: 'acme', avatarUrl: '' },
      files: [{ filename: 'a.txt', language: 'Text', content: 'a', size: 1 }],
      fileCount: 1,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    },
    tagIds: [],
    pinned: false,
    favorited: false,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

const BOOTSTRAP: GithubBootstrap = {
  tags: [],
  repos: [],
  gistTags: [],
  gists: [],
  mirrors: [],
  accounts: [],
  capabilities: { exports: true },
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  useGithubStore.setState({
    status: 'idle',
    error: null,
    tags: [],
    repos: [],
    gistTags: [],
    gists: [],
    mirrors: [],
    accounts: [],
    activeAccountId: null,
    capabilities: { exports: false },
  })
  useUi.setState({ toasts: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub store bootstrap', () => {
  it('loads one bootstrap payload into every collection', async () => {
    fetchMock.mockResolvedValueOnce(envelope({
      ...BOOTSTRAP,
      tags: [tag('t1')],
      repos: [repo('r1', ['t1'])],
      capabilities: { exports: true },
    }))
    await useGithubStore.getState().load()
    const state = useGithubStore.getState()
    expect(state.status).toBe('ready')
    expect(state.tags).toHaveLength(1)
    expect(state.repos[0]!.tagIds).toEqual(['t1'])
    expect(state.capabilities.exports).toBe(true)
    expect(state.error).toBeNull()
  })

  it('defaults exports to false and exposes a retryable error', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ ...BOOTSTRAP, capabilities: undefined }))
    await useGithubStore.getState().load()
    expect(useGithubStore.getState().capabilities.exports).toBe(false)

    useGithubStore.setState({ status: 'idle' })
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'github_upstream', message: 'down' } }, 502))
    await useGithubStore.getState().load()
    expect(useGithubStore.getState().status).toBe('error')
    expect(useGithubStore.getState().error).toBeTruthy()
  })

  it('refreshes collections without dropping back to loading', async () => {
    useGithubStore.setState({ status: 'ready', repos: [repo('old')] })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fetchMock.mockImplementation(async () => {
      await gate
      return envelope({ ...BOOTSTRAP, repos: [repo('new')] })
    })
    const pending = useGithubStore.getState().refresh()
    await Promise.resolve()
    expect(useGithubStore.getState().status).toBe('ready')
    release()
    await pending
    expect(useGithubStore.getState().status).toBe('ready')
    expect(useGithubStore.getState().repos.map((entry) => entry.id)).toEqual(['new'])
  })

  it('keeps a valid active account and falls back to the first', async () => {
    useGithubStore.setState({ status: 'ready', activeAccountId: 'a2' })
    fetchMock.mockResolvedValueOnce(envelope({
      ...BOOTSTRAP,
      accounts: [account('a1'), account('a2')],
    }))
    await useGithubStore.getState().refresh()
    expect(useGithubStore.getState().activeAccountId).toBe('a2')

    fetchMock.mockResolvedValueOnce(envelope({ ...BOOTSTRAP, accounts: [account('a1')] }))
    await useGithubStore.getState().refresh()
    expect(useGithubStore.getState().activeAccountId).toBe('a1')
  })
})

describe('GitHub store optimistic writes', () => {
  it('applies a tag before the request settles', async () => {
    useGithubStore.setState({ status: 'ready' })
    fetchMock.mockResolvedValueOnce(envelope({ tag: tag('t1') }))
    const pending = useGithubStore.getState().upsertTag(tag('t1'))
    expect(useGithubStore.getState().tags.map((entry) => entry.id)).toEqual(['t1'])
    await pending
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/development/github/tags/t1')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('PUT')
  })

  it('removes a tag subtree and unbinds it from repositories', async () => {
    useGithubStore.setState({
      status: 'ready',
      tags: [tag('parent'), tag('child', 'parent')],
      repos: [repo('r1', ['parent', 'child'])],
    })
    fetchMock.mockResolvedValueOnce(envelope({ removedTagIds: ['parent', 'child'], updatedRepoIds: ['r1'] }))
    const pending = useGithubStore.getState().deleteTag('parent')
    expect(useGithubStore.getState().tags).toEqual([])
    expect(useGithubStore.getState().repos[0]!.tagIds).toEqual([])
    await pending
  })

  it('reconciles a failed write with the server collection', async () => {
    useGithubStore.setState({ status: 'ready', tags: [tag('old')] })
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (init?.method === 'PUT') return json({ error: { code: 'github_upstream', message: 'down' } }, 502)
      if (path.endsWith('/tags')) return envelope({ tags: [tag('server')] })
      return json({ error: { code: 'not_found', message: 'missing' } }, 404)
    })
    await useGithubStore.getState().upsertTag(tag('new'))
    expect(useGithubStore.getState().tags.map((entry) => entry.id)).toEqual(['server'])
    const toasts = useUi.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.tone).toBe('danger')
  })

  it('serializes writes to the same collection', async () => {
    useGithubStore.setState({ status: 'ready' })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    let maximum = 0
    fetchMock.mockImplementation(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await gate
      active -= 1
      return envelope({ tag: tag('t') })
    })
    const first = useGithubStore.getState().upsertTag(tag('a'))
    const second = useGithubStore.getState().upsertTag({ ...tag('a'), name: 'renamed' })
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(maximum).toBe(1)
  })

  it('patches gists optimistically in a batch', async () => {
    useGithubStore.setState({ status: 'ready', gists: [gist('a'), gist('b')] })
    fetchMock.mockResolvedValueOnce(envelope({ count: 1 }))
    const pending = useGithubStore.getState().batchUpdateGists(['a'], {
      pinned: true,
      favorited: true,
      addTagIds: ['t1'],
    })
    const updated = useGithubStore.getState().gists[0]!
    expect(updated).toMatchObject({ pinned: true, favorited: true, tagIds: ['t1'] })
    expect(useGithubStore.getState().gists[1]!.pinned).toBe(false)
    await pending
  })

  it('patches gist metadata without sending file content', async () => {
    useGithubStore.setState({ status: 'ready', gists: [gist('a')] })
    fetchMock.mockResolvedValueOnce(envelope({ gist: { ...gist('a'), pinned: true } }))
    const pending = useGithubStore.getState().patchGist('a', { pinned: true })
    expect(useGithubStore.getState().gists[0]!.pinned).toBe(true)
    await pending
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('PATCH')
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/development/github/gist/gists/a')
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ pinned: true })
  })

  it('removes a saved repository optimistically', async () => {
    useGithubStore.setState({ status: 'ready', repos: [repo('r1')] })
    fetchMock.mockResolvedValueOnce(envelope({ ok: true }))
    const pending = useGithubStore.getState().deleteRepo('r1')
    expect(useGithubStore.getState().repos).toEqual([])
    await pending
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/development/github/repos/r1')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE')
  })

  it('saves mirrors and accounts in the store', async () => {
    useGithubStore.setState({ status: 'ready' })
    fetchMock.mockResolvedValueOnce(envelope({
      mirrors: [{ id: 'm1', name: 'm1', url: 'https://m1.example.com', enabled: true, createdAt: 1 }],
    }))
    await useGithubStore.getState().saveMirrors([
      { id: 'm1', name: 'm1', url: 'https://m1.example.com', enabled: true, createdAt: 1 },
    ])
    expect(useGithubStore.getState().mirrors[0]!.id).toBe('m1')

    fetchMock.mockResolvedValueOnce(envelope({
      account: { id: 'a1', username: 'octo', avatarUrl: '', createdAt: 1, updatedAt: 1 },
    }))
    await useGithubStore.getState().addAccount(' ghp_secret ')
    expect(useGithubStore.getState().accounts).toHaveLength(1)
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ token: 'ghp_secret' })
    expect(JSON.stringify(useGithubStore.getState().accounts)).not.toContain('ghp_secret')
  })
})
