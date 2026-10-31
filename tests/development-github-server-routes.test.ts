// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS } from '../src/worker/development/github/schema'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { developmentGithubRoutes } from '../src/worker/routes/development-github'
import type { GithubAccountView, GithubExportFile } from '../src/shared/development/github/types'
import { EXPORT_TTL_MS } from '../src/shared/development/github/limits'
import { makeD1 } from './doubles/d1-sqlite'
import {
  testBindings,
  testDurableObjectNamespace,
  testR2Bucket,
} from './doubles/bindings'
import type { TestR2Bucket } from './doubles/bindings'

const USER_A = '0123456789abcdefghjkmnpqrs'
const USER_B = '0123456789abcdefghjkmnpqrt'
const GIST_ID = 'abcdef12'
const TOKEN = 'ghp_route_token_1234567890'

interface Envelope<T> {
  ok?: boolean
  data?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

const vaultStorage = new Map<string, unknown>()
let sqlite: DatabaseSync
let db: D1Database
let bucket: TestR2Bucket
let env: Env
let app: Hono<AppBindings>

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    const user = c.req.header('x-test-user')
    if (user) c.set('userId', user)
    await next()
  })
  instance.route('/api/development/github', developmentGithubRoutes)
  return instance
}

interface CallOptions {
  user?: string | null
  body?: unknown
  env?: Env
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.user !== null) headers['x-test-user'] = options.user ?? USER_A
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const target = path.startsWith('/api/') ? path : `/api/development/github${path}`
  return await app.fetch(
    new Request(`http://localhost${target}`, { method, headers, body }),
    options.env ?? env,
  )
}

async function bodyOf<T>(response: Response): Promise<Envelope<T>> {
  return JSON.parse(await response.text()) as Envelope<T>
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function stubGithub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      return await handler(String(input), init)
    }),
  )
}

function repoBody(id: number, tagIds: string[] = []): Record<string, unknown> {
  return {
    fullName: `owner/repo-${id}`,
    url: `https://github.com/owner/repo-${id}`,
    data: {
      id,
      name: `repo-${id}`,
      fullName: `owner/repo-${id}`,
      url: `https://github.com/owner/repo-${id}`,
      description: null,
      homepage: null,
      owner: { login: 'owner', avatarUrl: '' },
      language: 'TypeScript',
      stargazersCount: 1,
      forksCount: 0,
      openIssuesCount: 0,
      topics: [],
      license: null,
      isArchived: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      defaultBranch: 'main',
      size: 10,
    },
    tagIds,
    pinned: false,
    favorited: false,
  }
}

function gistBody(id: string, tagIds: string[] = []): Record<string, unknown> {
  return {
    description: `gist ${id}`,
    url: `https://gist.github.com/${id}`,
    data: {
      id,
      description: `gist ${id}`,
      url: `https://gist.github.com/${id}`,
      isPublic: true,
      owner: { login: 'octocat', avatarUrl: '' },
      files: [{ filename: 'a.txt', language: null, content: 'hello', size: 5 }],
      fileCount: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    },
    tagIds,
    pinned: false,
    favorited: false,
    notes: '',
  }
}

async function createAccount(login = 'octocat'): Promise<GithubAccountView> {
  stubGithub((url) => jsonResponse({ login, avatar_url: `https://avatar/${login}` }))
  const response = await call('POST', '/accounts', { body: { token: TOKEN } })
  expect(response.status).toBe(200)
  const envelope = await bodyOf<{ account: GithubAccountView }>(response)
  expect(envelope.ok).toBe(true)
  return envelope.data!.account
}

beforeEach(() => {
  vaultStorage.clear()
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = testBindings(db, {
    CREDENTIAL_VAULT: testDurableObjectNamespace((request) =>
      new CredentialVault(vaultState()).fetch(request),
    ),
    FILES: bucket,
  })
  app = buildApp()
})

afterEach(() => {
  sqlite.close()
  vi.unstubAllGlobals()
})

