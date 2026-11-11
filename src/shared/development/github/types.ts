import type { MessageKey } from '@shared/locales/en-US'
import type { GithubAssetPlatform, GithubPlatformFilter } from './platforms'

export type { GithubAssetPlatform, GithubPlatformFilter, GithubUpdateState } from './platforms'

export interface GithubRepo {
  id: number
  name: string
  fullName: string
  url: string
  description: string | null
  homepage: string | null
  owner: { login: string; avatarUrl: string }
  language: string | null
  stargazersCount: number
  forksCount: number
  openIssuesCount: number
  topics: string[]
  license: string | null
  isArchived: boolean
  createdAt: string
  updatedAt: string
  defaultBranch: string
  size: number
}

export interface GithubTag {
  id: string
  name: string
  color: string
  parentId: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SavedGithubRepo {
  id: string
  fullName: string
  url: string
  data: GithubRepo
  tagIds: string[]
  pinned: boolean
  favorited: boolean
  notes: string
  createdAt: number
  updatedAt: number
}

export interface GithubMirrorSource {
  id: string
  name: string
  url: string
  enabled: boolean
  createdAt: number
}

export interface GithubMirrorProbeResult {
  id: string
  ok: boolean
  status: number
  latencyMs: number | null
  error: '' | 'timeout' | 'blocked' | 'http' | 'network'
}

export interface GithubCollection {
  id: string
  name: string
  description: string
  parentId: string | null
  repoIds: string[]
  createdAt: number
  updatedAt: number
}

export interface GithubAccountView {
  id: string
  username: string
  avatarUrl: string
  createdAt: number
  updatedAt: number
  gistScope?: boolean | null
}

export const DEFAULT_GITHUB_MIRRORS: GithubMirrorSource[] = [
  { id: 'gh-proxy', name: 'gh-proxy', url: 'https://gh-proxy.com', enabled: true, createdAt: 0 },
]

export interface GithubReleaseAsset {
  id: number
  name: string
  label: string | null
  contentType: string
  size: number
  downloadUrl: string
  downloadCount: number
}

export interface GithubRelease {
  id: number
  tagName: string
  name: string | null
  isPrerelease: boolean
  isLatest: boolean
  publishedAt: string
  htmlUrl: string
  body: string | null
  assets: GithubReleaseAsset[]
}

export interface GithubCommitAuthor {
  login: string
  name: string
  avatarUrl: string
}

export interface GithubCommit {
  sha: string
  message: string
  author: GithubCommitAuthor | null
  date: string
  url: string
}

export type GithubWarningSource = 'branches' | 'tags' | 'languages' | 'releases' | 'readme' | 'commits'
export type GithubWarningCode = 'rate_limited' | 'not_found' | 'upstream'
export type GithubRepoDetailPart = GithubWarningSource

export interface GithubWarning {
  source: GithubWarningSource
  code: GithubWarningCode
  message: string
}

export interface GithubRepoDetail {
  fullName: string
  branchesCount: number
  branchesTruncated: boolean
  defaultBranch: string
  tagsCount: number
  tagsTruncated: boolean
  languages: { name: string; bytes: number; percentage: number }[]
  releases: GithubRelease[]
  releasesTruncated: boolean
  branchNames: string[]
  tagNames: string[]
  commits: GithubCommit[]
  readme: string | null
  readmeHtmlUrl: string | null
  warnings: GithubWarning[]
  rateLimited: boolean
  loaded?: GithubRepoDetailPart[]
}

export type GithubTimeRange = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'all'
export type GithubSortKey = 'stars' | 'forks' | 'updated' | 'best-match'
export type GithubOrder = 'desc' | 'asc'
export type GithubViewId = 'explore' | 'all' | 'pinned' | 'favorited' | string

export const GITHUB_EXPLORE_VIEW = 'explore'
export const GITHUB_ALL_VIEW = 'all'
export const GITHUB_PINNED_VIEW = 'pinned'
export const GITHUB_FAV_VIEW = 'favorited'
export const GITHUB_PER_PAGE = 25
export const GIST_REMOTE_PER_PAGE = 30
export const GITHUB_COLLECTION_VIEW_PREFIX = 'collection:'

export interface GithubPrefs {
  range: GithubTimeRange
  sort: GithubSortKey
  order: GithubOrder
  language: string
}

export const DEFAULT_GITHUB_PREFS: GithubPrefs = {
  range: 'today',
  sort: 'stars',
  order: 'desc',
  language: '',
}

export const GITHUB_RANGE_OPTIONS: { value: GithubTimeRange; labelKey: MessageKey }[] = [
  { value: 'today', labelKey: 'development.github.repos.range.today' },
  { value: 'week', labelKey: 'development.github.repos.range.week' },
  { value: 'month', labelKey: 'development.github.repos.range.month' },
  { value: 'quarter', labelKey: 'development.github.repos.range.quarter' },
  { value: 'year', labelKey: 'development.github.repos.range.year' },
  { value: 'all', labelKey: 'development.github.repos.range.all' },
]

export const GITHUB_SORT_OPTIONS: { value: GithubSortKey; labelKey: MessageKey }[] = [
  { value: 'stars', labelKey: 'development.github.repos.sort.stars' },
  { value: 'forks', labelKey: 'development.github.repos.sort.forks' },
  { value: 'updated', labelKey: 'development.github.repos.sort.updated' },
  { value: 'best-match', labelKey: 'development.github.repos.sort.best_match' },
]

export interface GithubSearchParams {
  q: string
  range: GithubTimeRange
  sort: GithubSortKey
  order: GithubOrder
  language: string
  perPage: number
  page: number
}

export interface GithubSearchResult {
  total: number
  items: GithubRepo[]
}

export interface GistFile {
  filename: string
  language: string | null
  content: string
  size: number
  preview?: string | null
  truncated?: boolean
}

export type GistFilePatch = { content: string; filename?: string } | null
export type GistFilesPatch = Record<string, GistFilePatch>

export interface GistMetaPatch {
  description?: string
  tagIds?: string[]
  pinned?: boolean
  favorited?: boolean
  notes?: string
}

export interface GistItem {
  id: string
  description: string
  url: string
  isPublic: boolean
  owner: { login: string; avatarUrl: string } | null
  files: GistFile[]
  fileCount: number
  createdAt: string
  updatedAt: string
}

export interface SavedGist {
  id: string
  description: string
  url: string
  data: GistItem
  tagIds: string[]
  pinned: boolean
  favorited: boolean
  notes: string
  createdAt: number
  updatedAt: number
}

export type GistViewId = 'all' | 'pinned' | 'favorited' | 'explore' | 'my-github' | string

export const GIST_ALL_VIEW = 'all'
export const GIST_PINNED_VIEW = 'pinned'
export const GIST_FAV_VIEW = 'favorited'
export const GIST_EXPLORE_VIEW = 'explore'
export const GIST_MY_GITHUB_VIEW = 'my-github'

export function isRemoteView(view: GistViewId): boolean {
  return view === GIST_EXPLORE_VIEW || view === GIST_MY_GITHUB_VIEW || view.startsWith('user:')
}

export function extractUsernameFromView(view: GistViewId): string | null {
  return view.startsWith('user:') ? view.slice(5) || null : null
}

export type GistListViewMode = 'list' | 'card'

export interface GistPrefs {
  sort: 'updated' | 'created' | 'files' | 'description'
  order: 'desc' | 'asc'
}

export const DEFAULT_GIST_PREFS: GistPrefs = { sort: 'updated', order: 'desc' }

export const GIST_SORT_OPTIONS: { value: GistPrefs['sort']; labelKey: MessageKey }[] = [
  { value: 'updated', labelKey: 'development.github.gists.sort.updated' },
  { value: 'created', labelKey: 'development.github.gists.sort.created' },
  { value: 'files', labelKey: 'development.github.gists.sort.files' },
  { value: 'description', labelKey: 'development.github.gists.sort.description' },
]

export interface GistBatchPatch {
  pinned?: boolean
  favorited?: boolean
  addTagIds?: string[]
  removeTagIds?: string[]
}

export interface RepoBatchPatch {
  pinned?: boolean
  favorited?: boolean
  addTagIds?: string[]
  removeTagIds?: string[]
}

export interface GistListResult {
  items: GistItem[]
  page: number
  perPage: number
  hasNext: boolean
}

export type GithubExportFormat = 'json' | 'md' | 'txt'

export interface GithubExportFile {
  id: string
  filename: string
  format: GithubExportFormat
  size: number
  url: string
  createdAt: number
}

export interface GithubCapabilities {
  exports: boolean
}

export interface GithubBootstrapCounts {
  repos: number
  gists: number
}

export interface GithubBootstrapTruncation {
  repos: boolean
  gists: boolean
}

export interface GithubBootstrap {
  tags: GithubTag[]
  repos: SavedGithubRepo[]
  collections: GithubCollection[]
  gistTags: GithubTag[]
  gists: SavedGist[]
  mirrors: GithubMirrorSource[]
  accounts: GithubAccountView[]
  apps: GithubTrackedApp[]
  capabilities: GithubCapabilities
  counts?: GithubBootstrapCounts
  truncated?: GithubBootstrapTruncation
}

export type GithubDiscoverChart = 'trending' | 'releases' | 'popular'
export type GithubDiscoverCategory = 'all' | 'ai' | 'privacy' | 'networking' | 'media' | 'social' | 'reading' | 'tools'
export type GithubUpdatedRange = 'any' | 'week' | 'month' | 'year'
export type GithubTrackedFilter = 'any' | 'tracked' | 'untracked'
export type GithubUpdateFilter = 'any' | 'available' | 'latest'

export interface GithubStoreFilters {
  language: string
  updated: GithubUpdatedRange
  tracked: GithubTrackedFilter
  installerOnly: boolean
  updateStatus: GithubUpdateFilter
}

export const DEFAULT_STORE_FILTERS: GithubStoreFilters = {
  language: '',
  updated: 'any',
  tracked: 'any',
  installerOnly: false,
  updateStatus: 'any',
}

export interface GithubDiscoverQuery extends GithubStoreFilters {
  chart: GithubDiscoverChart
  platform: GithubPlatformFilter
  topic: string
  category: GithubDiscoverCategory
  query: string
  sort: GithubSortKey
  order: GithubOrder
  page: number
  perPage: number
}

export interface GithubDiscoverRelease {
  tagName: string
  name: string | null
  publishedAt: string
  htmlUrl: string
  assetCount: number
  downloadCount: number
  platforms: GithubAssetPlatform[]
  recommendedAsset: GithubReleaseAsset | null
}

export interface GithubDiscoverItem {
  repo: GithubRepo
  release: GithubDiscoverRelease | null
}

export interface GithubDiscoverResult {
  chart: GithubDiscoverChart
  platform: GithubPlatformFilter
  topic: string
  category: GithubDiscoverCategory
  query: string
  page: number
  perPage: number
  total: number
  hasNext: boolean
  items: GithubDiscoverItem[]
  verified: boolean
  checked: number
}

export interface GithubTrackedApp {
  id: string
  repoId: string
  fullName: string
  repoUrl: string
  ownerAvatarUrl: string
  platform: GithubAssetPlatform
  assetPattern: string
  installedTag: string
  installedAt: number
  updateCheckEnabled: boolean
  skippedTag: string
  latestTag: string
  latestAssetName: string
  latestAssetUrl: string
  latestPublishedAt: string
  checkedAt: number
  createdAt: number
  updatedAt: number
}

export interface GithubAppsCheckFailure {
  id: string
  message: string
}

export interface GithubAppsCheckResult {
  apps: GithubTrackedApp[]
  checked: number
  failed: GithubAppsCheckFailure[]
}

export interface GithubDevProfile {
  login: string
  name: string | null
  avatarUrl: string
  bio: string | null
  company: string | null
  location: string | null
  blog: string | null
  htmlUrl: string
  followers: number
  following: number
  publicRepos: number
  createdAt: string
  repos: GithubRepo[]
}

export const GITHUB_DISCOVER_PER_PAGE = 20
export const GITHUB_DISCOVER_MAX_PAGE = 20

export const GITHUB_DISCOVER_CHARTS: { value: GithubDiscoverChart; labelKey: MessageKey }[] = [
  { value: 'trending', labelKey: 'development.github.store.chart.trending' },
  { value: 'releases', labelKey: 'development.github.store.chart.releases' },
  { value: 'popular', labelKey: 'development.github.store.chart.popular' },
]

export const GITHUB_DISCOVER_CATEGORIES: {
  value: GithubDiscoverCategory
  labelKey: MessageKey
  topics: readonly string[]
  queryTopic: string | null
}[] = [
  { value: 'all', labelKey: 'development.github.store.category.all', topics: [], queryTopic: null },
  { value: 'ai', labelKey: 'development.github.store.category.ai', topics: ['ai'], queryTopic: 'ai' },
  { value: 'privacy', labelKey: 'development.github.store.category.privacy', topics: ['privacy', 'security', 'encryption', 'vpn'], queryTopic: 'privacy' },
  { value: 'networking', labelKey: 'development.github.store.category.networking', topics: ['networking', 'browser', 'messaging', 'proxy', 'dns'], queryTopic: 'networking' },
  { value: 'media', labelKey: 'development.github.store.category.media', topics: ['audio', 'video', 'photo', 'media', 'music'], queryTopic: 'media' },
  { value: 'social', labelKey: 'development.github.store.category.social', topics: ['social'], queryTopic: 'social' },
  { value: 'reading', labelKey: 'development.github.store.category.reading', topics: ['reader', 'notes', 'markdown'], queryTopic: 'reader' },
  { value: 'tools', labelKey: 'development.github.store.category.tools', topics: ['launcher', 'backup', 'self-hosted', 'developer-tools', 'cli'], queryTopic: 'self-hosted' },
]

export const GITHUB_UPDATED_OPTIONS: { value: GithubUpdatedRange; labelKey: MessageKey }[] = [
  { value: 'any', labelKey: 'development.github.store.updated.any' },
  { value: 'week', labelKey: 'development.github.store.updated.week' },
  { value: 'month', labelKey: 'development.github.store.updated.month' },
  { value: 'year', labelKey: 'development.github.store.updated.year' },
]

export const GITHUB_TRACKED_OPTIONS: { value: GithubTrackedFilter; labelKey: MessageKey }[] = [
  { value: 'any', labelKey: 'development.github.store.tracked.any' },
  { value: 'tracked', labelKey: 'development.github.store.tracked.only' },
  { value: 'untracked', labelKey: 'development.github.store.tracked.none' },
]

export const GITHUB_UPDATE_FILTER_OPTIONS: { value: GithubUpdateFilter; labelKey: MessageKey }[] = [
  { value: 'any', labelKey: 'development.github.store.update_status.any' },
  { value: 'available', labelKey: 'development.github.store.update_status.available' },
  { value: 'latest', labelKey: 'development.github.store.update_status.latest' },
]

export const GITHUB_DISCOVER_TOPICS: { value: string; labelKey: MessageKey }[] = [
  { value: 'android', labelKey: 'development.github.store.topic.android' },
  { value: 'desktop', labelKey: 'development.github.store.topic.desktop' },
  { value: 'macos', labelKey: 'development.github.store.topic.macos' },
  { value: 'linux', labelKey: 'development.github.store.topic.linux' },
  { value: 'cli', labelKey: 'development.github.store.topic.cli' },
  { value: 'self-hosted', labelKey: 'development.github.store.topic.self_hosted' },
  { value: 'developer-tools', labelKey: 'development.github.store.topic.developer_tools' },
]

