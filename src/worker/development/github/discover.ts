import {
  DISCOVER_CACHE_TTL_MS,
  DISCOVER_VERIFY_LIMIT,
  GITHUB_DETAIL_TIMEOUT_MS,
} from '@shared/development/github/limits'
import { GITHUB_PLATFORM_TOPICS, summarizeRelease, updateState } from '@shared/development/github/platforms'
import { GITHUB_DISCOVER_CATEGORIES } from '@shared/development/github/types'
import type {
  GithubDiscoverCategory,
  GithubDiscoverItem,
  GithubDiscoverQuery,
  GithubDiscoverResult,
  GithubSortKey,
  GithubTrackedApp,
} from '@shared/development/github/types'
import { githubJson } from './github-http'
import { normalizeLatestStableRelease, searchRepositoriesByQuery } from './github-repos'
import { ApiError } from '../../lib/errors'

const DAY_MS = 24 * 60 * 60 * 1000
const VERIFY_CONCURRENCY = 8
const SEARCH_PER_PAGE = 50
const MAX_SCAN_PAGES = 4
const MAX_VERIFY_PER_REQUEST = 45
const MAX_POOL_ITEMS = 100
const MAX_CACHE_ENTRIES = 24
const UPDATED_DAYS: Record<Exclude<GithubDiscoverQuery['updated'], 'any'>, number> = { week: 7, month: 30, year: 365 }

export interface TrackedLookup {
  signature: string
  byRepoId: Map<string, GithubTrackedApp>
}

export function createTrackedLookup(apps: readonly GithubTrackedApp[]): TrackedLookup {
  return {
    signature: apps.map((app) => `${app.repoId}:${app.updatedAt}:${app.latestTag}:${app.installedTag}:${app.updateCheckEnabled ? 1 : 0}:${app.skippedTag}`).join('|'),
    byRepoId: new Map(apps.map((app) => [app.repoId, app])),
  }
}

interface CachedResult {
  value: GithubDiscoverResult
  expiresAt: number
}

interface QualifiedPool {
  items: GithubDiscoverItem[]
  nextPage: number
  exhausted: boolean
  verifyBudget: number
  checked: number
  failed: number
  scanned: number
  total: number
  expiresAt: number
}

const resultCache = new Map<string, CachedResult>()
const poolCache = new Map<string, QualifiedPool>()

function cacheKey(query: GithubDiscoverQuery, authenticated: boolean, trackedSignature = ''): string {
  return [
    query.chart,
    query.platform,
    query.topic,
    query.category,
    query.query,
    query.language,
    query.updated,
    query.tracked,
    query.installerOnly ? 'installer' : 'all',
    query.updateStatus,
    query.sort,
    query.order,
    authenticated ? 'auth' : 'anon',
    trackedSignature,
  ].join('|')
}

function readCache(key: string): GithubDiscoverResult | null {
  const entry = resultCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    resultCache.delete(key)
    return null
  }
  return entry.value
}

function writeCache(key: string, value: GithubDiscoverResult): void {
  resultCache.delete(key)
  resultCache.set(key, { value, expiresAt: Date.now() + DISCOVER_CACHE_TTL_MS })
  while (resultCache.size > MAX_CACHE_ENTRIES) {
    const oldest = resultCache.keys().next().value
    if (oldest === undefined) break
    resultCache.delete(oldest)
  }
}