describe('development github routes authentication and bootstrap', () => {
  it('requires an authenticated user', async () => {
    const response = await call('GET', '/bootstrap', { user: null })
    expect(response.status).toBe(401)
    expect((await bodyOf(response)).error?.code).toBe('unauthenticated')
  })

  it('answers health and an empty bootstrap with the default mirror', async () => {
    const health = await call('GET', '/health')
    expect(health.status).toBe(200)
    expect((await bodyOf(health)).data).toEqual({ ready: true })

    const response = await call('GET', '/bootstrap')
    expect(response.status).toBe(200)
    const envelope = await bodyOf<Record<string, unknown>>(response)
    expect(envelope.ok).toBe(true)
    expect(envelope.data).toMatchObject({
      tags: [],
      repos: [],
      gistTags: [],
      gists: [],
      accounts: [],
      mirrors: [
        {
          id: 'gh-proxy',
          name: 'gh-proxy',
          url: 'https://gh-proxy.com',
          enabled: true,
        },
      ],
      capabilities: { exports: true },
    })
  })

  it('reports exports unavailable when file storage is absent', async () => {
    const response = await call('GET', '/bootstrap', { env: testBindings(db) })
    const envelope = await bodyOf<{ capabilities: { exports: boolean } }>(response)
    expect(envelope.data?.capabilities.exports).toBe(false)
  })
})

describe('development github tags and repositories', () => {
  it('creates a tag tree, validates parents and cascades a delete into repositories', async () => {
    const root = await call('PUT', '/tags/root', {
      body: { name: 'Root', color: '#112233', parentId: null, sortOrder: 0 },
    })
    expect(root.status).toBe(200)
    expect((await bodyOf<{ tag: { name: string } }>(root)).data?.tag.name).toBe('Root')

    const child = await call('PUT', '/tags/child', {
      body: { name: 'Child', parentId: 'root', sortOrder: 1 },
    })
    expect(child.status).toBe(200)

    expect((await call('PUT', '/tags/bad.id', { body: { name: 'Bad' } })).status).toBe(400)
    expect(
      (await call('PUT', '/tags/root', { body: { name: 'Root', parentId: 'root' } })).status,
    ).toBe(400)
    expect(
      (await call('PUT', '/tags/root', { body: { name: 'Root', parentId: 'child' } })).status,
    ).toBe(400)
    expect(
      (await call('PUT', '/tags/child', { body: { name: 'Child', parentId: 'missing' } })).status,
    ).toBe(400)
    expect((await call('PUT', '/tags/root', { body: { name: 'Root' } })).status).toBe(200)
    expect((await call('PUT', '/tags/root2', { body: { name: 'root' } })).status).toBe(400)
    expect(
      (await call('PUT', '/tags/child2', { body: { name: 'Root', parentId: 'root' } })).status,
    ).toBe(200)

    const repo = await call('PUT', '/repos/1', { body: repoBody(1, ['child']) })
    expect(repo.status).toBe(200)
    expect((await bodyOf<{ repo: { tagIds: string[] } }>(repo)).data?.repo.tagIds).toEqual(['child'])

    expect((await call('DELETE', '/tags/root', { user: USER_B })).status).toBe(404)

    const removed = await call('DELETE', '/tags/root')
    expect(removed.status).toBe(200)
    expect((await bodyOf(removed)).data).toEqual({
      removedTagIds: expect.arrayContaining(['root', 'child']),
      updatedRepoIds: ['1'],
    })
    const repoAfter = await bodyOf<{ repos: Array<{ tagIds: string[] }> }>(
      await call('GET', '/repos'),
    )
    expect(repoAfter.data?.repos[0]?.tagIds).toEqual([])
    expect((await bodyOf<{ tags: unknown[] }>(await call('GET', '/tags'))).data?.tags).toEqual([])
  })

  it('validates repository ids, tag ownership and body size', async () => {
    expect((await call('PUT', '/repos/not-a-number', { body: repoBody(1) })).status).toBe(400)

    const missingTag = await call('PUT', '/repos/1', { body: repoBody(1, ['missing']) })
    expect(missingTag.status).toBe(400)
    expect((await bodyOf(missingTag)).error?.details).toEqual({ missing: ['missing'] })

    const base = repoBody(1)
    const oversized = await call('PUT', '/repos/1', {
      body: {
        ...base,
        data: { ...(base.data as Record<string, unknown>), description: 'x'.repeat(400_000) },
      },
    })
    expect(oversized.status).toBe(413)

    expect((await call('DELETE', '/repos/1')).status).toBe(404)
    expect((await call('PUT', '/repos/1', { body: repoBody(1) })).status).toBe(200)
    expect((await call('DELETE', '/repos/1', { user: USER_B })).status).toBe(404)
    expect((await bodyOf<{ repos: unknown[] }>(await call('GET', '/repos', { user: USER_B }))).data?.repos).toEqual([])
  })
})

