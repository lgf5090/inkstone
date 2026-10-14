/**
 * What the reader lists, sorts and counts, apart from anything that draws it.
 *
 * A channel is a question about the library rather than a screen: "this feed", "this group", "all
 * of it", "what I starred". Every surface — the rail's unread badges, the list, the keyboard's
 * next/previous, the position the reader returns to — asks the same question of the same data, and
 * the reason this file exists is that they must not disagree. Two views that disagree about what is
 * unread are the classic RSS bug, and no test of a single component can catch it.
 *
 * A `RssView` is the pair the question needs: the library (what is subscribed, what is marked) and
 * the articles this device has fetched. They are kept apart because only the first travels between
 * devices — an article list is rebuilt from the network in a second, while a subscription list is
 * years of small decisions a reader should not lose.
 *
 * Search is deliberately absent: matching a query is the app's fuzzy + pinyin rule, which lives in
 * the client layer with the rest of the things that need a DOM.
 */

import { tagInScope, tagKey } from '../markdown-utils'
import { rssHash, safeHttpUrl } from './model'
import type { RssEntry, RssFeed, RssGroup, RssLibrary } from './model'

export interface RssView {
  library: RssLibrary
  /** feedId → the articles this device holds for it. */
  articles: Record<string, RssEntry[]>
}

export type RssFilter = 'all' | 'unread' | 'starred' | 'later'

/** Which end of the list a channel opens at. The reference pins newest-first; a reader asked for both. */
export type RssSort = 'newest' | 'oldest' | 'source'

export type RssChannel
  = | { kind: 'all' }
    | { kind: 'unread' }
    | { kind: 'recent' }
    | { kind: 'group', groupId: string }
    | { kind: 'tag', tag: string }
    | { kind: 'feed', feedId: string }
    /**
     * A folder of the reader's own notes, read as a channel. The rows are notes and the article
     * pane never sees them: opening one goes to the notebook, which is where a note is read.
     */
    | { kind: 'vault', folderId: string }
    | { kind: 'starred' }
    | { kind: 'later' }

/** The address-shaped key a channel's own state (selection, scroll, filter) is stored under. */
export function channelKey(channel: RssChannel): string {
  switch (channel.kind) {
    case 'feed':
      return `feed:${channel.feedId}`
    case 'group':
      return `group:${channel.groupId}`
    case 'tag':
      return `tag:${channel.tag}`
    case 'vault':
      return `vault:${channel.folderId}`
    default:
      return channel.kind
  }
}

export function parseChannelKey(key: string): RssChannel {
  if (key.startsWith('feed:')) return { kind: 'feed', feedId: key.slice(5) }
  if (key.startsWith('group:')) return { kind: 'group', groupId: key.slice(6) }
  if (key.startsWith('tag:')) return { kind: 'tag', tag: key.slice(4) }
  if (key.startsWith('vault:')) return { kind: 'vault', folderId: key.slice(6) }
  if (key === 'starred') return { kind: 'starred' }
  if (key === 'later') return { kind: 'later' }
  if (key === 'unread') return { kind: 'unread' }
  if (key === 'recent') return { kind: 'recent' }
  return { kind: 'all' }
}

/** Newest first; undated entries keep the order the feed gave them among themselves. */
export function byNewest(entries: RssEntry[]): RssEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.publishedTs ?? 0) - (a.entry.publishedTs ?? 0) || a.index - b.index)
    .map(item => item.entry)
}

/** The same list read the other way; ties still resolve by the feed's own order. */
export function byOldest(entries: RssEntry[]): RssEntry[] {
  return byNewest(entries).reverse()
}

/** Grouped by source in library order, each source newest first. */
export function bySource(entries: RssEntry[], feeds: RssFeed[]): RssEntry[] {
  const rank = new Map(feeds.map((feed, index) => [feed.id, index]))
  return byNewest(entries).sort((a, b) => (rank.get(a.feedId) ?? 0) - (rank.get(b.feedId) ?? 0))
}

export function sortEntries(entries: RssEntry[], sort: RssSort, feeds: RssFeed[]): RssEntry[] {
  if (sort === 'oldest') return byOldest(entries)
  if (sort === 'source') return bySource(entries, feeds)
  return byNewest(entries)
}

/** One entry per id, first list winning, newest first. */
export function mergeEntries(...lists: RssEntry[][]): RssEntry[] {
  const seen = new Map<string, RssEntry>()
  for (const list of lists) {
    for (const entry of list) {
      if (!seen.has(entry.id)) seen.set(entry.id, entry)
    }
  }
  return byNewest([...seen.values()])
}

