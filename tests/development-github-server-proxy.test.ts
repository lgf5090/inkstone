// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGithubGist,
  deleteGithubGist,
  fetchGistDetail,
  gistFilesPayload,
  listGithubGists,
  normalizeGist,
  normalizeGistFilesPatch,
  updateGithubGist,
} from '../src/worker/development/github/github-gists'
import { githubJson } from '../src/worker/development/github/github-http'
import {
  buildSearchQuery,
  fetchRepoDetail,
  fetchStarredRepos,
  normalizeRepo,
  parseRepoFullName,
  searchRepositories,
} from '../src/worker/development/github/github-repos'
import {
  MAX_GIST_FILE_BYTES,
  MAX_GITHUB_TEXT_BYTES,
} from '../src/shared/development/github/limits'
import type { GithubSearchParams } from '../src/shared/development/github/types'

interface FetchCall {
  url: string
  init?: RequestInit
}

let calls: FetchCall[] = []

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return await handler(url, init)
    }),
  )
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers as Record<string, string> | undefined) ?? {}
}

function params(): GithubSearchParams {
  return {
    q: 'react',
    range: 'week',
    sort: 'stars',
    order: 'desc',
    language: 'TypeScript',
    perPage: 25,
    page: 2,
  }
}

function expectThrows(fn: () => unknown, status: number): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('development github repository proxy', () => {
  it('composes the search query with range, language and fork filters', () => {
    const now = new Date('2026-10-20T00:00:00Z')
    expect(buildSearchQuery(params(), now)).toBe(
      'react created:>=2026-10-13 language:TypeScript fork:false',
    )
    expect(buildSearchQuery({ ...params(), q: '', range: 'all', language: '' }, now)).toBe(
      'fork:false archived:false',
    )
    expect(buildSearchQuery({ ...params(), q: 'react', range: 'all' }, now)).toBe(
      'react language:TypeScript fork:false',
    )
  })

  it('sends the documented search parameters and normalizes the results', async () => {
    stubFetch(() =>
      jsonResponse({
        total_count: 42,
        items: [
          {
            id: 7,
            name: 'react',
            full_name: 'facebook/react',
            html_url: 'https://github.com/facebook/react',
            description: 'A library',
            homepage: null,
            owner: { login: 'facebook', avatar_url: 'https://avatar/facebook' },
            language: 'JavaScript',
            stargazers_count: 100,
            forks_count: 20,
            open_issues_count: 3,
            topics: ['ui', 'library'],
            license: { spdx_id: 'MIT', name: 'MIT License' },
            archived: false,
            created_at: '2013-05-24T16:15:54Z',
            updated_at: '2026-01-01T00:00:00Z',
            default_branch: 'main',
            size: 1000,
            watchers_count: 999,
          },
        ],
      }),
    )
    const result = await searchRepositories({ ...params(), sort: 'best-match', order: 'asc' }, 'tok')
    expect(result.total).toBe(42)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: 7,
      fullName: 'facebook/react',
      owner: { login: 'facebook', avatarUrl: 'https://avatar/facebook' },
      license: 'MIT',
      topics: ['ui', 'library'],
      defaultBranch: 'main',
    })
    expect('watchersCount' in result.items[0]!).toBe(false)
    expect('languagesUrl' in result.items[0]!).toBe(false)

    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.github.com/search/repositories')
    expect(url.searchParams.get('q')).toContain('fork:false')
    expect(url.searchParams.get('q')).toContain('language:TypeScript')
    expect(url.searchParams.get('sort')).toBeNull()
    expect(url.searchParams.get('order')).toBe('asc')
    expect(url.searchParams.get('per_page')).toBe('25')
    expect(url.searchParams.get('page')).toBe('2')
    expect(headersOf(calls[0]!)).toMatchObject({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'inkstone-GitHub/1.0',
      Authorization: 'Bearer tok',
    })
  })

  it('parses owner/name and rejects malformed repository names', () => {
    expect(parseRepoFullName('facebook/react')).toEqual({ owner: 'facebook', name: 'react' })
    expect(parseRepoFullName('a/b/c')).toBeNull()
    expect(parseRepoFullName('-bad/name')).toBeNull()
    expect(parseRepoFullName('../name')).toBeNull()
    expect(parseRepoFullName('owner/..')).toBeNull()
  })

  it('normalizes missing repository fields to safe defaults', () => {
    const repo = normalizeRepo({})
    expect(repo.defaultBranch).toBe('main')
    expect(repo.topics).toEqual([])
    expect(repo.owner).toEqual({ login: '', avatarUrl: '' })
    expect(repo.stargazersCount).toBe(0)
  })

  it('fetches the five detail sources in parallel and reports truncation', async () => {
    stubFetch((url) => {
      if (url.endsWith('/branches?per_page=100')) {
        return jsonResponse(Array.from({ length: 100 }, (_, index) => ({ name: `b${index}` })))
      }
      if (url.endsWith('/tags?per_page=100')) {
        return jsonResponse(Array.from({ length: 100 }, (_, index) => ({ name: `t${index}` })))
      }
      if (url.endsWith('/languages')) return jsonResponse({ TypeScript: 750, CSS: 250 })
      if (url.endsWith('/releases?per_page=30')) {
        return jsonResponse(
          Array.from({ length: 30 }, (_, index) => ({
            id: index + 1,
            tag_name: `v${index}`,
            name: `Release ${index}`,
            prerelease: false,
            published_at: '2026-01-01T00:00:00Z',
            html_url: `https://github.com/owner/name/releases/${index}`,
            body: 'notes',
            assets: [
              {
                id: 1,
                name: 'asset.zip',
                label: null,
                content_type: 'application/zip',
                size: 10,
                browser_download_url: 'https://example/asset.zip',
              },
            ],
          })),
        )
      }
      return new Response('# Readme', { status: 200 })
    })
    const detail = await fetchRepoDetail('owner/name', undefined, 'tok')
    expect(calls).toHaveLength(5)
    expect(detail.fullName).toBe('owner/name')
    expect(detail.branchesCount).toBe(100)
    expect(detail.branchesTruncated).toBe(true)
    expect(detail.tagsCount).toBe(100)
    expect(detail.tagsTruncated).toBe(true)
    expect(detail.releasesTruncated).toBe(true)
    expect(detail.releases[0]?.isLatest).toBe(true)
    expect(detail.releases[0]?.assets[0]).not.toHaveProperty('apiUrl')
    expect(detail.languages).toEqual([
      { name: 'TypeScript', bytes: 750, percentage: 75 },
      { name: 'CSS', bytes: 250, percentage: 25 },
    ])
    expect(detail.readme).toBe('# Readme')
    expect(detail.readmeHtmlUrl).toBe('https://github.com/owner/name#readme')
    expect(detail.warnings).toEqual([])
    expect(detail.rateLimited).toBe(false)
    expect(headersOf(calls[4]!)).toMatchObject({ Accept: 'application/vnd.github.raw+json' })
  })

  it('keeps detail usable when one source fails and reports a structured warning', async () => {
    stubFetch((url) => {
      if (url.endsWith('/branches?per_page=100')) {
        return jsonResponse({ message: 'rate' }, 403, { 'x-ratelimit-remaining': '0' })
      }
      if (url.endsWith('/tags?per_page=100')) return jsonResponse([])
      if (url.endsWith('/languages')) return jsonResponse({ Go: 100 })
      if (url.endsWith('/releases?per_page=30')) return jsonResponse([], 500)
      return jsonResponse({ message: 'Not Found' }, 404)
    })
    const detail = await fetchRepoDetail('owner/name', 'trunk', 'tok')
    expect(detail.defaultBranch).toBe('trunk')
    expect(detail.rateLimited).toBe(true)
    expect(detail.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'branches', code: 'rate_limited' }),
        expect.objectContaining({ source: 'releases', code: 'upstream' }),
        expect.objectContaining({ source: 'readme', code: 'not_found' }),
      ]),
    )
    expect(detail.branchesCount).toBe(0)
    expect(detail.languages).toEqual([{ name: 'Go', bytes: 100, percentage: 100 }])
    expect(detail.readme).toBeNull()
  })

  it('fails the whole detail when every source rejects the token', async () => {
    stubFetch(() => jsonResponse({ message: 'bad credentials' }, 401))
    await expect(fetchRepoDetail('owner/name', undefined, 'bad')).rejects.toMatchObject({
      status: 400,
      code: 'github_token_invalid',
    })
  })
})

