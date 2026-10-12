/**
 * The reader's data model, shared by the client store, the Worker route that stores it and the
 * tests that judge both.
 *
 * Two rules shape everything below. The library is the only thing that crosses the network, so it
 * stays small and rebuildable: article bodies are cached per device and are deliberately *not*
 * carried in it, which keeps a save at a few kilobytes instead of a few megabytes. And because the
 * library arrives from storage a reader (or an old backup) may have edited, nothing is trusted:
 * every record is re-built field by field inside an explicit ceiling, and whatever does not fit is
 * counted as dropped rather than silently kept.
 */

import { isUsableTagName, sortTagNames, tagKey } from '../markdown-utils'
import type { Folder } from '../types'

/** 2 added nested folders, per-feed tags and the hidden list. */
export const RSS_LIBRARY_VERSION = 2

export const RSS_LIMITS = {
  feeds: 400,
  groups: 80,
  /** How deep a subscription folder may nest. The note folders allow more; a sidebar does not. */
  groupDepthMax: 8,
  tagsPerFeed: 24,
  tagChars: 120,
  hiddenIds: 2000,
  entriesPerFeed: 60,
  feedBytes: 240 * 1024,
  /** What one device keeps in its local cache, across every feed. */
  cacheBytes: 24 * 1024 * 1024,
  titleChars: 300,
  summaryChars: 600,
  contentChars: 100_000,
  urlChars: 2000,
  nameChars: 200,
  groupChars: 100,
  errorChars: 240,
  readIds: 5000,
  favorites: 1000,
  readLater: 2000,
  openedRecords: 3000,
  savedNotes: 2000,
  /** What one `PUT /api/rss/library` body may hold, counted in UTF-16 units. */
  payloadChars: 900_000,
} as const

export interface RssEntry {
  id: string
  feedId: string
  title: string
  link: string
  author: string
  publishedTs: number | null
  summary: string
  /** Feed HTML, already run through the sanitizer. Empty means the source only offers a summary. */
  content: string
  imageUrl: string
  audioUrl: string
}

export interface RssFeed {
  id: string
  url: string
  title: string
  siteUrl: string
  imageUrl: string
  groupId: string
  /** Hierarchical tag names, `/`-joined, the same shape the note tags use. */
  tags: string[]
  order: number
  updatedAt: number
  lastAttemptAt: number
  error: string
  errorCount: number
  lastErrorAt: number
  etag: string
  lastModified: string
  paused: boolean
}

/**
 * A subscription folder.
 *
 * The field names are the note `Folder` field names on purpose: `buildFolderTree`,
 * `folderDescendantIds` and `folderMoveExclusions` then work on subscriptions unchanged, so the
 * nesting rules of the two trees cannot drift apart into two near-misses.
 */
export interface RssGroup extends Omit<Folder, 'noteCount'> {
  collapsed: boolean
}

export interface RssLibrary {
  version: number
  feeds: RssFeed[]
  groups: RssGroup[]
  /** Newest first, so trimming the tail drops the oldest reading history. */
  readIds: string[]
  favorites: string[]
  readLater: string[]
  /** Articles the reader dismissed. They stay hidden across refreshes, unlike a filtered view. */
  hiddenIds: string[]
  /** entryId → when the reader last opened it. What the source-health table ranks by. */
  opened: Record<string, number>
  /** `<entryId>|<kind>` → the note that article was saved as, so saving twice does not duplicate. */
  savedNotes: Record<string, string>
  /** The channel the reader was last looking at, restored on the next visit. */
  lastChannel: string
}

export interface RssParseResult {
  data: RssLibrary | null
  dropped: number
  truncated: boolean
}

export function emptyLibrary(): RssLibrary {
  return {
    version: RSS_LIBRARY_VERSION,
    feeds: [],
    groups: [],
    readIds: [],
    favorites: [],
    readLater: [],
    hiddenIds: [],
    opened: {},
    savedNotes: {},
    lastChannel: '',
  }
}

export function newFeed(id: string, url: string, title: string, order: number): RssFeed {
  return {
    id,
    url,
    title,
    siteUrl: '',
    imageUrl: '',
    groupId: '',
    tags: [],
    order,
    updatedAt: 0,
    lastAttemptAt: 0,
    error: '',
    errorCount: 0,
    lastErrorAt: 0,
    etag: '',
    lastModified: '',
    paused: false,
  }
}

export function newGroup(id: string, name: string, position: number, parentId: string | null = null, now = Date.now()): RssGroup {
  return { id, parentId, name, icon: null, color: null, position, createdAt: now, updatedAt: now, collapsed: false }
}