describe('development github gist entities', () => {
  it('manages gist tags, gists and the batch endpoints', async () => {
    expect(
      (await call('PUT', '/gist/tags/root', { body: { name: 'Root' } })).status,
    ).toBe(200)
    expect(
      (await call('PUT', '/gist/tags/child', { body: { name: 'Child', parentId: 'root' } })).status,
    ).toBe(200)

    expect((await call('PUT', `/gist/gists/${GIST_ID}`, { body: gistBody(GIST_ID, ['child']) })).status).toBe(200)
    expect((await call('PUT', '/gist/gists/not-hex', { body: gistBody(GIST_ID) })).status).toBe(400)

    const badFile = gistBody(GIST_ID)
    const badFileData = badFile.data as Record<string, unknown>
    const badFileName = await call('PUT', `/gist/gists/${GIST_ID}`, {
      body: {
        ...badFile,
        data: {
          ...badFileData,
          files: [{ filename: 'nested/a.txt', language: null, content: 'x', size: 1 }],
        },
      },
    })
    expect(badFileName.status).toBe(400)

    const batch = await call('POST', '/gist/gists/batch-update', {
      body: {
        ids: [GIST_ID],
        patch: { pinned: true, favorited: true, addTagIds: ['root'], removeTagIds: ['child'] },
      },
    })
    expect(batch.status).toBe(200)
    expect((await bodyOf<{ count: number }>(batch)).data?.count).toBe(1)
    const gists = await bodyOf<{ gists: Array<{ pinned: boolean; tagIds: string[] }> }>(
      await call('GET', '/gist/gists'),
    )
    expect(gists.data?.gists[0]).toMatchObject({ pinned: true, favorited: true })
    expect(gists.data?.gists[0]?.tagIds.sort()).toEqual(['root'])

    const removed = await call('DELETE', '/gist/tags/root')
    expect((await bodyOf(removed)).data).toEqual({
      removedTagIds: expect.arrayContaining(['root', 'child']),
      updatedGistIds: [GIST_ID],
    })

    const deleted = await call('POST', '/gist/gists/batch-delete', { body: { ids: [GIST_ID] } })
    expect((await bodyOf<{ count: number }>(deleted)).data?.count).toBe(1)
    expect((await call('DELETE', `/gist/gists/${GIST_ID}`)).status).toBe(404)
  })

  it('rejects gist tags owned by another user', async () => {
    await call('PUT', '/gist/tags/root', { body: { name: 'Root' } })
    const response = await call('PUT', `/gist/gists/${GIST_ID}`, {
      user: USER_B,
      body: gistBody(GIST_ID, ['root']),
    })
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).error?.details).toEqual({ missing: ['root'] })
  })
})

