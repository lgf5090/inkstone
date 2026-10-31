import {
  GITHUB_DETAIL_TIMEOUT_MS,
  GITHUB_SEARCH_TIMEOUT_MS,
  GITHUB_TIMEOUT_MS,
  MAX_GITHUB_TEXT_BYTES,
} from '@shared/development/github/limits'
import type {
  GithubRelease,
  GithubReleaseAsset,
  GithubRepo,
  GithubRepoDetail,
  GithubRepoDetailPart,
  GithubSearchParams,
  GithubSearchResult,
  GithubWarning,
  GithubWarningCode,
  GithubWarningSource,
} from '@shared/development/github/types'
import { ApiError } from '../../lib/errors'
import { githubJson, githubText } from './github-http'
import { readHttpUrl, readNullableHttpUrl } from '@shared/development/github/url'

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/
const DETAIL_CACHE_TTL_MS = 5 * 60_000
const DETAIL_CACHE_MAX_ENTRIES = 30
const DETAIL_CACHE_MAX_BYTES = 12 * 1024 * 1024

interface DetailCacheEntry {
  detail: GithubRepoDetail
  expiresAt: number
  bytes: number
}

const detailCache = new Map<string, DetailCacheEntry>()
let detailCacheBytes = 0

function dropDetailEntry(key: string): void {
  const entry = detailCache.get(key)
  if (!entry) return
  detailCache.delete(key)
  detailCacheBytes -= entry.bytes
}

function readDetailCache(key: string): GithubRepoDetail | null {
  const entry = detailCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    dropDetailEntry(key)
    return null
  }
  return entry.detail
}