/**
 * FNV-1a over 64 bits, as 16 hex characters.
 *
 * Identities have to be stable across devices and rebuildable from the feed's own text, and
 * `crypto.subtle` is both async and absent from the synchronous paths that need an id (a parse
 * running inside a store update). A 64-bit hash is not a security boundary and is not used as one:
 * it names an article so read marks and favorites survive a re-fetch.
 */
export function rssHash(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 ^= c & 0xff
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + h1 + c) >>> 0
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0
  }
  return hex32(h2) + hex32(h1)
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/** The id of a feed, derived from its address so the same URL added twice is the same feed. */
export function feedIdFor(url: string): string {
  return `f${rssHash(canonicalFeedUrl(url) || url)}`
}

export function entryIdFor(feedId: string, identity: string): string {
  return `e${rssHash(`${feedId}\n${identity}`)}`
}

/**
 * The address two subscriptions of the same feed share: scheme and host case folded, the trailing
 * slash dropped, and the tracking parameters feeds add dropped with it.
 *
 * This is a comparison, never a request. A host can answer differently to `www.` than to the bare
 * name — measured with a feed that returns 200 one way and 403 the other — so the address a reader
 * typed is the one that gets fetched.
 */
export function canonicalFeedUrl(value: string): string {
  const url = safeHttpUrl(value)
  if (!url) return ''
  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  url.hash = ''
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key)
  }
  if (!url.searchParams.size && url.search) url.search = ''
  return url.href
}

/** An http(s) address with no embedded credentials, or null. The one URL test the reader uses. */
export function safeHttpUrl(value: string, base?: string): URL | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > RSS_LIMITS.urlChars) return null
  try {
    const url = new URL(trimmed, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url
  }
  catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function flag(value: unknown): boolean {
  return value === true
}

function idList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && item) seen.add(item.slice(0, 80))
    if (seen.size >= max) break
  }
  return [...seen]
}

/**
 * Feed tags, folded the way the note tags fold: the same name in another case is one tag, a name
 * with a space or a comma in it is not a name, and the deepest segment count is what the sidebar
 * can render.
 */
function tagList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Map<string, string>()
  for (const item of value) {
    if (seen.size >= RSS_LIMITS.tagsPerFeed) break
    if (typeof item !== 'string') continue
    const name = item.trim().replace(/^#+/, '').replace(/\/+$/, '').slice(0, RSS_LIMITS.tagChars)
    if (!name || !isUsableTagName(name)) continue
    const key = tagKey(name)
    if (!seen.has(key)) seen.set(key, name)
  }
  return sortTagNames(seen.values())
}

export function normaliseEntry(value: unknown, feedId: string): RssEntry | null {
  if (!isRecord(value)) return null
  const link = text(value.link, RSS_LIMITS.urlChars)
  const title = text(value.title, RSS_LIMITS.titleChars)
  if (!link && !title) return null
  const identity = typeof value.id === 'string' && value.id ? value.id : `${title}\n${link}`
  return {
    id: text(value.id, 80) || entryIdFor(feedId, identity),
    feedId,
    title,
    link,
    author: text(value.author, RSS_LIMITS.nameChars),
    publishedTs: typeof value.publishedTs === 'number' && Number.isFinite(value.publishedTs) ? Math.trunc(value.publishedTs) : null,
    summary: text(value.summary, RSS_LIMITS.summaryChars),
    content: text(value.content, RSS_LIMITS.contentChars),
    imageUrl: text(value.imageUrl, RSS_LIMITS.urlChars),
    audioUrl: text(value.audioUrl, RSS_LIMITS.urlChars),
  }
}

function normaliseFeed(value: unknown, order: number): RssFeed | null {
  if (!isRecord(value)) return null
  const url = safeHttpUrl(text(value.url, RSS_LIMITS.urlChars))
  if (!url) return null
  const id = text(value.id, 80) || feedIdFor(url.href)
  return {
    id,
    url: url.href,
    title: text(value.title, RSS_LIMITS.nameChars) || url.hostname,
    siteUrl: text(value.siteUrl, RSS_LIMITS.urlChars),
    imageUrl: text(value.imageUrl, RSS_LIMITS.urlChars),
    groupId: text(value.groupId, 80),
    tags: tagList(value.tags),
    order: integer(value.order, order),
    updatedAt: integer(value.updatedAt),
    lastAttemptAt: integer(value.lastAttemptAt),
    error: text(value.error, RSS_LIMITS.errorChars),
    errorCount: Math.max(0, integer(value.errorCount)),
    lastErrorAt: integer(value.lastErrorAt),
    etag: text(value.etag, 200),
    lastModified: text(value.lastModified, 200),
    paused: flag(value.paused),
  }
}