describe('development github mirrors and accounts', () => {
  it('validates mirror URLs and falls back to the default when empty', async () => {
    const invalid = await call('PUT', '/mirrors', {
      body: { mirrors: [{ id: 'bad', name: 'Bad', url: 'javascript:alert(1)', enabled: true }] },
    })
    expect(invalid.status).toBe(400)

    const credentials = await call('PUT', '/mirrors', {
      body: {
        mirrors: [
          { id: 'cred', name: 'Cred', url: 'https://user:pass@example.com', enabled: true },
        ],
      },
    })
    expect(credentials.status).toBe(400)

    const saved = await call('PUT', '/mirrors', {
      body: {
        mirrors: [
          { id: 'gh-proxy', name: 'gh-proxy', url: 'https://gh-proxy.com', enabled: true },
          { id: 'fast', name: 'Fast', url: 'http://mirror.example', enabled: false },
        ],
      },
    })
    expect(saved.status).toBe(200)
    expect((await bodyOf<{ mirrors: unknown[] }>(saved)).data?.mirrors).toHaveLength(2)

    const listed = await bodyOf<{ mirrors: unknown[] }>(await call('GET', '/mirrors'))
    expect(listed.data?.mirrors).toHaveLength(2)

    const empty = await call('PUT', '/mirrors', { body: { mirrors: [] } })
    expect((await bodyOf<{ mirrors: Array<{ id: string }> }>(empty)).data?.mirrors[0]?.id).toBe(
      'gh-proxy',
    )
  })

  it('adds, lists and deletes a sanitized account', async () => {
    const account = await createAccount()
    expect(JSON.stringify(account)).not.toContain(TOKEN)
    expect('tokenCiphertext' in account).toBe(false)

    const listed = await bodyOf<{ accounts: GithubAccountView[] }>(await call('GET', '/accounts'))
    expect(listed.data?.accounts).toEqual([account])

    expect((await call('DELETE', '/accounts/not-an-id')).status).toBe(400)
    expect(
      (await call('DELETE', '/accounts/0123456789abcdefghjkmnpqrs')).status,
    ).toBe(404)
    expect((await call('DELETE', `/accounts/${account.id}`)).status).toBe(200)
    expect((await bodyOf<{ accounts: unknown[] }>(await call('GET', '/accounts'))).data?.accounts).toEqual([])
  })

  it('requires a token for an account write', async () => {
    const response = await call('POST', '/accounts', { body: { token: '' } })
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).error?.code).toBe('bad_request')
  })
})