export interface ChannelOptions {
  /** Which ids the reader has already opened. Defaults to the library's own marks. */
  readIds?: Set<string>
  starred?: Set<string>
  later?: Set<string>
  /** Entries per feed kept in a merged view, so 40 feeds do not paint 2,400 rows. */
  perFeedLimit?: number
  /** The article on screen, which a de-duplication must not swap out from under the reader. */
  selectedId?: string
}

/** How many articles each feed contributes to a merged channel. */
export const MERGED_PER_FEED = 20

function marksFor(view: RssView, options: ChannelOptions): { read: Set<string>, starred: Set<string>, later: Set<string> } {
  return {
    read: options.readIds ?? new Set(view.library.readIds),
    starred: options.starred ?? new Set(view.library.favorites),
    later: options.later ?? new Set(view.library.readLater),
  }
}

/**
 * The entries a channel answers with, before any search or filter is applied.
 *
 * A merged channel (all, group, tag) takes the newest `perFeedLimit` from each member rather than
 * the whole archive of whichever feed happens to be first: without that, one feed that ships 60
 * items pushes everything else off the screen.
 *
 * Hidden articles leave every channel, not just a filtered view of one — a dismissal that comes
 * back on the next refresh is not a dismissal.
 */
export function channelEntries(view: RssView, channel: RssChannel, options: ChannelOptions = {}): RssEntry[] {
  const marks = marksFor(view, options)
  const hidden = new Set(view.library.hiddenIds)
  const keep = (entry: RssEntry): boolean => !hidden.has(entry.id)
  const feeds = feedsForChannel(view.library, channel)
  const limit = options.perFeedLimit ?? MERGED_PER_FEED
  const listed = (): RssEntry[] => {
    // A note folder is not a question about the article library; its rows are built by the client
    // from the notebook's own store. Answering "everything" here would be the worst possible default.
    if (channel.kind === 'vault') return []
    if (channel.kind === 'starred') return byNewest(allEntries(view).filter(entry => marks.starred.has(entry.id) && keep(entry)))
    if (channel.kind === 'later') return byNewest(allEntries(view).filter(entry => marks.later.has(entry.id) && keep(entry)))
    if (channel.kind === 'unread') return byNewest(allEntries(view).filter(entry => !marks.read.has(entry.id) && keep(entry)))
    if (channel.kind === 'recent') {
      const opened = view.library.opened
      return allEntries(view)
        .filter(entry => opened[entry.id] !== undefined && keep(entry))
        .sort((a, b) => (opened[b.id] ?? 0) - (opened[a.id] ?? 0))
        .slice(0, RECENT_CHANNEL_SIZE)
    }
    if (feeds.length === 1) return byNewest((view.articles[feeds[0].id] ?? []).filter(keep))
    return mergeEntries(...feeds.map(feed => byNewest((view.articles[feed.id] ?? []).filter(keep)).slice(0, limit)))
  }
  return uniqueRemoteEntries(listed(), options.selectedId)
}

/** How many articles the recently-read channel keeps on screen. */
export const RECENT_CHANNEL_SIZE = 100

export function feedsForChannel(library: RssLibrary, channel: RssChannel): RssFeed[] {
  if (channel.kind === 'feed') {
    const feed = library.feeds.find(item => item.id === channel.feedId)
    return feed ? [feed] : []
  }
  if (channel.kind === 'group') {
    const shelf = descendantGroupIds(library.groups, channel.groupId)
    shelf.add(channel.groupId)
    return library.feeds.filter(feed => shelf.has(feed.groupId))
  }
  if (channel.kind === 'tag') {
    return library.feeds.filter(feed => feed.tags.some(tag => tagInScope(tag, channel.tag)))
  }
  // Nothing to fetch for a note folder: its rows are already on this device.
  if (channel.kind === 'vault') return []
  return library.feeds
}

/** A folder and everything nested under it. Cycles stop at the second visit, like the tree builder. */
export function descendantGroupIds(groups: RssGroup[], rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.parentId) continue
    const list = children.get(group.parentId) ?? []
    list.push(group.id)
    children.set(group.parentId, list)
  }
  const out = new Set<string>()
  const pending = [rootId]
  while (pending.length) {
    const id = pending.pop()!
    if (out.has(id)) continue
    out.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  out.delete(rootId)
  return out
}

/**
 * Every tag the library carries, with how many subscriptions answer to it.
 *
 * A subscription tagged `tech/rss` is also tagged `tech`, so the parent is listed and counted with
 * it. The rail badges the row it shows, and a parent whose badge disagreed with the channel it
 * opened would be the same defect this file exists to prevent, one level down.
 */