function normaliseGroup(value: unknown, order: number): RssGroup | null {
  if (!isRecord(value)) return null
  const name = text(value.name, RSS_LIMITS.groupChars).trim()
  if (!name) return null
  const now = integer(value.updatedAt)
  return {
    id: text(value.id, 80) || `g${rssHash(name)}`,
    parentId: typeof value.parentId === 'string' && value.parentId ? value.parentId.slice(0, 80) : null,
    name,
    icon: typeof value.icon === 'string' && value.icon ? value.icon.slice(0, 80) : null,
    color: typeof value.color === 'string' && value.color ? value.color.slice(0, 40) : null,
    // `order` is what version 1 wrote; a library that predates nesting still keeps its arrangement.
    position: integer(value.position ?? value.order, order),
    createdAt: integer(value.createdAt, now),
    updatedAt: now,
    collapsed: flag(value.collapsed),
  }
}

/**
 * Repair the folder links a stored library claims to have.
 *
 * A hand-edited or half-written library can point a folder at a parent that does not exist, at
 * itself, or into a ring of three folders that are each other's parents. Every one of those becomes
 * a root, because the alternative — dropping the folder — would take its subscriptions with it.
 * Returns how many links were cut, so the caller can report the library as truncated.
 */
function linkFolders(groups: RssGroup[]): number {
  const byId = new Map(groups.map(group => [group.id, group]))
  let repairs = 0
  for (const group of groups) {
    if (!group.parentId) continue
    if (group.parentId === group.id || !byId.has(group.parentId)) {
      group.parentId = null
      repairs++
    }
  }
  for (const group of groups) {
    if (!group.parentId) continue
    const seen = new Set<string>([group.id])
    let cursor: RssGroup | undefined = group
    let depth = 1
    let broken = false
    while (cursor?.parentId) {
      const parent = byId.get(cursor.parentId)
      if (!parent || seen.has(parent.id)) { broken = true; break }
      seen.add(parent.id)
      cursor = parent
      depth++
    }
    if (broken || depth > RSS_LIMITS.groupDepthMax) {
      group.parentId = null
      repairs++
    }
  }
  return repairs
}

function numberMap(value: unknown, max: number, cap: number): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(value)) return out
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(out).length >= max) break
    if (typeof item === 'number' && Number.isFinite(item)) out[key.slice(0, 80)] = cap ? Math.min(item, cap) : Math.trunc(item)
  }
  return out
}

function stringMap(value: unknown, max: number): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(value)) return out
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(out).length >= max) break
    if (typeof item === 'string' && item) out[key.slice(0, 120)] = item.slice(0, 120)
  }
  return out
}

/**
 * Rebuild a stored library, counting what had to go.
 *
 * The ceilings are applied in the order a reader cares about: feeds and groups first (losing one
 * costs the subscription itself), then the reading marks. An entry that no longer fits is dropped
 * rather than truncated, because a half-body is the kind of damage nobody notices until they read
 * it.
 */
