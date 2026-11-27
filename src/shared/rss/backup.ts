import { normaliseEntry, parseRssLibrary, RSS_LIMITS, type RssEntry, type RssLibrary } from './model'

export const RSS_BACKUP_TYPE = 'inkstone-rss-library'
export const RSS_BACKUP_VERSION = 2 as const
export const RSS_BACKUP_MAX_BYTES = 10 * 1024 * 1024
export const RSS_BACKUP_MAX_ARTICLES = RSS_LIMITS.feeds * RSS_LIMITS.entriesPerFeed

export interface RssBackup {
  type: typeof RSS_BACKUP_TYPE
  version: 1 | typeof RSS_BACKUP_VERSION
  exportedAt: string
  library: RssLibrary
  articles: RssEntry[]
  includesContent: boolean
}

export interface RssBackupOptions {
  includeContent?: boolean
  exportedAt?: string
}

const encoder = new TextEncoder()

export function rssBackupByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

export function assertRssBackupByteLength(value: unknown): void {
  if (rssBackupByteLength(value) > RSS_BACKUP_MAX_BYTES) {
    throw new Error('The RSS backup exceeds the 10 MB limit')
  }
}

export function exportRssBackup(library: RssLibrary, articles: readonly RssEntry[], options: RssBackupOptions = {}): string {
  const includeContent = options.includeContent === true
  const carried = articles.map((entry) => includeContent ? { ...entry } : { ...entry, content: '' })
  const value: RssBackup = {
    type: RSS_BACKUP_TYPE,
    version: RSS_BACKUP_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    library,
    articles: carried,
    includesContent: includeContent,
  }
  assertRssBackupByteLength(value)
  if (!parseRssBackupValue(value)) throw new Error('The RSS backup contains invalid article metadata')
  return JSON.stringify(value)
}

export function parseRssBackup(text: string): RssBackup | null {
  if (encoder.encode(text).byteLength > RSS_BACKUP_MAX_BYTES) return null
  try {
    return parseRssBackupValue(JSON.parse(text) as unknown)
  }
  catch {
    return null
  }
}

export function parseRssBackupValue(value: unknown): RssBackup | null {
  if (!isRecord(value) || value.type !== RSS_BACKUP_TYPE) return null
  if (rssBackupByteLength(value) > RSS_BACKUP_MAX_BYTES) return null
  if (value.version !== 1 && value.version !== RSS_BACKUP_VERSION) return null
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) return null
  const parsedLibrary = parseRssLibrary(value.library)
  if (!parsedLibrary.data || parsedLibrary.dropped > 0 || parsedLibrary.truncated) return null
  if (value.version === 1) {
    return {
      type: RSS_BACKUP_TYPE,
      version: 1,
      exportedAt: value.exportedAt,
      library: parsedLibrary.data,
      articles: [],
      includesContent: false,
    }
  }
  if (!Array.isArray(value.articles) || typeof value.includesContent !== 'boolean') return null
  if (value.articles.length > RSS_BACKUP_MAX_ARTICLES) return null
  const feedIds = new Set(parsedLibrary.data.feeds.map(feed => feed.id))
  const entryIds = new Set<string>()
  const perFeed = new Map<string, number>()
  const articles: RssEntry[] = []
  for (const raw of value.articles) {
    if (!isRecord(raw) || typeof raw.feedId !== 'string' || !feedIds.has(raw.feedId)) return null
    const entry = strictEntry(raw, raw.feedId, value.includesContent)
    if (!entry || entryIds.has(entry.id)) return null
    entryIds.add(entry.id)
    const count = (perFeed.get(entry.feedId) ?? 0) + 1
    if (count > RSS_LIMITS.entriesPerFeed) return null
    perFeed.set(entry.feedId, count)
    articles.push(entry)
  }
  return {
    type: RSS_BACKUP_TYPE,
    version: RSS_BACKUP_VERSION,
    exportedAt: value.exportedAt,
    library: parsedLibrary.data,
    articles,
    includesContent: value.includesContent,
  }
}

function strictEntry(value: Record<string, unknown>, feedId: string, includesContent: boolean): RssEntry | null {
  if (typeof value.id !== 'string' || !value.id || value.id.length > 80) return null
  for (const field of ['title', 'link', 'author', 'summary', 'imageUrl', 'audioUrl'] as const) {
    if (typeof value[field] !== 'string') return null
  }
  if (value.publishedTs !== null && !isInteger(value.publishedTs)) return null
  for (const field of ['duration', 'episode', 'season'] as const) {
    if (value[field] !== undefined && (!isInteger(value[field]) || value[field] < 0)) return null
  }
  if (value.fetchedAt !== undefined && (!isInteger(value.fetchedAt) || value.fetchedAt < 0)) return null
  if (value.contentReleased !== undefined && typeof value.contentReleased !== 'boolean') return null
  if (includesContent) {
    if (typeof value.content !== 'string') return null
  }
  else if (value.content !== undefined && value.content !== '') return null
  const entry = normaliseEntry(value, feedId)
  if (!entry) return null
  for (const field of ['id', 'title', 'link', 'author', 'summary', 'imageUrl', 'audioUrl'] as const) {
    if (value[field] !== entry[field]) return null
  }
  if (includesContent && value.content !== entry.content) return null
  if (value.contentReleased === true && entry.content) return null
  return entry
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
