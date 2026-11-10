import {
  DISCOVER_CACHE_TTL_MS,
  DISCOVER_VERIFY_LIMIT,
  GITHUB_DETAIL_TIMEOUT_MS,
} from '@shared/development/github/limits'
import { assetPlatform, pickReleaseAsset, releasePlatforms } from '@shared/development/github/platforms'
import type {
  GithubDiscoverItem,
  GithubDiscoverQuery,
  GithubDiscoverRelease,
  GithubDiscoverResult,
  GithubRelease,
  GithubReleaseAsset,
} from '@shared/development/github/types'
import { githubJson } from './github-http'
import { normalizeLatestStableRelease, searchRepositoriesByQuery } from './github-repos'

const DAY_MS = 24 * 60 * 60 * 1000
const VERIFY_CONCURRENCY = 4
const MAX_CACHE_ENTRIES = 24

interface CachedDiscover {
  value: GithubDiscoverResult
  expiresAt: number
}

const cache = new Map<string, CachedDiscover>()

function cacheKey(query: GithubDiscoverQuery, authenticated: boolean): string {
  return [
    query.chart,
    query.platform,
    query.topic,
    query.page,
    query.perPage,
    authenticated ? 'auth' : 'anon',
  ].join('|')
}

function readCache(key: string): GithubDiscoverResult | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function writeCache(key: string, value: GithubDiscoverResult): void {
  cache.delete(key)
  cache.set(key, { value, expiresAt: Date.now() + DISCOVER_CACHE_TTL_MS })
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function dayString(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function daysAgo(now: Date, days: number): string {
  return dayString(new Date(now.getTime() - days * DAY_MS))
}

export function buildDiscoverQuery(
  query: GithubDiscoverQuery,
  now = new Date(),
): { q: string; sort: 'stars' | 'updated'; order: 'asc' | 'desc' } {
  const parts: string[] = ['fork:false', 'archived:false']
  if (query.chart === 'trending') {
    parts.push('stars:>50', `pushed:>=${daysAgo(now, 30)}`)
  } else if (query.chart === 'releases') {
    parts.push('stars:>10', `pushed:>=${daysAgo(now, 14)}`)
  } else {
    parts.push('stars:>1000', `created:<=${daysAgo(now, 180)}`, `pushed:>=${daysAgo(now, 365)}`)
  }
  if (query.platform !== 'all') {
    parts.push(`topic:${query.platform === 'android' ? 'android' : 'desktop'}`)
  }
  if (query.topic) parts.push(`topic:${query.topic}`)
  return {
    q: parts.join(' '),
    sort: query.chart === 'releases' ? 'updated' : 'stars',
    order: 'desc',
  }
}

function toDiscoverRelease(
  release: GithubRelease,
  platform: GithubDiscoverQuery['platform'],
): GithubDiscoverRelease {
  const platforms = releasePlatforms(release.assets.map((asset) => asset.name))
  const recommended: GithubReleaseAsset | null = platform === 'all'
    ? release.assets.find((asset) => assetPlatform(asset.name) !== null) ?? release.assets[0] ?? null
    : pickReleaseAsset(release.assets, platform)
  return {
    tagName: release.tagName,
    name: release.name,
    publishedAt: release.publishedAt,
    htmlUrl: release.htmlUrl,
    assetCount: release.assets.length,
    downloadCount: release.assets.reduce((sum, asset) => sum + asset.downloadCount, 0),
    platforms,
    recommendedAsset: recommended,
  }
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
): Promise<GithubDiscoverItem> {
  const parsed = item.repo.fullName.split('/')
  if (parsed.length !== 2) return item
  try {
    const { data } = await githubJson<unknown[]>(
      `/repos/${encodeURIComponent(parsed[0]!)}/${encodeURIComponent(parsed[1]!)}/releases?per_page=5`,
      { token, timeoutMs: GITHUB_DETAIL_TIMEOUT_MS },
    )
    const release = normalizeLatestStableRelease(Array.isArray(data) ? data : [])
    return { ...item, release: release ? toDiscoverRelease(release, platform) : null }
  } catch (error) {
    console.warn('[inkstone] GitHub release verification failed for', item.repo.fullName, error)
    return item
  }
}

function keepsItem(item: GithubDiscoverItem, query: GithubDiscoverQuery, verified: boolean): boolean {
  if (!verified) return true
  if (query.platform !== 'all' && !item.release?.recommendedAsset) return false
  if (query.chart === 'releases' && !item.release) return false
  return true
}

export async function discoverRepositories(
  query: GithubDiscoverQuery,
  token: string | null,
): Promise<GithubDiscoverResult> {
  const key = cacheKey(query, Boolean(token))
  const cached = readCache(key)
  if (cached) return cached

  const built = buildDiscoverQuery(query)
  const search = await searchRepositoriesByQuery(
    built.q,
    built.sort,
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
    ? await mapWithConcurrency(head, VERIFY_CONCURRENCY, (item) => verifyItem(item, query.platform, token))
    : []
  const items = [...checkedItems, ...tail].filter((item) => keepsItem(item, query, verified))
  const result: GithubDiscoverResult = {
    chart: query.chart,
    platform: query.platform,
    topic: query.topic,
    page: query.page,
    perPage: query.perPage,
    total: search.total,
    items,
    verified,
    checked: checkedItems.length,
  }
  writeCache(key, result)
  return result
}
