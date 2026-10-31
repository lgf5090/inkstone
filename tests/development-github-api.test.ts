import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubApi } from '../src/client/features/development/github/api'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function envelope(data: unknown): Response {
  return json({ ok: true, data })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function requestUrl(callIndex = 0): URL {
  return new URL(String(fetchMock.mock.calls[callIndex]![0]), 'https://inkstone.test')
}

function requestInit(callIndex = 0): RequestInit {
  return fetchMock.mock.calls[callIndex]![1] as RequestInit
}

describe('GitHub API client', () => {
  it('unwraps the bootstrap envelope', async () => {
    fetchMock.mockResolvedValueOnce(envelope({
      tags: [],
      repos: [],
      gistTags: [],
      gists: [],
      mirrors: [{ id: 'gh-proxy', name: 'gh-proxy', url: 'https://gh-proxy.com', enabled: true, createdAt: 0 }],
      accounts: [],
      capabilities: { exports: true },
    }))
    const bootstrap = await githubApi.bootstrap()
    expect(requestUrl().pathname).toBe('/api/development/github/bootstrap')
    expect(bootstrap.capabilities.exports).toBe(true)
    expect(bootstrap.mirrors[0]!.id).toBe('gh-proxy')
  })

  it('sends every search parameter', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ total: 2, items: [] }))
    const result = await githubApi.search({
      q: 'react hooks',
      range: 'month',
      sort: 'forks',
      order: 'asc',
      language: 'TypeScript',
      perPage: 25,
      page: 3,
    })
    const url = requestUrl()
    expect(url.pathname).toBe('/api/development/github/search')
    expect(url.searchParams.get('q')).toBe('react hooks')
    expect(url.searchParams.get('range')).toBe('month')
    expect(url.searchParams.get('sort')).toBe('forks')
    expect(url.searchParams.get('order')).toBe('asc')
    expect(url.searchParams.get('language')).toBe('TypeScript')
    expect(url.searchParams.get('per_page')).toBe('25')
    expect(url.searchParams.get('page')).toBe('3')
    expect(result.total).toBe(2)
  })

  it('builds repository, gist and remote list queries', async () => {
    fetchMock.mockImplementation(async () => envelope({ items: [], page: 2, perPage: 30, hasNext: false }))
    await githubApi.remoteGists('user', 'octo cat', 2)
    expect(requestUrl(0).pathname).toBe('/api/development/github/gist/users/octo%20cat/gists')
    expect(requestUrl(0).searchParams.get('page')).toBe('2')
    expect(requestUrl(0).searchParams.get('per_page')).toBe('30')

    await githubApi.remoteGists('mine', null, 1)
    expect(requestUrl(1).pathname).toBe('/api/development/github/gist/mine')

    fetchMock.mockResolvedValue(envelope({ fullName: 'acme/repo', warnings: [] }))
    await githubApi.repoDetail('acme/repo', 'release/1.0')
    expect(requestUrl(2).searchParams.get('repo')).toBe('acme/repo')
    expect(requestUrl(2).searchParams.get('defaultBranch')).toBe('release/1.0')

    fetchMock.mockResolvedValue(envelope({ id: 'abc' }))
    await githubApi.gistDetail('abc')
    expect(requestUrl(3).searchParams.get('gist')).toBe('abc')
  })

  it('sends entity writes with path ids encoded', async () => {
    fetchMock.mockResolvedValue(envelope({ tag: { id: 'tag 1' } }))
    await githubApi.upsertTag({
      id: 'tag 1',
      name: 'Team',
      color: '#64748b',
      parentId: null,
      sortOrder: 2,
      createdAt: 10,
      updatedAt: 10,
    })
    expect(requestUrl(0).pathname).toBe('/api/development/github/tags/tag%201')
    expect(requestInit(0).method).toBe('PUT')
    expect(JSON.parse(String(requestInit(0).body))).toEqual({
      name: 'Team',
      color: '#64748b',
      parentId: null,
      sortOrder: 2,
      createdAt: 10,
    })

    fetchMock.mockResolvedValueOnce(envelope({ count: 2 }))
    await githubApi.batchUpdateGists(['a', 'b'], { pinned: true, addTagIds: ['t'] })
    expect(requestUrl(1).pathname).toBe('/api/development/github/gist/gists/batch-update')
    expect(JSON.parse(String(requestInit(1).body))).toEqual({
      ids: ['a', 'b'],
      patch: { pinned: true, addTagIds: ['t'] },
    })

    fetchMock.mockResolvedValueOnce(envelope({ count: 1 }))
    await githubApi.batchUpdateRepos(['1'], { favorited: true, removeTagIds: ['t'] })
    expect(requestUrl(2).pathname).toBe('/api/development/github/repos/batch-update')
    expect(JSON.parse(String(requestInit(2).body))).toEqual({
      ids: ['1'],
      patch: { favorited: true, removeTagIds: ['t'] },
    })

    fetchMock.mockResolvedValueOnce(envelope({ count: 1 }))
    await githubApi.batchDeleteRepos(['1'])
    expect(requestUrl(3).pathname).toBe('/api/development/github/repos/batch-delete')
    expect(JSON.parse(String(requestInit(3).body))).toEqual({ ids: ['1'] })
  })

  it('probes mirrors through the server', async () => {
    fetchMock.mockResolvedValueOnce(envelope({
      results: [{ id: 'm', ok: true, status: 200, latencyMs: 42, error: '' }],
    }))
    const results = await githubApi.probeMirrors([{ id: 'm', url: 'https://mirror.example' }])
    expect(requestUrl(0).pathname).toBe('/api/development/github/mirrors/probe')
    expect(JSON.parse(String(requestInit(0).body))).toEqual({
      mirrors: [{ id: 'm', url: 'https://mirror.example' }],
    })
    expect(results).toEqual([{ id: 'm', ok: true, status: 200, latencyMs: 42, error: '' }])
  })

  it('adds an account without requiring the token in the response', async () => {
    fetchMock.mockResolvedValueOnce(envelope({
      account: { id: 'a1', username: 'octo', avatarUrl: '', createdAt: 1, updatedAt: 1 },
    }))
    const account = await githubApi.addAccount('ghp_secret')
    expect(account.username).toBe('octo')
    expect(JSON.parse(String(requestInit(0).body))).toEqual({ token: 'ghp_secret' })
    expect(JSON.stringify(account)).not.toContain('ghp_secret')
  })

  it('creates exports and exposes a download URL', async () => {
    fetchMock.mockResolvedValueOnce(envelope({
      export: { id: 'e 1', filename: 'x.md', format: 'md', size: 2, url: '/x', createdAt: 1 },
    }))
    const created = await githubApi.createExport('gist/1', 'md')
    expect(requestUrl(0).pathname).toBe('/api/development/github/gists/gist%2F1/exports')
    expect(JSON.parse(String(requestInit(0).body))).toEqual({ format: 'md' })
    expect(created.format).toBe('md')
    expect(githubApi.exportUrl('e 1')).toBe('/api/development/github/exports/e%201')
  })

  it('throws ApiError with the server code and status', async () => {
    fetchMock.mockResolvedValueOnce(json({
      error: { code: 'github_rate_limited', message: 'slow down' },
    }, 429))
    await expect(githubApi.search({
      q: '',
      range: 'today',
      sort: 'stars',
      order: 'desc',
      language: '',
      perPage: 25,
      page: 1,
    })).rejects.toMatchObject({ status: 429, code: 'github_rate_limited' })
  })
})
