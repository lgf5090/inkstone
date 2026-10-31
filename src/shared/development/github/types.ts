import type { MessageKey } from '@shared/locales/en-US'

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

export type GithubWarningSource = 'branches' | 'tags' | 'languages' | 'releases' | 'readme'
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

export interface GithubBootstrap {
  tags: GithubTag[]
  repos: SavedGithubRepo[]
  gistTags: GithubTag[]
  gists: SavedGist[]
  mirrors: GithubMirrorSource[]
  accounts: GithubAccountView[]
  capabilities: GithubCapabilities
}