function writeDetailCache(key: string, detail: GithubRepoDetail): void {
  if (detail.warnings.length > 0) return
  const bytes = 4096 + (detail.readme?.length ?? 0) * 2
  while (detailCache.size >= DETAIL_CACHE_MAX_ENTRIES || detailCacheBytes + bytes > DETAIL_CACHE_MAX_BYTES) {
    const oldest = detailCache.keys().next().value
    if (oldest === undefined) break
    dropDetailEntry(oldest)
  }
  dropDetailEntry(key)
  detailCache.set(key, { detail, expiresAt: Date.now() + DETAIL_CACHE_TTL_MS, bytes })
  detailCacheBytes += bytes
}

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
    url: readHttpUrl(raw.html_url, 2048),
    description: readNullableString(raw.description, 8000),
    homepage: readNullableHttpUrl(raw.homepage, 2048),
    owner: {
      login: readString(owner.login, 100),
      avatarUrl: readHttpUrl(owner.avatar_url, 2048),
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
    downloadUrl: readHttpUrl(raw.browser_download_url, 2048),
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
    htmlUrl: readHttpUrl(raw.html_url, 2048),
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

export async function fetchRepository(
  fullName: string,
  token?: string | null,
): Promise<GithubRepo> {
  const parsed = parseRepoFullName(fullName)
  if (!parsed) throw ApiError.badRequest('A repository must be named owner/name')
  const path = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`
  const { data } = await githubJson<unknown>(path, {
    token,
    timeoutMs: GITHUB_DETAIL_TIMEOUT_MS,
  })
  return normalizeRepo(data)
}

export async function fetchStarredRepos(
  page: number,
  perPage: number,
  token: string,
): Promise<{ items: GithubRepo[]; hasNext: boolean }> {
  const { data, link } = await githubJson<unknown[]>(
    `/user/starred?per_page=${perPage}&page=${page}`,
    { token, timeoutMs: GITHUB_TIMEOUT_MS },
  )
  return {
    items: Array.isArray(data) ? data.map((item) => normalizeRepo(item)) : [],
    hasNext: link !== null && link.includes('rel="next"'),
  }
}

export const REPO_DETAIL_PARTS: readonly GithubRepoDetailPart[] = [
  'branches',
  'tags',
  'languages',
  'releases',
  'readme',
]

export async function fetchRepoDetail(
  fullName: string,
  defaultBranch: string | undefined,
  token?: string | null,
  parts?: readonly GithubRepoDetailPart[],
): Promise<GithubRepoDetail> {
  const parsed = parseRepoFullName(fullName)
  if (!parsed) throw ApiError.badRequest('A repository must be named owner/name')
  const requested = new Set(parts && parts.length > 0 ? parts : REPO_DETAIL_PARTS)
  const partKey = REPO_DETAIL_PARTS.filter((part) => requested.has(part)).join(',')
  const cacheKey = `${parsed.owner.toLowerCase()}/${parsed.name.toLowerCase()}|${defaultBranch ?? ''}|${partKey}`
  if (!token) {
    const cached = readDetailCache(cacheKey)
    if (cached) return cached
  }
  const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`
  const request = { token, timeoutMs: GITHUB_DETAIL_TIMEOUT_MS }
  const skipped: SourceOutcome<unknown> = { data: null, error: null }
  const [branches, tags, languages, releases, readme] = await Promise.all([
    requested.has('branches')
      ? fetchSource(async () => (await githubJson<unknown[]>(`${base}/branches?per_page=100`, request)).data)
      : Promise.resolve(skipped),
    requested.has('tags')
      ? fetchSource(async () => (await githubJson<unknown[]>(`${base}/tags?per_page=100`, request)).data)
      : Promise.resolve(skipped),
    requested.has('languages')
      ? fetchSource(async () => (await githubJson<Record<string, unknown>>(`${base}/languages`, request)).data)
      : Promise.resolve(skipped),
    requested.has('releases')
      ? fetchSource(async () => (await githubJson<unknown[]>(`${base}/releases?per_page=30`, request)).data)
      : Promise.resolve(skipped),
    requested.has('readme')
      ? fetchSource(
        async () =>
          (
            await githubText(`${base}/readme`, {
              ...request,
              accept: 'application/vnd.github.raw+json',
              maxBytes: MAX_GITHUB_TEXT_BYTES,
            })
          ).data,
      )
      : Promise.resolve(skipped),
  ])
  const outcomes: Array<[GithubWarningSource, SourceOutcome<unknown>]> = []
  if (requested.has('branches')) outcomes.push(['branches', branches])
  if (requested.has('tags')) outcomes.push(['tags', tags])
  if (requested.has('languages')) outcomes.push(['languages', languages])
  if (requested.has('releases')) outcomes.push(['releases', releases])
  if (requested.has('readme')) outcomes.push(['readme', readme])
  const tokenFailures = outcomes.filter(
    ([, outcome]) => outcome.error?.code === 'github_token_invalid',
  )
  if (tokenFailures.length > 0 && tokenFailures.length === outcomes.length) {
    throw tokenFailures[0]![1].error!
  }
  const warnings = outcomes
    .filter(([, outcome]) => outcome.error !== null)
    .map(([source, outcome]) => warningFor(source, outcome.error!))
  const branchList = Array.isArray(branches.data) ? branches.data : []
  const tagList = Array.isArray(tags.data) ? tags.data : []
  const releaseList = Array.isArray(releases.data) ? releases.data : []
  const detail: GithubRepoDetail = {
    fullName: `${parsed.owner}/${parsed.name}`,
    branchesCount: branchList.length,
    branchesTruncated: branchList.length >= 100,
    defaultBranch: defaultBranch?.trim() || 'main',
    tagsCount: tagList.length,
    tagsTruncated: tagList.length >= 100,
    languages: normalizeLanguages(languages.data),
    releases: releaseList.map((release, index) => normalizeRelease(release, index)),
    releasesTruncated: releaseList.length >= 30,
    readme: typeof readme.data === 'string' ? readme.data : null,
    readmeHtmlUrl: `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}#readme`,
    warnings,
    rateLimited: warnings.some((warning) => warning.code === 'rate_limited'),
    loaded: REPO_DETAIL_PARTS.filter((part) => requested.has(part)),
  }
  if (!token) writeDetailCache(cacheKey, detail)
  return detail
}