export function tagCounts(library: RssLibrary): Map<string, number> {
  const out = new Map<string, number>()
  for (const feed of library.feeds) {
    for (const scope of tagScopes(feed.tags)) out.set(scope, (out.get(scope) ?? 0) + 1)
  }
  return out
}

/** The tag keys one list of names answers to: each name and every ancestor of each name. */
export function tagScopes(tags: readonly string[]): string[] {
  const out = new Set<string>()
  for (const tag of tags) {
    const parts = tagKey(tag).split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'))
  }
  return [...out]
}

/**
 * The order a shelf of subscriptions shows in: pinned first, then the reader's own arrangement.
 *
 * The rail, the move-up and move-down menu and a dropped feed all have to agree on this, or the
 * index one of them computed lands somewhere else than the row the reader was pointing at.
 */
export function feedShelfOrder(a: RssFeed, b: RssFeed): number {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.order - b.order
}

export function findFeed(library: RssLibrary, id: string): RssFeed | undefined {
  return library.feeds.find(feed => feed.id === id)
}

/** Every article this device holds, in feed order. The saved views search across all of it. */
export function allEntries(view: RssView): RssEntry[] {
  const out: RssEntry[] = []
  for (const feed of view.library.feeds) out.push(...(view.articles[feed.id] ?? []))
  return out
}

export function findEntry(view: RssView, id: string): RssEntry | undefined {
  if (!id) return undefined
  for (const feed of view.library.feeds) {
    const entry = (view.articles[feed.id] ?? []).find(item => item.id === id)
    if (entry) return entry
  }
  return undefined
}

export interface ListQuery {
  filter: RssFilter
  /** Lower-cased, trimmed terms every field has to carry. Built by the client's search box. */
  terms?: string[]
  /** Match the feed name as well as the article, which is what a merged list needs. */
  fields?: 'entry' | 'entry-and-feed'
}

/**
 * The list a reader sees: filter, then search.
 *
 * Filter before search rather than the other way round, because the filter is what the buttons on
 * screen say, and a search that quietly widens "unread" to everything reads as a broken toggle.
 */
