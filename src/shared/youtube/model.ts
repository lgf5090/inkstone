/**
 * The YouTube app's shared vocabulary: the upstream shapes the API hands over, the library rows a
 * reader saves, the address that names a view, and the pure formatting/tree rules both sides use.
 *
 * Nothing here touches the network or the DOM. The worker's transforms and the reader's rendering
 * have to agree on every field, so the types live once and are imported by both builds.
 */

export interface YouTubeVideo {
  id: string
  title: string
  description: string
  publishedAt: string
  channelId: string
  channelTitle: string
  thumbnailUrl: string
  thumbnailHighUrl: string
  duration: string
  viewCount: number
  likeCount: number
  commentCount: number
  tags: string[]
  categoryId: string
  isLive: boolean
}

export interface YouTubeChannel {
  id: string
  title: string
  description: string
  customUrl: string | null
  thumbnailUrl: string
  /** -1 marks a channel that hides its subscriber count. */
  subscriberCount: number
  videoCount: number
  uploadsPlaylistId: string
  publishedAt: string
}

export interface YouTubePlaylist {
  id: string
  title: string
  description: string
  channelId: string
  channelTitle: string
  thumbnailUrl: string
  itemCount: number
  publishedAt: string
}

export interface YouTubeComment {
  id: string
  videoId: string
  authorDisplayName: string
  authorProfileImageUrl: string
  textDisplay: string
  textOriginal: string
  likeCount: number
  publishedAt: string
  updatedAt: string
  replyCount: number
}

export interface YouTubeTag {
  id: string
  name: string
  /** A hex colour from the shared organiser palette. */
  color: string
  parentId: string | null
  sortOrder: number
  pinned: boolean
  createdAt: number
}

export interface SavedYouTubeVideo {
  id: string
  title: string
  thumbnailUrl: string
  channelId: string
  channelTitle: string
  data: YouTubeVideo
  tagIds: string[]
  pinned: boolean
  favorited: boolean
  notes: string
  createdAt: number
  updatedAt: number
}

export interface SavedYouTubeChannel {
  id: string
  data: YouTubeChannel
  tagIds: string[]
  pinned: boolean
  sortOrder: number
  notes: string
  createdAt: number
  updatedAt: number
}

export interface SavedYouTubePlaylist {
  id: string
  data: YouTubePlaylist
  tagIds: string[]
  pinned: boolean
  favorited: boolean
  sortOrder: number
  notes: string
  createdAt: number
  updatedAt: number
}

export interface YouTubeLibrary {
  tags: YouTubeTag[]
  videos: SavedYouTubeVideo[]
  channels: SavedYouTubeChannel[]
  playlists: SavedYouTubePlaylist[]
  /** True when the saved-video list hit its ceiling and the response is a prefix. */
  truncated: boolean
}

export type SortKey = 'relevance' | 'date' | 'viewCount' | 'rating'
export type TimeRange = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'all'

export interface YouTubePrefs {
  sort: SortKey
  range: TimeRange
}

export const DEFAULT_YOUTUBE_PREFS: YouTubePrefs = { sort: 'viewCount', range: 'week' }
export const SORT_KEYS: readonly SortKey[] = ['relevance', 'date', 'viewCount', 'rating']
export const TIME_RANGES: readonly TimeRange[] = ['today', 'week', 'month', 'quarter', 'year', 'all']

export const RANGE_DAYS: Record<Exclude<TimeRange, 'all'>, number> = {
  today: 0,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
}

export type YouTubeView =
  | { kind: 'explore' }
  | { kind: 'library'; filter: 'all' | 'pinned' | 'favorites' }
  | { kind: 'tag'; tagId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'playlist'; playlistId: string }

export interface YouTubeAddress {
  view: YouTubeView
  q: string
  sort: SortKey
  range: TimeRange
  videoId: string | null
}

export interface YouTubeListResult<T> {
  items: T[]
  total: number
  nextPageToken: string | null
  prevPageToken: string | null
}

export interface YouTubeDiscoverResult extends YouTubeListResult<YouTubeVideo> {
  mode: 'popular' | 'search'
}

export interface YouTubeCommentList {
  items: YouTubeComment[]
  total: number
  nextPageToken: string | null
}

export interface YouTubeQuotaBreakdown {
  endpoint: string
  units: number
  count: number
  cost: number
}

