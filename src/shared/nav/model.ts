export const NAV_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export const NAV_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/

export const NAV_LIMITS = {
  title: 200,
  url: 2048,
  description: 500,
  categoryName: 60,
  searchSourceName: 40,
  searchSources: 20,
  iconBytes: 1024 * 1024,
  capturedIconBytes: 512 * 1024,
  iconDimension: 4096,
  recentLinks: 100,
  frequentLinks: 100,
  checkBatch: 10,
  importLinksPerRequest: 200,
  importMaxLinks: 20000,
  restoreBytes: 20 * 1024 * 1024,
  unlockTokens: 20,
  visitsPerRequest: 200,
} as const

export type NavCardStyle = 'detailed' | 'simple'
export type NavSearchMode = 'internal' | 'external'
export type NavPasswordMode = 'none' | 'custom' | 'default'

export interface NavCategory {
  id: string
  name: string
  icon: string
  parentId: string | null
  hasPassword: boolean
  passwordMode: NavPasswordMode
  sortOrder: number
  createdAt: number
}

export interface NavLink {
  id: string
  title: string
  url: string
  icon: string | null
  description: string | null
  categoryId: string
  pinned: boolean
  pinnedOrder: number
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface NavVisit {
  lastVisitedAt: number
  visitCount: number
}

export interface NavDisplaySettings {
  navTitle: string
  cardStyle: NavCardStyle
  recentLinksCount: number
  frequentLinksCount: number
  autoFetchIcon: boolean
}

export interface NavSearchSource {
  id: string
  name: string
  url: string
  icon: string | null
  enabled: boolean
  createdAt: number
}

export interface NavSearchSettings {
  mode: NavSearchMode
  sources: NavSearchSource[]
  selectedSourceId: string | null
}

export interface NavAiSettings {
  modelId: string
}

export interface NavWebdavSettings {
  url: string
  username: string
  hasPassword: boolean
}

export type NavBackupSchedule = 'off' | 'hourly' | 'sixHourly' | 'daily' | 'weekly'

export interface NavBackupState {
  schedule: NavBackupSchedule
  retention: number
  lastRunAt: number | null
  lastStatus: 'success' | 'failed' | null
  lastError: string | null
  lastFilename: string | null
  history: string[]
}

export const DEFAULT_NAV_BACKUP_STATE: NavBackupState = {
  schedule: 'off',
  retention: 0,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastFilename: null,
  history: [],
}

export type NavBackupConfig = NavWebdavSettings & NavBackupState

export interface NavSettings {
  display: NavDisplaySettings
  search: NavSearchSettings
  ai: NavAiSettings
}

export interface NavCounts {
  total: number
  byCategory: Record<string, number>
}

export interface NavBootstrap {
  categories: NavCategory[]
  links: NavLink[]
  visits: Record<string, NavVisit>
  settings: NavSettings
  webdav: NavWebdavSettings
  counts: NavCounts
  serverTime: number
}

export interface NavImportCategory {
  id: string
  name: string
  icon: string
  parentId: string | null
  sortOrder: number
  createdAt: number
}

export interface NavImportLink {
  id: string
  title: string
  url: string
  icon: string | null
  description: string | null
  categoryId: string
  pinned: boolean
  pinnedOrder: number
  sortOrder: number
  createdAt: number
}

export interface NavBackup {
  format: 'inkstone-nav-backup'
  version: 1
  createdAt: number
  categories: Array<NavImportCategory & { hasPassword: boolean; passwordMode: NavPasswordMode }>
  links: NavImportLink[]
  visits: Record<string, NavVisit>
  settings: NavSettings
}

export type NavCheckLevel = 'ok' | 'warning' | 'broken' | 'skipped'
export type NavCheckError =
  | 'timeout'
  | 'network'
  | 'blocked_target'
  | 'invalid_url'
  | 'too_many_redirects'
  | 'http_error'

export interface NavCheckResult {
  url: string
  status: number | null
  ok: boolean
  level: NavCheckLevel
  durationMs: number
  errorCode?: NavCheckError
  finalUrl?: string
}

export const DEFAULT_NAV_DISPLAY: NavDisplaySettings = {
  navTitle: '',
  cardStyle: 'detailed',
  recentLinksCount: 10,
  frequentLinksCount: 10,
  autoFetchIcon: true,
}

export const DEFAULT_NAV_SEARCH_SOURCES: readonly NavSearchSource[] = [
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'baidu', name: 'Baidu', url: 'https://www.baidu.com/s?wd={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'sogou', name: 'Sogou', url: 'https://www.sogou.com/web?query={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'yandex', name: 'Yandex', url: 'https://yandex.com/search/?text={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'github', name: 'GitHub', url: 'https://github.com/search?q={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'linuxdo', name: 'Linux.do', url: 'https://linux.do/search?q={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'bilibili', name: 'Bilibili', url: 'https://search.bilibili.com/all?keyword={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/results?search_query={query}', icon: null, enabled: true, createdAt: 0 },
  { id: 'wikipedia', name: 'Wikipedia', url: 'https://zh.wikipedia.org/wiki/Special:Search?search={query}', icon: null, enabled: true, createdAt: 0 },
]

export const DEFAULT_NAV_SEARCH: NavSearchSettings = {
  mode: 'internal',
  sources: [...DEFAULT_NAV_SEARCH_SOURCES],
  selectedSourceId: null,
}

export const DEFAULT_NAV_AI: NavAiSettings = { modelId: '' }

export const DEFAULT_NAV_SETTINGS: NavSettings = {
  display: { ...DEFAULT_NAV_DISPLAY },
  search: { ...DEFAULT_NAV_SEARCH, sources: [...DEFAULT_NAV_SEARCH.sources] },
  ai: { ...DEFAULT_NAV_AI },
}

export function newNavId(): string {
  let n = Date.now()
  let stamp = ''
  for (let i = 0; i < 10; i += 1) {
    stamp = NAV_ID_ALPHABET[n % NAV_ID_ALPHABET.length] + stamp
    n = Math.floor(n / NAV_ID_ALPHABET.length)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let suffix = ''
  for (let i = 0; i < bytes.length; i += 1) suffix += NAV_ID_ALPHABET[bytes[i]! % NAV_ID_ALPHABET.length]
  return stamp + suffix
}

export function isNavId(value: unknown): value is string {
  return typeof value === 'string' && NAV_ID_PATTERN.test(value)
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** A URL a bookmark may store, or null. Mail and phone links are kept but never fetched. */
export function normalizeLinkUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const match = SCHEME.exec(value)
  const scheme = match?.[1]?.toLowerCase()
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    || scheme === 'http'
    || scheme === 'https'
    || scheme === 'mailto'
    || scheme === 'tel'
  const candidate = absolute ? value : `https://${value}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  const protocol = url.protocol.toLowerCase()
  if (protocol === 'http:' || protocol === 'https:') {
    if (url.username || url.password) return null
    if (!url.hostname) return null
    return url.toString()
  }
  if (protocol === 'mailto:' || protocol === 'tel:') {
    if (candidate.length > NAV_LIMITS.url) return null
    return candidate
  }
  return null
}

export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isSafeIconValue(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const value = raw.trim()
  if (!value) return true
  if (/^\/api\/nav\/icons\/[0-9a-hjkmnp-tv-z]{26}$/.test(value)) return true
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

export function isEmojiIcon(raw: string): boolean {
  return /[^\x00-\x7F]/.test(raw) && !/^lucide:/.test(raw)
}

export function normalizeIconName(raw: string): string {
  const value = raw.trim()
  if (!value) return 'folder'
  if (isEmojiIcon(value)) return value
  return value
    .replace(/^lucide:/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
}

export function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

export function extractDomain(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    return url.hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function initialFor(title: string, url: string): string {
  const target = (title || extractDomain(url) || '?').trim()
  const first = Array.from(target)[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

const AVATAR_COLORS = [
  'bg-blue-600 text-white',
  'bg-emerald-600 text-white',
  'bg-amber-600 text-white',
  'bg-violet-600 text-white',
  'bg-rose-600 text-white',
  'bg-indigo-600 text-white',
  'bg-cyan-600 text-white',
  'bg-teal-600 text-white',
  'bg-fuchsia-600 text-white',
]

export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!
}

export function normalizeSearchSource(raw: {
  id?: unknown
  name?: unknown
  url?: unknown
  icon?: unknown
  enabled?: unknown
  createdAt?: unknown
}): NavSearchSource | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!name || name.length > NAV_LIMITS.searchSourceName) return null
  if (!url.includes('{query}') || !isHttpUrl(url)) return null
  const icon = typeof raw.icon === 'string' && raw.icon.trim() && isSafeIconValue(raw.icon.trim()) ? raw.icon.trim() : null
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : newNavId()
  return {
    id,
    name,
    url,
    icon,
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

export function buildSearchUrl(source: Pick<NavSearchSource, 'url'>, query: string): string | null {
  const q = query.trim()
  if (!q) return null
  const encoded = encodeURIComponent(q)
  const target = source.url.split('{query}').join(encoded)
  return isHttpUrl(target) ? target : null
}

export function linkMatchesQuery(link: Pick<NavLink, 'title' | 'description' | 'url'>, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return link.title.toLowerCase().includes(q)
    || (link.description ?? '').toLowerCase().includes(q)
    || link.url.toLowerCase().includes(q)
}

export function normalizeVisits(raw: unknown): Record<string, NavVisit> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, NavVisit> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNavId(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as { lastVisitedAt?: unknown; visitCount?: unknown }
    if (typeof row.lastVisitedAt !== 'number' || typeof row.visitCount !== 'number') continue
    if (!Number.isFinite(row.lastVisitedAt) || !Number.isFinite(row.visitCount)) continue
    out[id] = { lastVisitedAt: Math.max(0, Math.floor(row.lastVisitedAt)), visitCount: Math.max(0, Math.floor(row.visitCount)) }
  }
  return out
}