describe('development github gist proxy', () => {
  function gistRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'abcdef12',
      description: 'A gist',
      html_url: 'https://gist.github.com/abcdef12',
      public: true,
      owner: { login: 'octocat', avatar_url: 'https://avatar/octocat' },
      files: {
        'a.txt': { filename: 'a.txt', language: null, content: 'hello', size: 5 },
      },
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      ...overrides,
    }
  }

  it('normalizes gist files and missing fields', () => {
    const gist = normalizeGist(gistRaw())
    expect(gist).toMatchObject({
      id: 'abcdef12',
      description: 'A gist',
      isPublic: true,
      owner: { login: 'octocat', avatarUrl: 'https://avatar/octocat' },
      files: [{ filename: 'a.txt', language: null, content: 'hello', size: 5 }],
      fileCount: 1,
    })
    expect(normalizeGist({}).owner).toBeNull()
    expect(normalizeGist({}).files).toEqual([])
    expect(normalizeGist({ public: false }).isPublic).toBe(false)
  })

  it('lists public gists with a next-page hint', async () => {
    stubFetch(() =>
      jsonResponse([gistRaw()], 200, {
        link: '<https://api.github.com/gists/public?page=2>; rel="next"',
      }),
    )
    const result = await listGithubGists('public', { page: 1, perPage: 30, token: 'tok' })
    expect(result).toEqual({
      items: [expect.objectContaining({ id: 'abcdef12' })],
      page: 1,
      perPage: 30,
      hasNext: true,
    })
    expect(new URL(calls[0]!.url).pathname).toBe('/gists/public')
    expect(headersOf(calls[0]!).Authorization).toBe('Bearer tok')
  })

  it('requires an account token for my gists', async () => {
    stubFetch(() => jsonResponse([]))
    await expect(listGithubGists('mine', { page: 1, perPage: 30 })).rejects.toMatchObject({
      status: 400,
      code: 'github_token_required',
    })
    expect(calls).toHaveLength(0)
  })

  it('uses the account token for a user list and the fallback token otherwise', async () => {
    stubFetch(() => jsonResponse([gistRaw()]))
    await listGithubGists('user', {
      page: 2,
      perPage: 30,
      username: 'octocat',
      token: 'account-token',
      fallbackToken: 'rate-token',
    })
    expect(new URL(calls[0]!.url).pathname).toBe('/gists')
    expect(headersOf(calls[0]!).Authorization).toBe('Bearer account-token')

    await listGithubGists('user', {
      page: 1,
      perPage: 30,
      username: 'octocat',
      token: null,
      fallbackToken: 'rate-token',
    })
    expect(new URL(calls[1]!.url).pathname).toBe('/users/octocat/gists')
    expect(headersOf(calls[1]!).Authorization).toBe('Bearer rate-token')
  })

  it('validates a user list username', async () => {
    stubFetch(() => jsonResponse([]))
    await expect(
      listGithubGists('user', { page: 1, perPage: 30, username: 'bad name' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('fetches gist detail with the file contents', async () => {
    stubFetch(() => jsonResponse(gistRaw()))
    const gist = await fetchGistDetail('abcdef12', 'tok')
    expect(gist.files[0]?.content).toBe('hello')
    expect(new URL(calls[0]!.url).pathname).toBe('/gists/abcdef12')
  })

  it('creates a gist and validates the files payload', async () => {
    stubFetch(() => jsonResponse(gistRaw()))
    await createGithubGist(
      {
        description: 'Created',
        isPublic: false,
        files: [{ filename: ' b.txt ', content: 'hi' }],
      },
      'tok',
    )
    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      description: string
      public: boolean
      files: Record<string, { content: string }>
    }
    expect(calls[0]!.init?.method).toBe('POST')
    expect(body.description).toBe('Created')
    expect(body.public).toBe(false)
    expect(body.files).toEqual({ 'b.txt': { content: 'hi' } })

    expectThrows(() => gistFilesPayload([]), 400)
    expectThrows(
      () =>
        gistFilesPayload([
          { filename: 'a.txt', content: '1' },
          { filename: 'a.txt', content: '2' },
        ]),
      400,
    )
    expectThrows(() => gistFilesPayload([{ filename: 'a/b.txt', content: '1' }]), 400)
    expectThrows(
      () => gistFilesPayload([{ filename: 'a.txt', content: 'é'.repeat(MAX_GIST_FILE_BYTES) }]),
      413,
    )
    expectThrows(
      () =>
        gistFilesPayload([
          { filename: 'a.txt', content: 'x'.repeat(400 * 1024) },
          { filename: 'b.txt', content: 'x'.repeat(400 * 1024) },
        ]),
      413,
    )
  })

  it('updates only the named fields and deletes by id', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return jsonResponse(gistRaw({ description: 'Updated' }))
    })
    const updated = await updateGithubGist('abcdef12', { description: 'Updated' }, 'tok')
    expect(updated.description).toBe('Updated')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ description: 'Updated' })
    expect(calls[0]!.init?.method).toBe('PATCH')

    await deleteGithubGist('abcdef12', 'tok')
    expect(calls[1]!.init?.method).toBe('DELETE')

    await expect(updateGithubGist('abcdef12', {}, 'tok')).rejects.toMatchObject({ status: 400 })

    expect(normalizeGistFilesPatch({ 'a.txt': null, 'b.txt': { content: 'hi' } })).toEqual({
      'a.txt': null,
      'b.txt': { content: 'hi' },
    })
    expectThrows(() => normalizeGistFilesPatch({}), 400)
    expectThrows(() => normalizeGistFilesPatch({ 'a/b.txt': { content: 'x' } }), 400)
    expectThrows(
      () =>
        normalizeGistFilesPatch({
          'a.txt': { content: 'x'.repeat(400 * 1024) },
          'b.txt': { content: 'x'.repeat(400 * 1024) },
        }),
      413,
    )
  })

  it('sends file deletions as null in the patch body', async () => {
    stubFetch(() => jsonResponse(gistRaw({})))
    await updateGithubGist(
      'abcdef12',
      { files: { 'a.txt': null, 'b.txt': { content: 'hi' } } },
      'tok',
    )
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      files: { 'a.txt': null, 'b.txt': { content: 'hi' } },
    })
  })
})