export function parseRssLibrary(value: unknown): RssParseResult {
  // A payload that is not shaped like a library at all is refused rather than read as an empty one:
  // the write path stores whatever comes back, so "unreadable" and "the reader unsubscribed from
  // everything" must not be the same answer.
  if (!isRecord(value) || !Array.isArray(value.feeds) || !Array.isArray(value.groups)) {
    return { data: null, dropped: 0, truncated: false }
  }
  let dropped = 0
  let truncated = false

  const groups: RssGroup[] = []
  const seenGroups = new Set<string>()
  for (const item of Array.isArray(value.groups) ? value.groups : []) {
    if (groups.length >= RSS_LIMITS.groups) { truncated = true; break }
    const group = normaliseGroup(item, groups.length)
    if (!group) { dropped++; continue }
    // Two folders of the same name are a mistake only under the same parent: `front-end/articles`
    // and `design/articles` are the shape a reader builds on purpose.
    const key = `${group.parentId ?? ''}\u0000${tagKey(group.name)}`
    if (seenGroups.has(group.id) || seenGroups.has(key)) { dropped++; continue }
    seenGroups.add(group.id)
    seenGroups.add(key)
    groups.push(group)
  }
  if (linkFolders(groups)) truncated = true

  const feeds: RssFeed[] = []
  const seenFeeds = new Set<string>()
  for (const item of Array.isArray(value.feeds) ? value.feeds : []) {
    if (feeds.length >= RSS_LIMITS.feeds) { truncated = true; break }
    const feed = normaliseFeed(item, feeds.length)
    if (!feed) { dropped++; continue }
    const canonical = canonicalFeedUrl(feed.url)
    if (!canonical || seenFeeds.has(canonical)) { dropped++; continue }
    seenFeeds.add(canonical)
    if (feed.groupId && !groups.some(group => group.id === feed.groupId)) {
      feed.groupId = ''
    }
    feeds.push(feed)
  }

  const readIds = idList(value.readIds, RSS_LIMITS.readIds)
  if (Array.isArray(value.readIds) && value.readIds.length > RSS_LIMITS.readIds) truncated = true
  const favorites = idList(value.favorites, RSS_LIMITS.favorites)
  const readLater = idList(value.readLater, RSS_LIMITS.readLater)
  const hiddenIds = idList(value.hiddenIds, RSS_LIMITS.hiddenIds)

  const data: RssLibrary = {
    version: RSS_LIBRARY_VERSION,
    feeds,
    groups,
    readIds,
    favorites,
    readLater,
    hiddenIds,
    opened: numberMap(value.opened, RSS_LIMITS.openedRecords, 0),
    savedNotes: stringMap(value.savedNotes, RSS_LIMITS.savedNotes),
    lastChannel: text(value.lastChannel, 120),
  }
  return { data, dropped, truncated }
}

export function libraryFromStored(raw: string | null | undefined): RssLibrary | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return parseRssLibrary(JSON.parse(raw)).data
  }
  catch {
    return null
  }
}

/** Trim the reading marks to their ceilings, oldest first, so a long-lived library cannot grow. */
export function trimLibrary(library: RssLibrary): RssLibrary {
  library.readIds = library.readIds.slice(0, RSS_LIMITS.readIds)
  library.favorites = library.favorites.slice(0, RSS_LIMITS.favorites)
  library.readLater = library.readLater.slice(0, RSS_LIMITS.readLater)
  const openedKeys = Object.keys(library.opened)
  if (openedKeys.length > RSS_LIMITS.openedRecords) {
    for (const key of openedKeys.sort((a, b) => library.opened[a] - library.opened[b]).slice(0, openedKeys.length - RSS_LIMITS.openedRecords)) {
      delete library.opened[key]
    }
  }
  const savedKeys = Object.keys(library.savedNotes)
  if (savedKeys.length > RSS_LIMITS.savedNotes) {
    for (const key of savedKeys.slice(0, savedKeys.length - RSS_LIMITS.savedNotes)) delete library.savedNotes[key]
  }
  return library
}

export function savedNoteKey(entryId: string, kind: string): string {
  return `${entryId}|${kind}`
}

/**
 * One feed's worth of articles, as a single device keeps them.
 *
 * The library says what a reader subscribes to; this is the part that is rebuilt from the network,
 * so it never crosses the wire and stays out of the account's row. It is normalized on the way out
 * of storage all the same, because IndexedDB holds whatever an earlier build of this code left.
 */
export interface RssFeedCache {
  feedId: string
  fetchedAt: number
  entries: RssEntry[]
}

export function parseFeedCache(value: unknown): RssFeedCache | null {
  if (!isRecord(value) || typeof value.feedId !== 'string' || !value.feedId || !Array.isArray(value.entries)) return null
  const entries: RssEntry[] = []
  let bytes = 0
  for (const item of value.entries) {
    if (entries.length >= RSS_LIMITS.entriesPerFeed) break
    const entry = normaliseEntry(item, value.feedId)
    if (!entry) continue
    bytes += entry.content.length + entry.summary.length
    if (bytes > RSS_LIMITS.feedBytes) break
    entries.push(entry)
  }
  return { feedId: value.feedId, fetchedAt: integer(value.fetchedAt), entries }
}

/** Why the relay could not read a feed. The reader turns the code into its own sentence. */
export type RssFetchReason = 'blocked' | 'timeout' | 'too-large' | 'not-a-feed' | 'http' | 'unreachable'

/** One answer for one address, from `POST /api/rss/fetch`. */
export interface RssFetchResult {
  url: string
  status: number
  ok: boolean
  xml?: string
  etag?: string
  lastModified?: string
  reason?: RssFetchReason
}
