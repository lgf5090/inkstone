import {
  GITHUB_DETAIL_TIMEOUT_MS,
  GITHUB_SEARCH_TIMEOUT_MS,
  MAX_GITHUB_TEXT_BYTES,
} from '@shared/development/github/limits'
import type {
  GithubRelease,
  GithubReleaseAsset,
  GithubRepo,
  GithubRepoDetail,
  GithubSearchParams,
  GithubSearchResult,
  GithubWarning,
  GithubWarningCode,
  GithubWarningSource,
} from '@shared/development/github/types'
import { ApiError } from '../../lib/errors'
import { githubJson, githubText } from './github-http'

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

const RANGE_DAYS: Record<Exclude<GithubSearchParams['range'], 'all'>, number> = {
  today: 0,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function readNullableString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' ? value.slice(0, maxLength) : null
}

function readNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

function readInteger(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

export function parseRepoFullName(value: string): { owner: string; name: string } | null {
  const parts = value.split('/')
  if (parts.length !== 2) return null
  const owner = parts[0]!
  const name = parts[1]!
  if (!REPO_SEGMENT_PATTERN.test(owner) || !REPO_SEGMENT_PATTERN.test(name)) return null
  return { owner, name }
}

export function normalizeRepo(value: unknown): GithubRepo {
  const raw = isRecord(value) ? value : {}
  const owner = isRecord(raw.owner) ? raw.owner : {}
  const license = isRecord(raw.license) ? raw.license : null
  const licenseName = license
    ? readNullableString(license.spdx_id, 200) ?? readNullableString(license.name, 200)
    : null
  const topics = Array.isArray(raw.topics)
    ? raw.topics
        .filter((topic): topic is string => typeof topic === 'string')
        .slice(0, 100)
        .map((topic) => topic.slice(0, 100))
    : []
  return {
    id: readNumber(raw.id),
    name: readString(raw.name, 200),
    fullName: readString(raw.full_name, 300),
    url: readString(raw.html_url, 2048),
    description: readNullableString(raw.description, 8000),
    homepage: readNullableString(raw.homepage, 2048),
    owner: {
      login: readString(owner.login, 100),
      avatarUrl: readString(owner.avatar_url, 2048),
    },
    language: readNullableString(raw.language, 100),
    stargazersCount: readNumber(raw.stargazers_count),
    forksCount: readNumber(raw.forks_count),
    openIssuesCount: readNumber(raw.open_issues_count),
    topics,
    license: licenseName,
    isArchived: raw.archived === true,
    createdAt: readString(raw.created_at, 64),
    updatedAt: readString(raw.updated_at, 64),
    defaultBranch: readString(raw.default_branch, 200) || 'main',
    size: readNumber(raw.size),
  }
}

export function buildSearchQuery(params: GithubSearchParams, now = new Date()): string {
  const parts: string[] = []
  const query = params.q.trim()
  if (query) parts.push(query)
  if (params.range !== 'all') {
    const since = new Date(now.getTime())
    since.setUTCDate(since.getUTCDate() - RANGE_DAYS[params.range])
    parts.push(`created:>=${since.toISOString().slice(0, 10)}`)
  }
  const language = params.language.trim()
  if (language) parts.push(`language:${language}`)
  parts.push('fork:false')
  if (!query) parts.push('archived:false')
  return parts.join(' ')
}

export async function searchRepositories(
  params: GithubSearchParams,
  token?: string | null,
): Promise<GithubSearchResult> {
  const search = new URLSearchParams({
    q: buildSearchQuery(params),
    per_page: String(params.perPage),
    page: String(params.page),
  })
  if (params.sort !== 'best-match') search.set('sort', params.sort)
  search.set('order', params.order)
  const { data } = await githubJson<{ total_count?: unknown; items?: unknown }>(
    `/search/repositories?${search.toString()}`,
    { token, timeoutMs: GITHUB_SEARCH_TIMEOUT_MS },
  )
  const items = Array.isArray(data?.items) ? data.items.map((item) => normalizeRepo(item)) : []
  const rawTotal = Number(data?.total_count)
  const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? Math.trunc(rawTotal) : items.length
  return { total, items }
}

interface SourceOutcome<T> {
  data: T | null
  error: ApiError | null
}

async function fetchSource<T>(work: () => Promise<T>): Promise<SourceOutcome<T>> {
  try {
    return { data: await work(), error: null }
  } catch (error) {
    if (error instanceof ApiError) return { data: null, error }
    return { data: null, error: new ApiError(502, 'github_upstream', 'GitHub request failed') }
  }
}

function warningCode(error: ApiError): GithubWarningCode {
  if (error.code === 'github_rate_limited') return 'rate_limited'
  if (error.code === 'github_not_found') return 'not_found'
  return 'upstream'
}

function warningFor(source: GithubWarningSource, error: ApiError): GithubWarning {
  return {
    source,
    code: warningCode(error),
    message: error.message.slice(0, 200),
  }
}

function normalizeAsset(value: unknown): GithubReleaseAsset {
  const raw = isRecord(value) ? value : {}
  return {
    id: readInteger(raw.id),
    name: readString(raw.name, 200),
    label: readNullableString(raw.label, 200),
    contentType: readString(raw.content_type, 200) || 'application/octet-stream',
    size: readNumber(raw.size),
    downloadUrl: readString(raw.browser_download_url, 2048),
  }
}

function normalizeRelease(value: unknown, index: number): GithubRelease {
  const raw = isRecord(value) ? value : {}
  return {
    id: readInteger(raw.id),
    tagName: readString(raw.tag_name, 200),
    name: readNullableString(raw.name, 200),
    isPrerelease: raw.prerelease === true,
    isLatest: index === 0,
    publishedAt: readString(raw.published_at ?? raw.created_at, 64),
    htmlUrl: readString(raw.html_url, 2048),
    body: readNullableString(raw.body, 40000),
    assets: Array.isArray(raw.assets) ? raw.assets.map((asset) => normalizeAsset(asset)) : [],
  }
}

function normalizeLanguages(value: unknown): GithubRepoDetail['languages'] {
  const raw = isRecord(value) ? value : {}
  const entries = Object.entries(raw)
    .map(([name, bytes]) => ({ name, bytes: readNumber(bytes) }))
    .filter((entry) => entry.name.length > 0)
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  return entries
    .map((entry) => ({
      ...entry,
      percentage: total > 0 ? Math.round((entry.bytes / total) * 1000) / 10 : 0,
    }))
    .sort((left, right) => right.bytes - left.bytes)
}

export async function fetchRepoDetail(
  fullName: string,
  defaultBranch: string | undefined,
  token?: string | null,
): Promise<GithubRepoDetail> {
  const parsed = parseRepoFullName(fullName)
  if (!parsed) throw ApiError.badRequest('A repository must be named owner/name')
  const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`
  const request = { token, timeoutMs: GITHUB_DETAIL_TIMEOUT_MS }
  const [branches, tags, languages, releases, readme] = await Promise.all([
    fetchSource(async () => (await githubJson<unknown[]>(`${base}/branches?per_page=100`, request)).data),
    fetchSource(async () => (await githubJson<unknown[]>(`${base}/tags?per_page=100`, request)).data),
    fetchSource(
      async () => (await githubJson<Record<string, unknown>>(`${base}/languages`, request)).data,
    ),
    fetchSource(async () => (await githubJson<unknown[]>(`${base}/releases?per_page=30`, request)).data),
    fetchSource(
      async () =>
        (
          await githubText(`${base}/readme`, {
            ...request,
            accept: 'application/vnd.github.raw+json',
            maxBytes: MAX_GITHUB_TEXT_BYTES,
          })
        ).data,
    ),
  ])
  const outcomes: Array<[GithubWarningSource, SourceOutcome<unknown>]> = [
    ['branches', branches],
    ['tags', tags],
    ['languages', languages],
    ['releases', releases],
    ['readme', readme],
  ]
  const tokenFailures = outcomes.filter(
    ([, outcome]) => outcome.error?.code === 'github_token_invalid',
  )
  if (tokenFailures.length === outcomes.length) {
    throw tokenFailures[0]![1].error!
  }
  const warnings = outcomes
    .filter(([, outcome]) => outcome.error !== null)
    .map(([source, outcome]) => warningFor(source, outcome.error!))
  const branchList = Array.isArray(branches.data) ? branches.data : []
  const tagList = Array.isArray(tags.data) ? tags.data : []
  const releaseList = Array.isArray(releases.data) ? releases.data : []
  return {
    fullName: `${parsed.owner}/${parsed.name}`,
    branchesCount: branchList.length,
    branchesTruncated: branchList.length >= 100,
    defaultBranch: defaultBranch?.trim() || 'main',
    tagsCount: tagList.length,
    tagsTruncated: tagList.length >= 100,
    languages: normalizeLanguages(languages.data),
    releases: releaseList.map((release, index) => normalizeRelease(release, index)),
    releasesTruncated: releaseList.length >= 30,
    readme: readme.data,
    readmeHtmlUrl: `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}#readme`,
    warnings,
    rateLimited: warnings.some((warning) => warning.code === 'rate_limited'),
  }
}