describe('development github http errors', () => {
  it('maps 401, 404, 429, 5xx and network failures to github errors', async () => {
    stubFetch(() => jsonResponse({ message: 'bad' }, 401))
    await expect(githubJson('/user')).rejects.toMatchObject({
      status: 400,
      code: 'github_token_invalid',
    })

    stubFetch(() => jsonResponse({ message: 'missing' }, 404))
    await expect(githubJson('/user')).rejects.toMatchObject({
      status: 404,
      code: 'github_not_found',
    })

    stubFetch(() =>
      jsonResponse({ message: 'rate' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-limit': '60',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-resource': 'core',
      }),
    )
    await expect(githubJson('/user')).rejects.toMatchObject({
      status: 429,
      code: 'github_rate_limited',
      details: {
        remaining: 0,
        resetAt: new Date(1700000000 * 1000).toISOString(),
        resource: 'core',
      },
    })

    stubFetch(() =>
      jsonResponse({ message: 'forbidden' }, 403, { 'x-ratelimit-remaining': '10' }),
    )
    await expect(githubJson('/user')).rejects.toMatchObject({
      status: 502,
      code: 'github_upstream',
    })

    stubFetch(() => jsonResponse({ message: 'boom' }, 500))
    await expect(githubJson('/user')).rejects.toMatchObject({
      status: 502,
      code: 'github_upstream',
    })

    stubFetch(() => {
      throw new Error('offline')
    })
    await expect(githubJson('/user')).rejects.toMatchObject({
      status: 502,
      code: 'github_upstream',
    })
  })

  it('maps a timeout and a redirect to upstream errors', async () => {
    stubFetch(() => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    })
    await expect(githubJson('/user')).rejects.toMatchObject({ status: 502 })

    stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil' } }))
    await expect(githubJson('/user')).rejects.toMatchObject({
      status: 502,
      code: 'github_upstream',
    })
  })

  it('refuses oversized and invalid JSON responses', async () => {
    stubFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(MAX_GITHUB_TEXT_BYTES + 1) },
        }),
    )
    await expect(githubJson('/user')).rejects.toMatchObject({ status: 502 })

    stubFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_GITHUB_TEXT_BYTES + 1))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    })
    await expect(githubJson('/user')).rejects.toMatchObject({ status: 502 })

    stubFetch(() => new Response('not json', { status: 200 }))
    await expect(githubJson('/user')).rejects.toMatchObject({ status: 502 })
  })
})