describe('development github proxies', () => {
  it('searches with the composed query and no token when no account exists', async () => {
    let requested = ''
    stubGithub((url) => {
      requested = url
      return jsonResponse({
        total_count: 1,
        items: [
          {
            id: 1,
            name: 'react',
            full_name: 'facebook/react',
            html_url: 'https://github.com/facebook/react',
            owner: { login: 'facebook', avatar_url: '' },
            stargazers_count: 10,
            forks_count: 1,
            open_issues_count: 0,
            topics: [],
            archived: false,
            default_branch: 'main',
          },
        ],
      })
    })
    const response = await call(
      'GET',
      '/search?q=react&range=all&sort=best-match&order=asc&per_page=10&page=2',
    )
    expect(response.status).toBe(200)
    const envelope = await bodyOf<{ total: number; items: unknown[] }>(response)
    expect(envelope.data?.total).toBe(1)
    expect(envelope.data?.items).toHaveLength(1)
    const url = new URL(requested)
    expect(url.searchParams.get('q')).toBe('react fork:false')
    expect(url.searchParams.get('sort')).toBeNull()
    expect(url.searchParams.get('order')).toBe('asc')
  })

  it('limits runaway searches per user', async () => {
    stubGithub(() => jsonResponse({ total_count: 0, items: [] }))
    const user = 'limited-user'
    let last = 0
    for (let index = 0; index < 21; index += 1) {
      last = (await call('GET', '/search?q=x', { user })).status
    }
    expect(last).toBe(429)
  })

  it('proxies README images and rejects non-images', async () => {
    stubGithub(() => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const image = await call('GET', `/image?url=${encodeURIComponent('https://cdn.example.com/a.png')}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect((await image.arrayBuffer()).byteLength).toBe(3)

    stubGithub(() => jsonResponse({ not: 'an image' }))
    const rejected = await call('GET', `/image?url=${encodeURIComponent('https://cdn.example.com/a.txt')}`)
    expect(rejected.status).toBe(502)
    expect((await bodyOf(rejected)).error?.code).toBe('github_upstream')
    expect((await call('GET', '/image')).status).toBe(400)
  })

  it('maps upstream failures to the github error codes', async () => {
    stubGithub(() => jsonResponse({ message: 'bad credentials' }, 401))
    const invalid = await call('GET', '/search')
    expect(invalid.status).toBe(400)
    expect((await bodyOf(invalid)).error?.code).toBe('github_token_invalid')

    stubGithub(() =>
      jsonResponse({ message: 'rate' }, 403, { 'x-ratelimit-remaining': '0' }),
    )
    const limited = await call('GET', '/search')
    expect(limited.status).toBe(429)
    expect((await bodyOf(limited)).error?.code).toBe('github_rate_limited')

    stubGithub(() => jsonResponse({ message: 'missing' }, 404))
    const missing = await call('GET', `/gist/detail?gist=${GIST_ID}`)
    expect(missing.status).toBe(404)
    expect((await bodyOf(missing)).error?.code).toBe('github_not_found')
  })

  it('validates proxy query ids before calling GitHub', async () => {
    stubGithub(() => jsonResponse({}))
    expect((await call('GET', '/repo-detail?repo=bad')).status).toBe(400)
    expect((await call('GET', '/gist/detail?gist=zzz')).status).toBe(400)
    expect((await call('GET', '/gist/users/bad%20name/gists')).status).toBe(400)
    expect((await call('GET', '/search?per_page=101')).status).toBe(400)
    expect((await call('GET', '/search?page=41')).status).toBe(400)
  })

  it('returns repo detail warnings and truncation flags', async () => {
    stubGithub((url) => {
      if (url.endsWith('/branches?per_page=100')) return jsonResponse([])
      if (url.endsWith('/tags?per_page=100')) return jsonResponse([])
      if (url.endsWith('/languages')) return jsonResponse({ Rust: 100 })
      if (url.endsWith('/releases?per_page=30')) {
        return jsonResponse({ message: 'rate' }, 403, { 'x-ratelimit-remaining': '0' })
      }
      return new Response('# readme')
    })
    const response = await call('GET', '/repo-detail?repo=owner/name&defaultBranch=trunk')
    expect(response.status).toBe(200)
    const detail = (await bodyOf<{
      defaultBranch: string
      languages: unknown[]
      warnings: Array<{ source: string; code: string }>
      rateLimited: boolean
    }>(response)).data!
    expect(detail.defaultBranch).toBe('trunk')
    expect(detail.languages).toEqual([{ name: 'Rust', bytes: 100, percentage: 100 }])
    expect(detail.warnings).toEqual([
      { source: 'releases', code: 'rate_limited', message: 'The GitHub API rate limit has been reached' },
    ])
    expect(detail.rateLimited).toBe(true)
  })

  it('lists public gists, requires an account for mine and reads a detail', async () => {
    const raw = {
      id: GIST_ID,
      description: 'A gist',
      html_url: 'https://gist.github.com/abcdef12',
      public: true,
      owner: { login: 'octocat', avatar_url: '' },
      files: { 'a.txt': { filename: 'a.txt', language: null, content: 'hello', size: 5 } },
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    }
    stubGithub((url) => (url.includes('/gists/abcdef12') ? jsonResponse(raw) : jsonResponse([raw])))
    const publicList = await call('GET', '/gist/public?page=1&per_page=30')
    expect(publicList.status).toBe(200)
    expect((await bodyOf<{ items: unknown[] }>(publicList)).data?.items).toHaveLength(1)

    const mine = await call('GET', '/gist/mine')
    expect(mine.status).toBe(400)
    expect((await bodyOf(mine)).error?.code).toBe('github_token_required')

    const detail = await call('GET', `/gist/detail?gist=${GIST_ID}`)
    expect(detail.status).toBe(200)
    expect((await bodyOf<{ files: unknown[] }>(detail)).data?.files).toHaveLength(1)

    expect((await call('GET', '/gist/users/a-/gists')).status).toBe(400)
    expect((await call('GET', '/gist/users/a--b/gists')).status).toBe(400)
  })

  it('checks gist ownership before updating or deleting', async () => {
    const noAccount = await call('PATCH', `/gist/github-gists/${GIST_ID}`, {
      body: { description: 'Updated' },
    })
    expect(noAccount.status).toBe(400)
    expect((await bodyOf(noAccount)).error?.code).toBe('github_token_required')

    await createAccount('octocat')
    stubGithub((url, init) => {
      if (init?.method === 'PATCH') {
        return jsonResponse({
          id: GIST_ID,
          description: 'Updated',
          html_url: 'https://gist.github.com/abcdef12',
          public: true,
          owner: { login: 'octocat', avatar_url: '' },
          files: {},
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        })
      }
      return jsonResponse({
        id: GIST_ID,
        description: 'A gist',
        html_url: 'https://gist.github.com/abcdef12',
        public: true,
        owner: { login: 'octocat', avatar_url: '' },
        files: {},
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      })
    })
    const updated = await call('PATCH', `/gist/github-gists/${GIST_ID}`, {
      body: { description: 'Updated' },
    })
    expect(updated.status).toBe(200)
    expect((await bodyOf<{ gist: { description: string } }>(updated)).data?.gist.description).toBe(
      'Updated',
    )

    stubGithub(() =>
      jsonResponse({
        id: GIST_ID,
        description: 'A gist',
        html_url: 'https://gist.github.com/abcdef12',
        public: true,
        owner: { login: 'someone-else', avatar_url: '' },
        files: {},
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }),
    )
    const foreign = await call('DELETE', `/gist/github-gists/${GIST_ID}`)
    expect(foreign.status).toBe(404)
    expect((await bodyOf(foreign)).error?.code).toBe('github_not_found')
  })

  it('creates a gist with the stored account token', async () => {
    await createAccount('octocat')
    stubGithub(() =>
      jsonResponse({
        id: GIST_ID,
        description: 'Created',
        html_url: 'https://gist.github.com/abcdef12',
        public: false,
        owner: { login: 'octocat', avatar_url: '' },
        files: {},
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }),
    )
    const response = await call('POST', '/gist/github-gists', {
      body: {
        description: 'Created',
        isPublic: false,
        files: [{ filename: 'a.txt', content: 'hello' }],
      },
    })
    expect(response.status).toBe(200)
    expect((await bodyOf<{ gist: { description: string } }>(response)).data?.gist.description).toBe(
      'Created',
    )
  })
})

describe('development github exports', () => {
  async function createLocalGist(): Promise<void> {
    const response = await call('PUT', `/gist/gists/${GIST_ID}`, { body: gistBody(GIST_ID) })
    expect(response.status).toBe(200)
  }

  it('exports a local gist, serves it as an attachment and deletes it', async () => {
    await createLocalGist()
    const created = await call('POST', `/gists/${GIST_ID}/exports`, { body: { format: 'md' } })
    expect(created.status).toBe(200)
    const exported = (await bodyOf<{ export: GithubExportFile }>(created)).data!.export
    expect(exported).toMatchObject({ format: 'md', filename: `gist-${GIST_ID}.md` })
    expect(bucket.objects.has(`development/github/md/${USER_A}/${exported.id}.md`)).toBe(true)

    const listed = await call('GET', '/exports')
    expect((await bodyOf<{ exports: GithubExportFile[] }>(listed)).data?.exports).toHaveLength(1)

    const downloaded = await call('GET', `/exports/${exported.id}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(downloaded.headers.get('content-disposition')).toContain('attachment;')
    expect(await downloaded.text()).toContain(`gist ${GIST_ID}`)

    expect((await call('GET', `/exports/${exported.id}`, { user: USER_B })).status).toBe(404)
    expect((await call('DELETE', `/exports/${exported.id}`, { user: USER_B })).status).toBe(404)

    expect((await call('DELETE', `/exports/${exported.id}`)).status).toBe(200)
    expect((await call('GET', `/exports/${exported.id}`)).status).toBe(404)
  })

  it('requires an existing local gist and file storage', async () => {
    expect((await call('POST', `/gists/${GIST_ID}/exports`, { body: { format: 'json' } })).status).toBe(404)

    await createLocalGist()
    const missingStorage = testBindings(db)
    const response = await call('POST', `/gists/${GIST_ID}/exports`, {
      env: missingStorage,
      body: { format: 'json' },
    })
    expect(response.status).toBe(503)
    expect((await bodyOf(response)).error?.code).toBe('storage_unavailable')
  })

  it('refuses and removes an expired export', async () => {
    await createLocalGist()
    const created = await call('POST', `/gists/${GIST_ID}/exports`, { body: { format: 'md' } })
    const exported = (await bodyOf<{ export: GithubExportFile }>(created)).data!.export
    sqlite
      .prepare('UPDATE development_github_exports SET created_at = ? WHERE user_id = ? AND id = ?')
      .run(Date.now() - EXPORT_TTL_MS - 1000, USER_A, exported.id)
    expect((await call('GET', `/exports/${exported.id}`)).status).toBe(404)
    const row = sqlite
      .prepare('SELECT COUNT(*) AS count FROM development_github_exports WHERE user_id = ?')
      .get(USER_A) as { count: number }
    expect(row.count).toBe(0)
  })
})