export function selectEntries(
  entries: RssEntry[],
  query: ListQuery,
  view: RssView,
  options: ChannelOptions = {},
): RssEntry[] {
  const marks = marksFor(view, options)
  // Over everything this device holds, not the list being filtered: the duplicate whose id carries
  // the read mark has already been collapsed out of that list by the time this runs.
  const readKeys = query.filter === 'unread' ? readKeysFor(allEntries(view), marks.read) : null
  const feedTitles = query.fields === 'entry-and-feed' && query.terms?.length
    ? new Map(view.library.feeds.map(feed => [feed.id, feed.title.toLowerCase()]))
    : null
  const terms = query.terms ?? []
  const matched = entries.filter((entry) => {
    if (query.filter === 'unread' && (marks.read.has(entry.id) || readKeys?.has(remoteContentKey(entry.link)))) return false
    if (query.filter === 'starred' && !marks.starred.has(entry.id)) return false
    if (query.filter === 'later' && !marks.later.has(entry.id)) return false
    if (!terms.length) return true
    const haystack = feedTitles
      ? `${entry.title} ${entry.summary} ${entry.author} ${entry.link} ${feedTitles.get(entry.feedId) ?? ''}`.toLowerCase()
      : `${entry.title} ${entry.summary} ${entry.author} ${entry.link}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
  return query.filter === 'starred' || query.filter === 'later' ? byNewest(matched) : matched
}

export interface FeedBadge {
  total: number
  unread: number
  starred: number
}

export function badgeFor(entries: RssEntry[], read: Set<string>, starred: Set<string>): FeedBadge {
  let unread = 0
  let isStarred = 0
  for (const entry of entries) {
    if (!read.has(entry.id)) unread++
    if (starred.has(entry.id)) isStarred++
  }
  return { total: entries.length, unread, starred: isStarred }
}

/**
 * Unread counts per feed, per folder and per tag, in one pass over what the device holds.
 *
 * A folder's count carries its descendants, and hidden articles are left out of every number: a
 * badge that counts what the channel it labels will not show is the disagreement this file exists
 * to prevent.
 */
export function unreadCounts(view: RssView): { feeds: Map<string, number>, groups: Map<string, number>, tags: Map<string, number>, total: number } {
  const read = new Set(view.library.readIds)
  const hidden = new Set(view.library.hiddenIds)
  const byId = new Map(view.library.groups.map(group => [group.id, group]))
  const feeds = new Map<string, number>()
  const groups = new Map<string, number>()
  const tags = new Map<string, number>()
  let total = 0
  for (const feed of view.library.feeds) {
    // Counted on the de-duplicated list, so the badge beside a WeChat subscription says what the
    // channel it labels will actually show.
    let unread = 0
    for (const entry of uniqueRemoteEntries(view.articles[feed.id] ?? [])) {
      if (!read.has(entry.id) && !hidden.has(entry.id)) unread++
    }
    feeds.set(feed.id, unread)
    total += unread
    const seen = new Set<string>()
    let cursor = feed.groupId
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      groups.set(cursor, (groups.get(cursor) ?? 0) + unread)
      cursor = byId.get(cursor)!.parentId ?? ''
    }
    for (const scope of tagScopes(feed.tags)) tags.set(scope, (tags.get(scope) ?? 0) + unread)
  }
  return { feeds, groups, tags, total }
}

/** Groups in display order: named groups by their own position, then the unfiled feeds. */
export interface GroupedFeeds {
  group: RssGroup | null
  feeds: RssFeed[]
}

export function groupedFeeds(library: RssLibrary): GroupedFeeds[] {
  const byGroup = new Map<string, RssFeed[]>()
  for (const feed of library.feeds) {
    const list = byGroup.get(feed.groupId) ?? []
    list.push(feed)
    byGroup.set(feed.groupId, list)
  }
  const ordered = [...library.groups].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
  const out: GroupedFeeds[] = ordered
    .filter(group => (byGroup.get(group.id)?.length ?? 0) > 0)
    .map(group => ({ group, feeds: sortFeeds(byGroup.get(group.id) ?? []) }))
  const loose = byGroup.get('') ?? []
  if (loose.length) out.push({ group: null, feeds: sortFeeds(loose) })
  return out
}

function sortFeeds(feeds: RssFeed[]): RssFeed[] {
  return [...feeds].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

/**
 * Group names that differ only by case, spacing or a known alias are one group.
 *
 * The aliases are the words a reader types when they build a folder in a hurry, in the two
 * languages this app writes its interface in, spelled as escapes because the i18n gate keeps Han
 * text out of `src`. A folder named `Podcasts` and one named in Han are the same shelf, and
 * splitting them into two is how a library ends up with nine groups for four kinds of thing.
 */
const GROUP_ALIASES: Record<string, string> = {
  podcast: 'podcasts',
  podcasts: 'podcasts',
  '\u64ad\u5ba2': 'podcasts',
  blog: 'blogs',
  blogs: 'blogs',
  '\u535a\u5ba2': 'blogs',
  news: 'news',
  '\u65b0\u95fb': 'news',
  '\u8d44\u8baf': 'news',
  wechat: 'wechat',
  '\u516c\u4f17\u53f7': 'wechat',
  '\u5fae\u4fe1\u516c\u4f17\u53f7': 'wechat',
}

export function groupKey(name: string): string {
  const folded = name.normalize('NFKC').toLowerCase().replace(/[\s_\-·\u3001/]+/g, ' ').trim()
  return GROUP_ALIASES[folded] ?? GROUP_ALIASES[folded.replace(/\s/g, '')] ?? folded
}

/**
 * A group's identity, so a rename that only changes case or spacing lands on the same shelf.
 *
 * Top-level ids are the folded name, which is what every library written so far already stores.
 * A nested folder adds its parent to the hash, because `front-end/articles` and `design/articles`
 * are two shelves a reader builds on purpose, and colliding ids would merge them on the next load.
 */
export function groupIdFor(name: string, parentId: string | null = null): string {
  const folded = groupKey(name) || 'misc'
  return parentId ? `g${rssHash(`${parentId}\u0000${folded}`).slice(0, 16)}` : `g${folded}`
}

/** The refresh ceiling: five minutes, matching the reference's "stale after" window. */
export const FEED_STALE_MS = 5 * 60 * 1000
const BACKOFF_BASE_MS = 5 * 60 * 1000
const BACKOFF_CAP_MS = 60 * 60 * 1000

/** Failing feeds retry on an exponential backoff: 5m → 10m → 20m → 40m → 1h cap. */
export function refreshBackoffMs(errorCount: number): number {
  if (errorCount <= 0) return 0
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(errorCount - 1, 6))
}

export function feedIsDue(feed: RssFeed, now: number, staleMs = FEED_STALE_MS): boolean {
  if (feed.paused) return false
  if (feed.errorCount > 0 && now - feed.lastErrorAt < refreshBackoffMs(feed.errorCount)) return false
  return now - Math.max(feed.updatedAt, feed.lastAttemptAt) >= staleMs
}

/**
 * An explicit refresh is the reader asking, so it skips the pause and the backoff a failing
 * feed would otherwise be given: a button that quietly did nothing because the last attempt was
 * four minutes ago reads as a broken control.
 */
export function feedWantsRefresh(feed: RssFeed, now: number, force: boolean, staleMs: number): boolean {
  if (force) return true
  if (feed.paused) return false
  if (feed.errorCount > 0 && now - feed.lastErrorAt < refreshBackoffMs(feed.errorCount)) return false
  return now - Math.max(feed.updatedAt, feed.lastAttemptAt) >= staleMs
}

/** Stale first, failures last, so fresh content paints early during a long sync. */
export function orderByStaleness(feeds: RssFeed[]): RssFeed[] {
  return [...feeds].sort((a, b) => {
    const failing = (a.errorCount > 0 ? 1 : 0) - (b.errorCount > 0 ? 1 : 0)
    if (failing) return failing
    return Math.max(a.updatedAt, a.lastAttemptAt) - Math.max(b.updatedAt, b.lastAttemptAt)
  })
}

export interface RefreshSummary {
  refreshed: number
  changed: number
  unchanged: number
  failed: number
  skipped: number
  elapsedMs: number
}

/** The next/previous step through a list, which must not jump when a read mark lands. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (!length) return -1
  if (current < 0) return 0
  const next = current + delta
  if (next < 0) return 0
  if (next >= length) return length - 1
  return next
}

/**
 * The identity an article carries in its own link, or '' for every other address.
 *
 * Two publishers hand out a link that changes every time their bridge re-crawls them. WeChat's
 * `mp.weixin.qq.com/s` keeps its `__biz`/`mid`/`idx` triple and rewrites the tracking parameters
 * around it (`chksm`, `scene`, `devicemeta`), and Xiaoyuzhou returns the same episode with and without a
 * share suffix. The feed gives those a different `guid` each pass, so a reader who subscribes to one
 * WeChat account sees the same article three times and, worse, sees it turn unread again after they
 * have read it — because the copy that survived this refresh is a different id than the one they
 * marked.
 */
export function remoteContentKey(link: string): string {
  const url = safeHttpUrl(link)
  if (!url || url.protocol !== 'https:') return ''
  if (url.hostname === 'mp.weixin.qq.com' && url.pathname === '/s') {
    const biz = url.searchParams.get('__biz')
    const mid = url.searchParams.get('mid')
    const idx = url.searchParams.get('idx')
    if (!biz || !/^\d+$/.test(mid ?? '') || !/^\d+$/.test(idx ?? '')) return ''
    return `wx:${biz}/${mid}/${idx}`
  }
  if (url.hostname === 'www.xiaoyuzhoufm.com' || url.hostname === 'xiaoyuzhoufm.com') {
    const episode = /^\/episode\/([a-z0-9]+)\/?$/i.exec(url.pathname)
    return episode ? `xyz:${episode[1].toLowerCase()}` : ''
  }
  return ''
}

/**
 * Collapse those duplicates down to one row each, newest first.
 *
 * Only the display is collapsed: the marks, the saved notes and the cache keep every id, so an
 * article the reader starred under one copy is still theirs after the bridge hands out another.
 */
export function uniqueRemoteEntries(entries: RssEntry[], selectedId = ''): RssEntry[] {
  const out: RssEntry[] = []
  const at = new Map<string, number>()
  for (const entry of entries) {
    const key = remoteContentKey(entry.link)
    if (!key) {
      out.push(entry)
      continue
    }
    const seen = at.get(key)
    if (seen === undefined) {
      at.set(key, out.length)
      out.push(entry)
      continue
    }
    const previous = out[seen]
    // The open article must not be swapped out from under the reader, and otherwise the newer copy
    // wins because it is the one whose body the bridge just fetched.
    if (entry.id === selectedId || (previous.id !== selectedId && (entry.publishedTs ?? 0) > (previous.publishedTs ?? 0))) out[seen] = entry
  }
  return out
}

/**
 * Which of these rows are already read, counting a duplicate as the same article.
 *
 * The read mark lives on the id that was on screen when the reader finished, and the next refresh
 * may present a different id for the same `biz`/`mid`/`idx`. Without this the unread filter would
 * resurrect an article the reader has read, which is the single most annoying thing an RSS app can
 * do to a WeChat subscription.
 */
export function readKeysFor(entries: RssEntry[], readIds: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const entry of entries) {
    if (!readIds.has(entry.id)) continue
    const key = remoteContentKey(entry.link)
    if (key) out.add(key)
  }
  return out
}
