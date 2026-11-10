// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS } from '../src/worker/development/github/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { developmentGithubRoutes } from '../src/worker/routes/development-github'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER_A = 'user-a'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    c.set('userId', USER_A)
    await next()
  })
  instance.route('/api/development/github', developmentGithubRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  return await app.fetch(
    new Request(`http://localhost${path.startsWith('/api/') ? path : `/api/development/github${path}`}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  const parsed = JSON.parse(await response.text()) as { ok?: boolean; data?: T }
  return parsed.data as T
}

function stubFetch(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))))
}

function repoItem(id: number) {
  return {
    id,
    name: `app-${id}`,
    full_name: `owner/app-${id}`,
    html_url: `https://github.com/owner/app-${id}`,
    description: 'An app',
    owner: { login: 'owner', avatar_url: 'https://avatar/owner' },
    language: 'TypeScript',
    stargazers_count: 10,
    forks_count: 1,
    open_issues_count: 0,
    topics: ['desktop'],
    archived: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    default_branch: 'main',
    size: 10,
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db)
  app = buildApp()
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('github apps routes', () => {
  it('rejects an id that does not match the repository and platform', async () => {
    const response = await call('PUT', '/apps/999-android', {
      repoId: '123',
      fullName: 'owner/app',
      repoUrl: 'https://github.com/owner/app',
      platform: 'android',
      installedTag: 'v1.0.0',
    })
    expect(response.status).toBe(400)
  })

  it('creates, lists and removes a tracked app', async () => {
    const created = await call('PUT', '/apps/123-android', {
      repoId: '123',
      fullName: 'owner/app',
      repoUrl: 'https://github.com/owner/app',
      ownerAvatarUrl: 'https://avatar/owner',
      platform: 'android',
      installedTag: 'v1.0.0',
    })
    expect(created.status).toBe(200)
    const saved = await json<{ app: { id: string; installedTag: string } }>(created)
    expect(saved.app.id).toBe('123-android')
    expect(saved.app.installedTag).toBe('v1.0.0')

    const listed = await json<{ apps: Array<{ id: string }> }>(await call('GET', '/apps'))
    expect(listed.apps.map((entry) => entry.id)).toEqual(['123-android'])

    expect((await call('DELETE', '/apps/123-android')).status).toBe(200)
    expect((await call('DELETE', '/apps/123-android')).status).toBe(404)
  })

  it('requires a GitHub account before checking updates', async () => {
    const response = await call('POST', '/apps/check', { ids: ['123-android'] })
    expect(response.status).toBe(400)
    const parsed = JSON.parse(await response.text()) as { error: { code: string } }
    expect(parsed.error.code).toBe('github_token_required')
  })
})

describe('github discover route', () => {
  it('returns search results without release verification when no account is saved', async () => {
    stubFetch((url) => {
      expect(url).toContain('/search/repositories')
      return new Response(JSON.stringify({ total_count: 1, items: [repoItem(7)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const response = await call('GET', '/discover?chart=trending&platform=all&topic=cli&page=1')
    expect(response.status).toBe(200)
    const data = await json<{ verified: boolean; total: number; items: Array<{ repo: { fullName: string }; release: unknown }> }>(response)
    expect(data.verified).toBe(false)
    expect(data.total).toBe(1)
    expect(data.items[0]?.repo.fullName).toBe('owner/app-7')
    expect(data.items[0]?.release).toBeNull()
  })
})

describe('github developer profile route', () => {
  it('normalizes the profile and drops archived repositories', async () => {
    stubFetch((url) => {
      if (url.endsWith('/repos?per_page=50&sort=updated&type=owner')) {
        return new Response(JSON.stringify([
          { ...repoItem(1), archived: false },
          { ...repoItem(2), id: 2, name: 'old', full_name: 'owner/old', archived: true },
        ]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        login: 'octocat',
        name: 'The Octocat',
        avatar_url: 'https://avatar/octocat',
        bio: 'Builds things',
        company: 'GitHub',
        location: 'San Francisco',
        blog: 'https://octocat.dev',
        html_url: 'https://github.com/octocat',
        followers: 12,
        following: 3,
        public_repos: 8,
        created_at: '2011-01-25T18:44:36Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const response = await call('GET', '/dev-profile?login=octocat')
    expect(response.status).toBe(200)
    const data = await json<{ profile: { login: string; name: string; followers: number; repos: Array<{ name: string }> } }>(response)
    expect(data.profile.login).toBe('octocat')
    expect(data.profile.name).toBe('The Octocat')
    expect(data.profile.followers).toBe(12)
    expect(data.profile.repos.map((repo) => repo.name)).toEqual(['app-1'])
  })
})