export interface YouTubeQuotaData {
  configured: boolean
  limit: number
  today: {
    date: string
    total: number
    remaining: number
    breakdown: YouTubeQuotaBreakdown[]
  }
  history: { date: string; units: number; count: number }[]
  weekBreakdown: YouTubeQuotaBreakdown[]
  quotaCosts: Record<string, number>
}

/** The tab's address. Any child path the router does not name falls back to the discover view. */
export function parseYouTubeAddress(
  pathname: string,
  search: string,
  prefs: YouTubePrefs = DEFAULT_YOUTUBE_PREFS,
): YouTubeAddress {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const params = new URLSearchParams(search)
  const rawQ = params.get('q') ?? ''
  const rawSort = params.get('sort') ?? ''
  const rawRange = params.get('range') ?? ''
  const rawVideo = params.get('v') ?? ''
  const sort = isSortKey(rawSort) ? rawSort : prefs.sort
  const range = isTimeRange(rawRange) ? rawRange : prefs.range

  return {
    view: viewForPath(path),
    q: rawQ.slice(0, 200),
    sort,
    range,
    videoId: /^[A-Za-z0-9_-]{6,64}$/.test(rawVideo) ? rawVideo : null,
  }
}

function viewForPath(path: string): YouTubeView {
  if (path === '/youtube/all') return { kind: 'library', filter: 'all' }
  if (path === '/youtube/pinned') return { kind: 'library', filter: 'pinned' }
  if (path === '/youtube/favorites') return { kind: 'library', filter: 'favorites' }
  const tag = /^\/youtube\/tags\/([^/]+)$/.exec(path)
  if (tag) return { kind: 'tag', tagId: decodeSegment(tag[1]!) }
  const channel = /^\/youtube\/channels\/([^/]+)$/.exec(path)
  if (channel) return { kind: 'channel', channelId: decodeSegment(channel[1]!) }
  const playlist = /^\/youtube\/playlists\/([^/]+)$/.exec(path)
  if (playlist) return { kind: 'playlist', playlistId: decodeSegment(playlist[1]!) }
  return { kind: 'explore' }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function youtubeViewPath(view: YouTubeView): string {
  switch (view.kind) {
    case 'library':
      return view.filter === 'all' ? '/youtube/all' : view.filter === 'pinned' ? '/youtube/pinned' : '/youtube/favorites'
    case 'tag':
      return `/youtube/tags/${encodeURIComponent(view.tagId)}`
    case 'channel':
      return `/youtube/channels/${encodeURIComponent(view.channelId)}`
    case 'playlist':
      return `/youtube/playlists/${encodeURIComponent(view.playlistId)}`
    default:
      return '/youtube'
  }
}

export function youtubeViewKey(view: YouTubeView): string {
  switch (view.kind) {
    case 'library':
      return `library:${view.filter}`
    case 'tag':
      return `tag:${view.tagId}`
    case 'channel':
      return `channel:${view.channelId}`
    case 'playlist':
      return `playlist:${view.playlistId}`
    default:
      return 'explore'
  }
}

/** The discover query string, without a leading `?`. Empty when every value is the default. */
export function youtubeSearchParams(input: {
  q?: string
  sort?: SortKey
  range?: TimeRange
  videoId?: string | null
  prefs?: YouTubePrefs
}): string {
  const prefs = input.prefs ?? DEFAULT_YOUTUBE_PREFS
  const params = new URLSearchParams()
  if (input.q) params.set('q', input.q)
  if (input.sort && input.sort !== prefs.sort) params.set('sort', input.sort)
  if (input.range && input.range !== prefs.range) params.set('range', input.range)
  if (input.videoId) params.set('v', input.videoId)
  return params.toString()
}

export function isSortKey(value: string): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value)
}

export function isTimeRange(value: string): value is TimeRange {
  return (TIME_RANGES as readonly string[]).includes(value)
}

