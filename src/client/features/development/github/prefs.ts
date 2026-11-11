import {
  DEFAULT_GIST_PREFS,
  DEFAULT_GITHUB_MIRRORS,
  DEFAULT_GITHUB_PREFS,
  DEFAULT_STORE_FILTERS,
  type GistListViewMode,
  type GistPrefs,
  type GithubDiscoverCategory,
  type GithubOrder,
  type GithubPlatformFilter,
  type GithubPrefs,
  type GithubSortKey,
  type GithubStoreFilters,
  type GithubTimeRange,
} from '@shared/development/github/types'

const PREFIX = 'inkstone.development.github'
const REPO_PREFS_KEY = `${PREFIX}.prefs`
const MIRROR_KEY = `${PREFIX}.mirror`
const GIST_PREFS_KEY = `${PREFIX}.gist-prefs`
const GIST_VIEW_KEY = `${PREFIX}.gist-view-mode`
const LAYOUT_KEY = `${PREFIX}.layout`
const ACCOUNT_KEY = `${PREFIX}.account`
const SEARCH_HISTORY_KEY = `${PREFIX}.search-history`
const SEARCH_HISTORY_LIMIT = 8
const RECENT_REPOS_KEY = `${PREFIX}.recent-repos`
const RECENT_REPOS_LIMIT = 8
const STORE_KEY = `${PREFIX}.store`

export interface StorePrefs extends GithubStoreFilters {
  platform: GithubPlatformFilter
  category: GithubDiscoverCategory
  sort: GithubSortKey
}

export const DEFAULT_STORE_PREFS: StorePrefs = {
  platform: 'all',
  category: 'all',
  sort: 'stars',
  ...DEFAULT_STORE_FILTERS,
}

const STORE_PLATFORMS: readonly GithubPlatformFilter[] = ['all', 'android', 'windows', 'macos', 'linux']
const STORE_CATEGORIES: readonly GithubDiscoverCategory[] = ['all', 'ai', 'privacy', 'networking', 'media', 'social', 'reading', 'tools']

export interface RecentRepoRef {
  fullName: string
  avatarUrl: string
}

const RANGES: readonly GithubTimeRange[] = ['today', 'week', 'month', 'quarter', 'year', 'all']
const SORTS: readonly GithubSortKey[] = ['stars', 'forks', 'updated', 'best-match']
const ORDERS: readonly GithubOrder[] = ['asc', 'desc']
const GIST_SORTS: readonly GistPrefs['sort'][] = ['updated', 'created', 'files', 'description']

export interface GithubLayoutPrefs {
  sidebarWidth: number
  detailRatio: number
}

export const DEFAULT_LAYOUT_PREFS: GithubLayoutPrefs = {
  sidebarWidth: 240,
  detailRatio: 0.5,
}

function storage(): Storage | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

function readJson(key: string): Record<string, unknown> | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch (error) {
    console.warn('[inkstone] GitHub preference could not be read', key, error)
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('[inkstone] GitHub preference could not be saved', key, error)
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

export function loadRepoPrefs(): GithubPrefs {
  const parsed = readJson(REPO_PREFS_KEY)
  if (!parsed) return { ...DEFAULT_GITHUB_PREFS }
  return {
    range: oneOf(parsed.range, RANGES, DEFAULT_GITHUB_PREFS.range),
    sort: oneOf(parsed.sort, SORTS, DEFAULT_GITHUB_PREFS.sort),
    order: oneOf(parsed.order, ORDERS, DEFAULT_GITHUB_PREFS.order),
    language: typeof parsed.language === 'string' ? parsed.language.slice(0, 64) : DEFAULT_GITHUB_PREFS.language,
  }
}

export function saveRepoPrefs(prefs: GithubPrefs): void {
  writeJson(REPO_PREFS_KEY, prefs)
}

export function loadCurrentMirrorId(): string {
  const store = storage()
  if (!store) return DEFAULT_GITHUB_MIRRORS[0]!.id
  try {
    return store.getItem(MIRROR_KEY) || DEFAULT_GITHUB_MIRRORS[0]!.id
  } catch (error) {
    console.warn('[inkstone] GitHub mirror preference could not be read', error)
    return DEFAULT_GITHUB_MIRRORS[0]!.id
  }
}

export function saveCurrentMirrorId(id: string): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(MIRROR_KEY, id)
  } catch (error) {
    console.warn('[inkstone] GitHub mirror preference could not be saved', error)
  }
}

export function loadGistPrefs(): GistPrefs {
  const parsed = readJson(GIST_PREFS_KEY)
  if (!parsed) return { ...DEFAULT_GIST_PREFS }
  return {
    sort: oneOf(parsed.sort, GIST_SORTS, DEFAULT_GIST_PREFS.sort),
    order: oneOf(parsed.order, ORDERS, DEFAULT_GIST_PREFS.order),
  }
}

export function saveGistPrefs(prefs: GistPrefs): void {
  writeJson(GIST_PREFS_KEY, prefs)
}

