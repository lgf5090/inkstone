import { GITHUB_DETAIL_TIMEOUT_MS, MAX_DEV_PROFILE_REPOS } from '@shared/development/github/limits'
import type { GithubDevProfile, GithubRepo } from '@shared/development/github/types'
import { readHttpUrl } from '@shared/development/github/url'
import { ApiError } from '../../lib/errors'
import { githubJson } from './github-http'
import { normalizeRepo } from './github-repos'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null
}

function count(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

export async function fetchDeveloperProfile(
  login: string,
  token?: string | null,
): Promise<GithubDevProfile> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    throw ApiError.badRequest('Invalid GitHub username')
  }
  const request = { token, timeoutMs: GITHUB_DETAIL_TIMEOUT_MS }
  const encoded = encodeURIComponent(login)
  const [user, repos] = await Promise.all([
    githubJson<unknown>(`/users/${encoded}`, request),
    githubJson<unknown[]>(`/users/${encoded}/repos?per_page=50&sort=updated&type=owner`, request),
  ])
  const raw = isRecord(user.data) ? user.data : {}
  const repoList: GithubRepo[] = Array.isArray(repos.data)
    ? repos.data
        .map((entry) => normalizeRepo(entry))
        .filter((repo) => !repo.isArchived && repo.name)
        .slice(0, MAX_DEV_PROFILE_REPOS)
    : []
  return {
    login: text(raw.login, 100) ?? login,
    name: text(raw.name, 200),
    avatarUrl: readHttpUrl(raw.avatar_url, 2048),
    bio: text(raw.bio, 2000),
    company: text(raw.company, 200),
    location: text(raw.location, 200),
    blog: readHttpUrl(raw.blog, 2048) || null,
    htmlUrl: readHttpUrl(raw.html_url, 2048) || `https://github.com/${encoded}`,
    followers: count(raw.followers),
    following: count(raw.following),
    publicRepos: count(raw.public_repos),
    createdAt: text(raw.created_at, 64) ?? '',
    repos: repoList,
  }
}