describe('development github repo detail cache', () => {
  it('serves an anonymous detail from the short-lived cache', async () => {
    stubFetch((url) => {
      if (url.endsWith('/branches?per_page=100')) return jsonResponse([])
      if (url.endsWith('/tags?per_page=100')) return jsonResponse([])
      if (url.endsWith('/languages')) return jsonResponse({ TypeScript: 1000 })
      if (url.includes('/releases?per_page=30')) return jsonResponse([])
      if (url.endsWith('/readme')) return new Response('# hi', { status: 200 })
      return jsonResponse({}, 404)
    })
    const first = await fetchRepoDetail('cache/demo', 'main')
    expect(calls).toHaveLength(5)
    const second = await fetchRepoDetail('cache/demo', 'main')
    expect(calls).toHaveLength(5)
    expect(second).toEqual(first)
    expect(second.readme).toBe('# hi')
  })
})

describe('development github repo detail parts', () => {
  it('fetches only the requested parts', async () => {
    stubFetch((url) => {
      if (url.endsWith('/readme')) return new Response('# hi', { status: 200 })
      if (url.endsWith('/languages')) return jsonResponse({ TypeScript: 10 })
      return jsonResponse([], 200)
    })
    const detail = await fetchRepoDetail('parts/demo', 'main', undefined, ['readme', 'languages'])
    expect(calls).toHaveLength(2)
    expect(detail.loaded).toEqual(['languages', 'readme'])
    expect(detail.readme).toBe('# hi')
    expect(detail.languages).toEqual([{ name: 'TypeScript', bytes: 10, percentage: 100 }])
    expect(detail.releases).toEqual([])
  })
})

describe('development github starred repositories', () => {
  it('normalizes a starred page and its next link', async () => {
    stubFetch(() => jsonResponse([
      {
        id: 1,
        name: 'demo',
        full_name: 'octo/demo',
        html_url: 'https://github.com/octo/demo',
        owner: { login: 'octo', avatar_url: '' },
        stargazers_count: 1,
      },
    ], 200, { link: '<https://api.github.com/user/starred?page=2>; rel="next"' }))
    const result = await fetchStarredRepos(1, 100, 'tok')
    expect(result.items[0]?.fullName).toBe('octo/demo')
    expect(result.hasNext).toBe(true)
  })
})