export function loadGistViewMode(): GistListViewMode {
  const store = storage()
  if (!store) return 'list'
  try {
    return store.getItem(GIST_VIEW_KEY) === 'card' ? 'card' : 'list'
  } catch (error) {
    console.warn('[inkstone] GitHub gist view preference could not be read', error)
    return 'list'
  }
}

export function saveGistViewMode(mode: GistListViewMode): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(GIST_VIEW_KEY, mode)
  } catch (error) {
    console.warn('[inkstone] GitHub gist view preference could not be saved', error)
  }
}

export function loadLayoutPrefs(): GithubLayoutPrefs {
  const parsed = readJson(LAYOUT_KEY)
  if (!parsed) return { ...DEFAULT_LAYOUT_PREFS }
  return {
    sidebarWidth: boundedNumber(parsed.sidebarWidth, DEFAULT_LAYOUT_PREFS.sidebarWidth, 200, 300),
    detailRatio: boundedNumber(parsed.detailRatio, DEFAULT_LAYOUT_PREFS.detailRatio, 0.3, 0.7),
  }
}

export function saveLayoutPrefs(patch: Partial<GithubLayoutPrefs>): void {
  const previous = loadLayoutPrefs()
  const next: GithubLayoutPrefs = {
    sidebarWidth: boundedNumber(patch.sidebarWidth, previous.sidebarWidth, 200, 300),
    detailRatio: boundedNumber(patch.detailRatio, previous.detailRatio, 0.3, 0.7),
  }
  writeJson(LAYOUT_KEY, next)
}

export function loadActiveAccountId(): string | null {
  const store = storage()
  if (!store) return null
  try {
    return store.getItem(ACCOUNT_KEY) || null
  } catch (error) {
    console.warn('[inkstone] GitHub active account could not be read', error)
    return null
  }
}

export function saveActiveAccountId(id: string | null): void {
  const store = storage()
  if (!store) return
  try {
    if (id) store.setItem(ACCOUNT_KEY, id)
    else store.removeItem(ACCOUNT_KEY)
  } catch (error) {
    console.warn('[inkstone] GitHub active account could not be saved', error)
  }
}

export function loadSearchHistory(): string[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(SEARCH_HISTORY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, SEARCH_HISTORY_LIMIT)
      : []
  } catch (error) {
    console.warn('[inkstone] GitHub search history could not be read', error)
    return []
  }
}

export function saveSearchHistory(entries: readonly string[]): void {
  writeJson(SEARCH_HISTORY_KEY, entries.slice(0, SEARCH_HISTORY_LIMIT))
}

export function loadRecentRepos(): RecentRepoRef[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(RECENT_REPOS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is RecentRepoRef =>
        Boolean(entry)
        && typeof entry === 'object'
        && typeof (entry as RecentRepoRef).fullName === 'string'
        && typeof (entry as RecentRepoRef).avatarUrl === 'string')
      .slice(0, RECENT_REPOS_LIMIT)
  } catch (error) {
    console.warn('[inkstone] GitHub recent repositories could not be read', error)
    return []
  }
}

export function recordRecentRepo(fullName: string, avatarUrl: string): RecentRepoRef[] {
  const normalized = fullName.trim()
  if (!normalized) return loadRecentRepos()
  const next = [
    { fullName: normalized, avatarUrl },
    ...loadRecentRepos().filter((entry) => entry.fullName.toLowerCase() !== normalized.toLowerCase()),
  ].slice(0, RECENT_REPOS_LIMIT)
  writeJson(RECENT_REPOS_KEY, next)
  return next
}

export function clearRecentRepos(): RecentRepoRef[] {
  writeJson(RECENT_REPOS_KEY, [])
  return []
}

export function loadStorePrefs(): StorePrefs {
  const parsed = readJson(STORE_KEY)
  if (!parsed) return { ...DEFAULT_STORE_PREFS }
  return {
    platform: oneOf(parsed.platform, STORE_PLATFORMS, DEFAULT_STORE_PREFS.platform),
    category: oneOf(parsed.category, STORE_CATEGORIES, DEFAULT_STORE_PREFS.category),
    sort: oneOf(parsed.sort, SORTS, DEFAULT_STORE_PREFS.sort),
    language: typeof parsed.language === 'string' ? parsed.language.slice(0, 64) : DEFAULT_STORE_PREFS.language,
    updated: oneOf(parsed.updated, ['any', 'week', 'month', 'year'] as const, DEFAULT_STORE_PREFS.updated),
    tracked: oneOf(parsed.tracked, ['any', 'tracked', 'untracked'] as const, DEFAULT_STORE_PREFS.tracked),
    installerOnly: parsed.installerOnly === true,
    updateStatus: oneOf(parsed.updateStatus, ['any', 'available', 'latest'] as const, DEFAULT_STORE_PREFS.updateStatus),
  }
}

export function saveStorePrefs(prefs: StorePrefs): void {
  writeJson(STORE_KEY, prefs)
}