/** The compact count the reference uses: 1.2K, 3.4M, 1.1B, with a trailing `.0` removed. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000_000) return `${trimZero(value / 1_000_000_000)}B`
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimZero(value / 1_000)}K`
  return String(Math.floor(value))
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

/** Parses an ISO 8601 duration (`PT1H2M3S`) into `1:02:03`. */
export function parseDuration(iso: string): string {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!match) return ''
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  const seconds = Number(match[3] ?? 0)
  const pad = (value: number) => value.toString().padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${minutes}:${pad(seconds)}`
}

/**
 * A published timestamp as the reader reads it: relative inside the first week, then an absolute
 * date. The locale decides the wording; nothing here is hard-coded copy.
 */
export function formatPublished(iso: string, locale: string, now: number = Date.now()): string {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const diff = now - time
  if (diff < 60_000) return relative(locale, 0, 'second')
  if (diff < 3_600_000) return relative(locale, -Math.floor(diff / 60_000), 'minute')
  if (diff < 86_400_000) return relative(locale, -Math.floor(diff / 3_600_000), 'hour')
  if (diff < 7 * 86_400_000) return relative(locale, -Math.floor(diff / 86_400_000), 'day')
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(time)
}

function relative(locale: string, value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit)
}

/** Start of `today` in the reader's own timezone, as epoch milliseconds. */
export function startOfLocalDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** The cutoff a time-range chip means. `all` has none. */
export function rangeCutoff(range: TimeRange, now: number): number | null {
  if (range === 'all') return null
  if (range === 'today') return startOfLocalDay(now)
  return now - RANGE_DAYS[range] * 86_400_000
}

/** Whether a saved video should exist at all: one of pin, favourite or a tag has to hold it. */
export function shouldDeleteSavedVideo(input: {
  pinned: boolean
  favorited: boolean
  tagIds: readonly string[]
}): boolean {
  return !input.pinned && !input.favorited && input.tagIds.length === 0
}

export interface YouTubeTagNode extends YouTubeTag {
  children: YouTubeTagNode[]
}

/**
 * The tag forest, ordered by `sortOrder` then `createdAt`.
 *
 * A row whose parent is missing (or whose parent chain loops through a row written by an older
 * build) is shown at the root instead of disappearing: silently dropping a tag is worse than
 * drawing one at the wrong depth.
 */
export function buildTagTree(tags: readonly YouTubeTag[]): YouTubeTagNode[] {
  const byId = new Map<string, YouTubeTagNode>()
  for (const tag of tags) byId.set(tag.id, { ...tag, children: [] })
  const roots: YouTubeTagNode[] = []
  for (const tag of tags) {
    const node = byId.get(tag.id)!
    const parent = tag.parentId ? byId.get(tag.parentId) : undefined
    if (parent && parent !== node && !wouldCycle(byId, tag)) parent.children.push(node)
    else roots.push(node)
  }
  const sortRec = (nodes: YouTubeTagNode[]) => {
    nodes.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    for (const node of nodes) if (node.children.length) sortRec(node.children)
  }
  sortRec(roots)
  return roots
}

function wouldCycle(byId: Map<string, YouTubeTagNode>, tag: YouTubeTag): boolean {
  const seen = new Set<string>([tag.id])
  let parentId = tag.parentId
  while (parentId) {
    if (seen.has(parentId)) return true
    seen.add(parentId)
    parentId = byId.get(parentId)?.parentId ?? null
  }
  return false
}

/** How deep a tag sits, for indentation in the picker. */
export function tagDepth(tags: readonly YouTubeTag[], id: string): number {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const seen = new Set<string>()
  let depth = 0
  let parentId = byId.get(id)?.parentId ?? null
  while (parentId && depth < 32 && !seen.has(parentId)) {
    seen.add(parentId)
    depth++
    parentId = byId.get(parentId)?.parentId ?? null
  }
  return depth
}

/** The tag and every tag below it, for a delete that has to take the subtree with it. */
export function tagSubtreeIds(tags: readonly YouTubeTag[], rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const tag of tags) {
    if (!tag.parentId) continue
    const list = children.get(tag.parentId)
    if (list) list.push(tag.id)
    else children.set(tag.parentId, [tag.id])
  }
  const out = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length) {
    const id = queue.pop()!
    for (const child of children.get(id) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      queue.push(child)
    }
  }
  return out
}

/** A tag cannot be moved under itself or one of its own descendants. */
export function wouldCreateTagCycle(
  tags: readonly YouTubeTag[],
  id: string,
  parentId: string | null,
): boolean {
  if (!parentId) return false
  if (parentId === id) return true
  return tagSubtreeIds(tags, id).has(parentId)
}

/** YouTube Data API quota units per endpoint, from the upstream's own cost table. */
export const YOUTUBE_QUOTA_COSTS: Readonly<Record<string, number>> = {
  search: 100,
  videos: 1,
  channels: 1,
  playlists: 1,
  playlistItems: 1,
  commentThreads: 1,
}

export const YOUTUBE_DAILY_QUOTA_DEFAULT = 10_000
export const YOUTUBE_SEARCH_COST = YOUTUBE_QUOTA_COSTS.search!
export const YOUTUBE_MAX_LIBRARY_VIDEOS = 2_000