function dayString(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function daysAgo(now: Date, days: number): string {
  return dayString(new Date(now.getTime() - days * DAY_MS))
}

function topicQualifiers(query: GithubDiscoverQuery): string[] {
  const parts: string[] = []
  const platformTopic = GITHUB_PLATFORM_TOPICS[query.platform]
  if (platformTopic) parts.push(`topic:${platformTopic}`)
  if (query.topic) parts.push(`topic:${query.topic}`)
  const categoryTopic = GITHUB_DISCOVER_CATEGORIES.find((entry) => entry.value === query.category)?.queryTopic
  if (categoryTopic && !parts.includes(`topic:${categoryTopic}`)) parts.push(`topic:${categoryTopic}`)
  return parts
}

export function buildDiscoverQuery(
  query: GithubDiscoverQuery,
  now = new Date(),
): { q: string; sort: 'stars' | 'updated' | 'forks' | null; order: 'asc' | 'desc' } {
  const filters: string[] = []
  if (query.language.trim()) filters.push(`language:${query.language.trim()}`)
  if (query.updated !== 'any') filters.push(`pushed:>=${daysAgo(now, UPDATED_DAYS[query.updated])}`)
  if (query.query.trim()) {
    const parts = [`${query.query.trim()} in:name,description`, 'fork:false', 'archived:false', ...topicQualifiers(query), ...filters]
    return {
      q: parts.join(' '),
      sort: query.sort === 'best-match' ? null : query.sort,
      order: query.order,
    }
  }
  const parts: string[] = ['fork:false', 'archived:false']
  if (query.chart === 'trending') {
    parts.push('stars:>50', `pushed:>=${daysAgo(now, 30)}`)
  } else if (query.chart === 'releases') {
    parts.push('stars:>10', `pushed:>=${daysAgo(now, 14)}`)
  } else {
    parts.push('stars:>1000', `created:<=${daysAgo(now, 180)}`, `pushed:>=${daysAgo(now, 365)}`)
  }
  parts.push(...topicQualifiers(query), ...filters)
  return {
    q: parts.join(' '),
    sort: query.chart === 'releases' ? 'updated' : 'stars',
    order: 'desc',
  }
}

function categoryTopics(category: GithubDiscoverCategory): readonly string[] {
  const entry = GITHUB_DISCOVER_CATEGORIES.find((candidate) => candidate.value === category)
  return entry?.topics ?? []
}

function matchesCategory(item: GithubDiscoverItem, category: GithubDiscoverCategory): boolean {
  if (category === 'all') return true
  const wanted = categoryTopics(category)
  if (wanted.length === 0) return true
  return item.repo.topics.some((topic) => wanted.includes(topic.toLowerCase()))
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function verifyItem(
  item: GithubDiscoverItem,
  platform: GithubDiscoverQuery['platform'],
  token: string | null,
): Promise<{ item: GithubDiscoverItem; ok: boolean }> {
  const parsed = item.repo.fullName.split('/')
  if (parsed.length !== 2) return { item, ok: false }
  try {
    const { data } = await githubJson<unknown[]>(
      `/repos/${encodeURIComponent(parsed[0]!)}/${encodeURIComponent(parsed[1]!)}/releases?per_page=5`,
      { token, timeoutMs: GITHUB_DETAIL_TIMEOUT_MS },
    )
    const release = normalizeLatestStableRelease(Array.isArray(data) ? data : [])
    return { item: { ...item, release: release ? summarizeRelease(release, platform) : null }, ok: true }
  } catch (error) {
    console.warn('[inkstone] GitHub release verification failed for', item.repo.fullName, error)
    return { item, ok: false }
  }
}

function needsQualification(query: GithubDiscoverQuery, token: string | null): boolean {
  if (!token) return false
  return query.platform !== 'all'
    || query.chart === 'releases'
    || query.query.trim() !== ''
    || query.category !== 'all'
    || query.installerOnly
}

function keepsItem(item: GithubDiscoverItem, query: GithubDiscoverQuery, tracked?: TrackedLookup): boolean {
  if (!matchesCategory(item, query.category)) return false
  if (query.chart === 'releases' && !item.release) return false
  if ((query.query.trim() !== '' || query.category !== 'all' || query.installerOnly) && (!item.release || item.release.platforms.length === 0)) {
    return false
  }
  if (query.platform !== 'all' && !item.release?.recommendedAsset) return false
  if (query.tracked !== 'any' || query.updateStatus !== 'any') {
    const app = tracked?.byRepoId.get(String(item.repo.id))
    if (query.tracked === 'tracked' && !app) return false
    if (query.tracked === 'untracked' && app) return false
    if (query.updateStatus !== 'any') {
      if (!app) return false
      const state = updateState(app.latestTag, app.installedTag)
      const suppressed = !app.updateCheckEnabled || (app.skippedTag !== '' && app.skippedTag === app.latestTag)
      if (query.updateStatus === 'available' && (suppressed || state !== 'update-available')) return false
      if (query.updateStatus === 'latest' && state === 'update-available' && !suppressed) return false
    }
  }
  return true
}

function sortedCandidates(items: readonly GithubDiscoverItem[], query: GithubDiscoverQuery): GithubDiscoverItem[] {
  return [...items].sort((left, right) => {
    const direction = query.order === 'asc' ? 1 : -1
    if (query.sort === 'updated') {
      return direction * left.repo.updatedAt.localeCompare(right.repo.updatedAt)
    }
    if (query.sort === 'forks') {
      return direction * (left.repo.forksCount - right.repo.forksCount)
    }
    return direction * (left.repo.stargazersCount - right.repo.stargazersCount)
  })
}

function initialPool(): QualifiedPool {
  return {
    items: [],
    nextPage: 1,
    exhausted: false,
    verifyBudget: MAX_VERIFY_PER_REQUEST,
    checked: 0,
    failed: 0,
    scanned: 0,
    total: 0,
    expiresAt: Date.now() + DISCOVER_CACHE_TTL_MS,
  }
}

async function ensurePool(
  key: string,
  query: GithubDiscoverQuery,
  token: string,
  target: number,
  tracked?: TrackedLookup,
): Promise<QualifiedPool> {
  let pool = poolCache.get(key)
  if (!pool || pool.expiresAt <= Date.now()) {
    pool = initialPool()
    poolCache.set(key, pool)
  }
  const built = buildDiscoverQuery(query)
  while (
    pool.items.length < target
    && !pool.exhausted
    && pool.verifyBudget > 0
    && pool.nextPage <= MAX_SCAN_PAGES
  ) {
    const search = await searchRepositoriesByQuery(
      built.q,
      built.sort === 'forks' ? 'forks' : built.sort,
      built.order,
      pool.nextPage,
      SEARCH_PER_PAGE,
      token,
    )
    pool.total = search.total
    pool.nextPage += 1
    if (search.items.length < SEARCH_PER_PAGE) pool.exhausted = true
    const candidates = search.items
      .map((repo) => ({ repo, release: null }))
      .filter((item) => matchesCategory(item, query.category))
    pool.scanned += candidates.length
    const verifyCount = Math.min(pool.verifyBudget, candidates.length)
    if (verifyCount === 0) break
    const head = candidates.slice(0, verifyCount)
    pool.verifyBudget -= head.length
    const checked = await mapWithConcurrency(head, VERIFY_CONCURRENCY, (item) => verifyItem(item, query.platform, token))
    pool.checked += checked.length
    for (const result of checked) {
      if (!result.ok) {
        pool.failed += 1
        continue
      }
      if (keepsItem(result.item, query, tracked)) pool.items.push(result.item)
    }
  }
  if (pool.items.length === 0 && pool.checked > 0 && pool.failed === pool.checked) {
    throw new ApiError(502, 'github_upstream', 'GitHub release lookup failed for every candidate')
  }
  if (query.sort !== 'best-match' && query.query.trim()) {
    pool.items = sortedCandidates(pool.items, query)
  }
  pool.expiresAt = Date.now() + DISCOVER_CACHE_TTL_MS
  while (poolCache.size > MAX_CACHE_ENTRIES) {
    const oldest = poolCache.keys().next().value
    if (oldest === undefined) break
    poolCache.delete(oldest)
  }
  return pool
}

export async function discoverRepositories(
  query: GithubDiscoverQuery,
  token: string | null,
  tracked?: TrackedLookup,
): Promise<GithubDiscoverResult> {
  const poolKey = cacheKey(query, Boolean(token), tracked?.signature)
  const resultKey = `${query.page}|${poolKey}`
  const cached = readCache(resultKey)
  if (cached) return cached

  if (!needsQualification(query, token)) {
    const built = buildDiscoverQuery(query)
    const search = await searchRepositoriesByQuery(
      built.q,
      built.sort === 'forks' ? 'forks' : built.sort,
      built.order,
      query.page,
      query.perPage,
      token,
    )
    const initial: GithubDiscoverItem[] = search.items.map((repo) => ({ repo, release: null }))
    const verified = Boolean(token) && initial.length > 0
    const head = verified ? initial.slice(0, DISCOVER_VERIFY_LIMIT) : []
    const tail = initial.slice(head.length)
    const checkedItems = verified
      ? (await mapWithConcurrency(head, VERIFY_CONCURRENCY, (item) => verifyItem(item, query.platform, token))).map((result) => result.item)
      : []
    const combined = [...checkedItems, ...tail]
    const filtered = tracked && (query.tracked !== 'any' || query.updateStatus !== 'any')
      ? combined.filter((item) => keepsItem(item, query, tracked))
      : combined
    const result: GithubDiscoverResult = {
      chart: query.chart,
      platform: query.platform,
      topic: query.topic,
      category: query.category,
      query: query.query,
      page: query.page,
      perPage: query.perPage,
      total: filtered === combined ? search.total : filtered.length,
      hasNext: query.page * query.perPage < (filtered === combined ? search.total : filtered.length),
      items: filtered,
      verified,
      checked: checkedItems.length,
    }
    writeCache(resultKey, result)
    return result
  }

  const target = Math.min(query.page * query.perPage + 1, MAX_POOL_ITEMS)
  const pool = await ensurePool(poolKey, query, token!, target, tracked)
  const start = (query.page - 1) * query.perPage
  const result: GithubDiscoverResult = {
    chart: query.chart,
    platform: query.platform,
    topic: query.topic,
    category: query.category,
    query: query.query,
    page: query.page,
    perPage: query.perPage,
    total: pool.items.length,
    hasNext: pool.items.length > query.page * query.perPage,
    items: pool.items.slice(start, start + query.perPage),
    verified: true,
    checked: pool.checked,
  }
  writeCache(resultKey, result)
  return result
}

export async function searchStoreRepositories(
  params: {
    q: string
    platform: GithubDiscoverQuery['platform']
    topic: string
    category: GithubDiscoverCategory
    sort: GithubSortKey
    order: 'asc' | 'desc'
    page: number
    perPage: number
    language: string
    updated: GithubDiscoverQuery['updated']
    tracked: GithubDiscoverQuery['tracked']
    installerOnly: boolean
    updateStatus: GithubDiscoverQuery['updateStatus']
  },
  token: string | null,
  tracked?: TrackedLookup,
): Promise<GithubDiscoverResult> {
  const query: GithubDiscoverQuery = {
    chart: 'trending',
    platform: params.platform,
    topic: params.topic,
    category: params.category,
    query: params.q,
    language: params.language,
    updated: params.updated,
    tracked: params.tracked,
    installerOnly: params.installerOnly,
    updateStatus: params.updateStatus,
    sort: params.sort,
    order: params.order,
    page: params.page,
    perPage: params.perPage,
  }
  const poolKey = `search|${cacheKey(query, Boolean(token), tracked?.signature)}`
  const resultKey = `${params.page}|${poolKey}`
  const cached = readCache(resultKey)
  if (cached) return cached
  if (!token) {
    const built = buildDiscoverQuery(query)
    const search = await searchRepositoriesByQuery(
      built.q,
      built.sort === 'forks' ? 'forks' : built.sort,
      built.order,
      params.page,
      params.perPage,
      null,
    )
    const result: GithubDiscoverResult = {
      chart: 'trending',
      platform: params.platform,
      topic: params.topic,
      category: 'all',
      query: params.q,
      page: params.page,
      perPage: params.perPage,
      total: search.total,
      hasNext: params.page * params.perPage < search.total,
      items: search.items.map((repo) => ({ repo, release: null })),
      verified: false,
      checked: 0,
    }
    writeCache(resultKey, result)
    return result
  }
  const target = Math.min(params.page * params.perPage + 1, MAX_POOL_ITEMS)
  const pool = await ensurePool(poolKey, query, token, target, tracked)
  const start = (params.page - 1) * params.perPage
  const result: GithubDiscoverResult = {
    chart: 'trending',
    platform: params.platform,
    topic: params.topic,
    category: 'all',
    query: params.q,
    page: params.page,
    perPage: params.perPage,
    total: pool.items.length,
    hasNext: pool.items.length > params.page * params.perPage,
    items: pool.items.slice(start, start + params.perPage),
    verified: true,
    checked: pool.checked,
  }
  writeCache(resultKey, result)
  return result
}
