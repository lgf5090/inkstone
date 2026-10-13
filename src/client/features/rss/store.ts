/**
 * The reader's state: what is subscribed, what this device has read, and what is on screen.
 *
 * Three stores meet here, and the split is the design:
 *
 *  — the **library** (subscriptions, groups, read marks, favourites) belongs to the account and
 *    travels between devices, so it is saved to the Worker, debounced, and refused outright if it
 *    would arrive truncated;
 *  — the **articles** belong to this device. They are rebuildable from the network, so they go in
 *    IndexedDB under a byte ceiling rather than into the account row, where 400 feeds would be a
 *    megabyte per save;
 *  — the **view** (which article, which filter, how far down the list) is transient enough that
 *    losing it costs a reader a second, so it is kept per channel in memory and written out with
 *    the cache index rather than synced.
 *
 * Everything that can fail does so here rather than in a component: a refresh that half-worked has
 * to leave the feeds that answered showing their new articles and the ones that did not keeping
 * their old ones, and a save the server refused has to stay pending so the reader's next action
 * carries it instead of losing it.
 */
import { create } from 'zustand'
import {
  canonicalFeedUrl,
  safeHttpUrl,
  emptyLibrary,
  feedIdFor,
  newFeed,
  newGroup,
  parseRssLibrary,
  RSS_LIMITS,
  type RssEntry,
  type RssFeed,
  type RssGroup,
  type RssLibrary,
} from '@shared/rss/model'
import { channelKey, descendantGroupIds, feedWantsRefresh, groupIdFor, groupKey, orderByStaleness, parseChannelKey, refreshBackoffMs, type RssChannel, type RssFilter, type RssSort } from '@shared/rss/reading'
import { FeedParseError, parseFeed, type ParsedFeed } from '../../lib/rss/feed'
import type { LinkPlatform } from '@shared/rss/platform'
import type { RssAiKind } from './ai'
import { api } from '../../lib/api'
import { localDb } from '../../lib/db'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { sanitizeFeedHtml } from './sanitize'

/** Which version of the article the reader is looking at: the author's, or an answer about it. */
export type RssReadingVersion = 'original' | 'summary' | 'translation'

/** What a model already answered about one article, kept on the device that asked. */
export interface RssAiResult {
  summary?: string
  translation?: string
  at: number
}

export interface RssChannelView {
  entryId: string
  filter: RssFilter
  query: string
  sort: RssSort
  version: RssReadingVersion
  /** One platform of the channel, or all of them. */
  platform: LinkPlatform | 'all'
  listTop: number
  readerTop: number
}

export interface RssAddResult {
  ok: boolean
  feed?: RssFeed
  error?: string
}

export interface RssRefreshSummary {
  refreshed: number
  changed: number
  unchanged: number
  failed: number
  skipped: number
  elapsedMs: number
}

/** What one feed's blob on this device costs, as the durable index recorded it. */
export interface RssCacheMeta {
  fetchedAt: number
  /** Characters of title, summary and body. The LRU ceiling is counted in these. */
  bytes: number
  /** The part of {@link RssCacheMeta.bytes} that is article body. Absent for a feed this build has
   * not stored or read since the field existed, which the storage panel says instead of guessing. */
  body?: number
  /** Articles in the blob, so a cold load can say what it holds without reading it. */
  count?: number
}

export interface RssState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  library: RssLibrary
  /** feedId → the articles this device holds, newest first as the feed sent them. */
  articles: Record<string, RssEntry[]>
  fetchedAt: Record<string, number>
  /** Per feed: when this device last stored it and what that storage costs. Survives a reload. */
  cache: Record<string, RssCacheMeta>
  /** What a model answered, per article, on this device. */
  results: Record<string, RssAiResult>
  /** What {@link RssState.loadAllCached} built, or null before the first search asks for it. */
  allCached: RssEntry[] | null
  views: Record<string, RssChannelView>
  channel: RssChannel
  refreshing: string[]
  progress: { done: number, total: number } | null
  saveError: string | null
  savedAt: number
  load: () => Promise<void>
  reset: () => void
  open: (channel: RssChannel) => Promise<void>
  setFilter: (filter: RssFilter) => void
  setQuery: (query: string) => void
  setListTop: (top: number) => void
  setReaderTop: (top: number) => void
  setSort: (sort: RssSort) => void
  /** Show one platform of this channel — its videos, its bridged posts — or all of it. */
  setPlatform: (platform: LinkPlatform | 'all') => void
  /** Which version of the article is on the reading pane. */
  setVersion: (version: RssReadingVersion) => void
  /** Keep a model's answer about one article, so the reader does not pay for it twice. */
  rememberResult: (entryId: string, kind: RssAiKind, text: string) => void
  /** Drop the stored answer of one kind for one article. */
  forgetResult: (entryId: string, kind: RssAiKind) => void
  /** Dismiss articles: they leave every channel until the reader undoes it. */
  hideEntries: (entryIds: string[], hidden: boolean) => void
  setFeedTags: (feedId: string, tags: string[]) => void
  addGroup: (name: string, parentId?: string | null) => string
  /** Re-parent and reorder a folder in one step; a cycle is refused, not repaired later. */
  moveGroupTo: (groupId: string, parentId: string | null, index?: number) => void
  setGroupAppearance: (groupId: string, patch: { icon?: string | null, color?: string | null }) => void
  moveFeedTo: (feedId: string, groupId: string, index?: number) => void
  openEntry: (entryId: string) => void
  view: () => RssChannelView
  markRead: (entryIds: string[], read: boolean) => void
  toggleFavorite: (entryId: string) => void
  toggleLater: (entryId: string) => void
  markOpened: (entryId: string) => void
  rememberSavedNote: (entryId: string, kind: string, noteId: string) => void
  refresh: (feedIds?: string[], options?: { force?: boolean, staleMs?: number }) => Promise<RssRefreshSummary>
  addFeed: (url: string, groupId?: string) => Promise<RssAddResult>
  importFeeds: (inputs: Array<{ url: string, title: string, group: string, groupPath?: string[] }>) => Promise<number>
  removeFeed: (feedId: string) => void
  renameFeed: (feedId: string, title: string) => void
  moveFeed: (feedId: string, groupId: string) => void
  setPaused: (feedId: string, paused: boolean) => void
  renameGroup: (groupId: string, name: string) => void
  removeGroup: (groupId: string) => void
  toggleGroupCollapsed: (groupId: string) => void
  /** Every article this device holds, bodies dropped, built once and kept for the session. */
  loadAllCached: () => Promise<RssEntry[]>
  clearCache: () => Promise<void>
  /**
   * Drop the article bodies this device holds and keep the rows: the list still reads, the marks and
   * the notes stay, and the bytes come back from the feeds when the reader opens something.
   */
  clearBodies: () => Promise<number>
  flush: () => Promise<void>
  retrySave: () => void
}

const DEFAULT_VIEW: RssChannelView = { entryId: '', filter: 'all', query: '', sort: 'newest', version: 'original', platform: 'all', listTop: 0, readerTop: 0 }
/** How many articles keep a model's answer, and how much text that may be, on this device. */
const RESULT_ARTICLES = 200
const RESULT_CHARS = 400_000
/**
 * A clock that cannot repeat.
 *
 * The answer budget is spent newest-first, so two answers written in the same millisecond still have
 * to order themselves — otherwise the trim keeps an arbitrary half of them and the reader loses the
 * one they asked for a second ago.
 */
let lastResultAt = 0
function resultStamp(): number {
  lastResultAt = Math.max(Date.now(), lastResultAt + 1)
  return lastResultAt
}
const FETCH_BATCH = 25
const SAVE_DEBOUNCE_MS = 900
/** How many of a merged channel's feeds are read into memory when it is opened. */
const PREPARE_LIMIT = 80

interface CacheIndex {
  articles: Record<string, RssCacheMeta>
  views: Record<string, RssChannelView>
}

function emptyIndex(): CacheIndex {
  return { articles: {}, views: {} }
}

export const useRss = create<RssState>((set, get) => {
  let saveTimer = 0
  let saveInFlight: Promise<void> | null = null
  let dirty = false
  let index: CacheIndex = emptyIndex()
  const loading = new Map<string, Promise<void>>()

  function scheduleSave(): void {
    dirty = true
    if (saveTimer) return
    saveTimer = window.setTimeout(() => {
      saveTimer = 0
      void flushSave()
    }, SAVE_DEBOUNCE_MS)
  }

  /** The one place a library is written out: never twice at once, and retried by the next action. */
  function flushSave(): Promise<void> {
    // Asked for while another write is still out: queue behind it rather than dropping the
    // change. Returning the in-flight promise alone left the newest library unsaved until the
    // reader did something else, which is how a debounce can lose the last keystroke.
    if (saveInFlight) return saveInFlight.then(() => (dirty ? flushSave() : undefined))
    if (!dirty) return Promise.resolve()
    const run: Promise<void> = (async () => {
      try {
        await api.rss.save(JSON.stringify(get().library))
        dirty = false
        set({ saveError: null, savedAt: Date.now() })
      }
      catch (error) {
        // `dirty` stays set: a save the server refused is not a save that happened, and the next
        // action should carry the earlier one with it rather than lose both.
        set({ saveError: error instanceof Error && error.message ? error.message : t('rss.error.save_failed') })
        console.warn('[inkstone] RSS library save failed', error)
      }
    })()
    saveInFlight = run
    void run.finally(() => {
      if (saveInFlight === run) saveInFlight = null
    })
    return run
  }

  function writeIndex(): void {
    void localDb.saveRssCacheIndex(index)
  }

  /** What one feed's articles cost, split so the storage panel can say what the bytes are. */
  function cacheMeta(entries: RssEntry[], fetchedAt: number): RssCacheMeta {
    let body = 0
    let bytes = 0
    for (const entry of entries) {
      body += entry.content.length
      bytes += entry.content.length + entry.summary.length + entry.title.length
    }
    return { fetchedAt, bytes, body, count: entries.length }
  }

  /** Hand the durable index to the components that show it. The index itself stays module-private. */
  function publishCache(): void {
    set({ cache: { ...index.articles } })
  }

  /** Keep the device cache inside its ceiling by dropping the feeds it has touched least recently. */
  async function trimCache(): Promise<void> {
    let total = Object.values(index.articles).reduce((sum, meta) => sum + meta.bytes, 0)
    if (total <= RSS_LIMITS.cacheBytes) return
    for (const [feedId, meta] of Object.entries(index.articles).sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)) {
      if (total <= RSS_LIMITS.cacheBytes) break
      delete index.articles[feedId]
      total -= meta.bytes
      await localDb.dropRssArticles(feedId)
      set((state) => {
        const articles = { ...state.articles }
        const fetchedAt = { ...state.fetchedAt }
        delete articles[feedId]
        delete fetchedAt[feedId]
        return { articles, fetchedAt }
      })
    }
    writeIndex()
    publishCache()
  }

  async function storeArticles(feedId: string, entries: RssEntry[]): Promise<void> {
    const fetched = Date.now()
    index = { ...index, articles: { ...index.articles, [feedId]: cacheMeta(entries, fetched) } }
    await localDb.saveRssArticles({ feedId, fetchedAt: fetched, entries })
    // The index is what a later load asks before it goes to the network: which feeds this device
    // really holds, when it last saw them, and how much room they take. Written only here, it stays
    // true to the blobs beside it — and a reload gets to keep its conditional GETs instead of
    // refetching every subscription because the ledger said nothing was cached.
    writeIndex()
    publishCache()
    set(state => ({
      articles: { ...state.articles, [feedId]: entries },
      fetchedAt: { ...state.fetchedAt, [feedId]: fetched },
    }))
    await trimCache()
  }

  /** Read one feed's articles back from the device cache, at most once per feed at a time. */
  function ensureArticles(feedId: string): Promise<void> {
    if (get().articles[feedId]) return Promise.resolve()
    const ongoing = loading.get(feedId)
    if (ongoing) return ongoing
    const run = (async () => {
      const cached = await localDb.loadRssArticles(feedId)
      if (!cached) {
        // The index is what a refresh trusts to decide whether a validator is worth sending. An
        // entry whose blob is gone would vouch for a list this device does not have, and the feed
        // would answer `304` to a browser that has nothing to show.
        if (index.articles[feedId]) {
          delete index.articles[feedId]
          writeIndex()
        }
        return
      }
      // A blob written before this build measured bodies and counts: record what it really holds
      // now, so the storage panel and the per-source lines tell the truth without waiting for a
      // refresh to overwrite the feed with the same articles.
      const held = index.articles[feedId]
      if (!held || held.count === undefined || held.body === undefined) {
        index = { ...index, articles: { ...index.articles, [feedId]: cacheMeta(cached.entries, cached.fetchedAt) } }
        writeIndex()
        publishCache()
      }
      set((state) => {
        if (state.articles[feedId]) return state
        return {
          articles: { ...state.articles, [feedId]: cached.entries },
          fetchedAt: { ...state.fetchedAt, [feedId]: cached.fetchedAt },
        }
      })
    })().finally(() => loading.delete(feedId))
    loading.set(feedId, run)
    return run
  }

  function patchFeed(feedId: string, patch: Partial<RssFeed>): void {
    set(state => ({
      library: {
        ...state.library,
        feeds: state.library.feeds.map(feed => (feed.id === feedId ? { ...feed, ...patch } : feed)),
      },
    }))
  }

  function markFeedFailed(feed: RssFeed, error: string): void {
    patchFeed(feed.id, {
      error: error.slice(0, RSS_LIMITS.errorChars),
      lastAttemptAt: Date.now(),
      errorCount: feed.errorCount + 1,
      lastErrorAt: Date.now(),
    })
  }

  function viewKey(): string {
    return channelKey(get().channel)
  }

  function readView(key: string): RssChannelView {
    const stored = get().views[key]
    if (stored) return stored
    const rss = useSession.getState().settings.rss
    return {
      ...DEFAULT_VIEW,
      filter: rss.defaultFilter === 'unread' || rss.defaultFilter === 'starred' ? rss.defaultFilter : 'all',
      sort: rss.sortOrder,
    }
  }

  function writeView(key: string, patch: Partial<RssChannelView>): void {
    const next = { ...readView(key), ...patch }
    set(state => ({ views: { ...state.views, [key]: next } }))
    index = { ...index, views: { ...index.views, [key]: next } }
    writeIndex()
  }

  /** The feeds a channel is made of, with their articles read into memory first. */
  async function prepare(channel: RssChannel): Promise<void> {
    const { feeds } = get().library
    const members = channel.kind === 'feed'
      ? feeds.filter(feed => feed.id === channel.feedId)
      : channel.kind === 'group'
        ? feeds.filter(feed => feed.groupId === channel.groupId)
        : channel.kind === 'vault'
          ? []
          : feeds
    await Promise.all(members.slice(0, PREPARE_LIMIT).map(feed => ensureArticles(feed.id)))
  }

  /**
   * One feed's worth of parsing, or null when the document is not a feed.
   *
   * Bodies are sanitized here, once, on the way into the cache — so what a reader later saves to a
   * note is the same string they were shown, and a corrupt document cannot take a whole refresh
   * down with it.
   */
  function parseArticle(xml: string, url: string): (ParsedFeed & { entries: RssEntry[] }) | null {
    try {
      const parsed = parseFeed(xml, url)
      return { ...parsed, entries: parsed.entries.map(entry => ({ ...entry, content: sanitizeFeedHtml(entry.content, entry.link) })) }
    }
    catch (error) {
      if (error instanceof FeedParseError) return null
      console.warn('[inkstone] RSS document could not be read', url, error)
      return null
    }
  }

  function reasonMessage(reason: string): string {
    switch (reason) {
      case 'timeout':
        return t('rss.error.timeout')
      case 'too-large':
        return t('rss.error.too_large')
      case 'not-a-feed':
        return t('rss.error.not_a_feed')
      case 'blocked':
        return t('rss.error.blocked')
      case 'http':
        return t('rss.error.http_status')
      default:
        return t('rss.error.unreachable')
    }
  }

  /** Find the folder a name belongs to under one parent, or add it. Names that fold together
   * land in one shelf, and only within the parent they were typed under.
   */
  function groupForName(groups: RssGroup[], name: string, parentId: string | null = null): { list: RssGroup[], id: string } {
    const trimmed = name.trim().slice(0, RSS_LIMITS.groupChars)
    if (!trimmed) return { list: groups, id: '' }
    const id = groupIdFor(trimmed, parentId)
    if (groups.some(group => group.id === id)) return { list: groups, id }
    return { list: [...groups, newGroup(id, trimmed, groups.length, parentId)], id }
  }

  const byPosition = (a: { position: number }, b: { position: number }): number => a.position - b.position

  return {
    status: 'idle',
    library: emptyLibrary(),
    articles: {},
    fetchedAt: {},
    cache: {},
    results: {},
    allCached: null,
    views: {},
    channel: { kind: 'all' },
    refreshing: [],
    progress: null,
    saveError: null,
    savedAt: 0,

    async load() {
      if (get().status === 'loading' || get().status === 'ready') return
      set({ status: 'loading' })
      const [storedIndex, storedResults] = await Promise.all([localDb.loadRssCacheIndex(), localDb.loadRssResults()])
      index = normaliseIndex(storedIndex)
      publishCache()
      set({ results: normaliseResults(storedResults) })
      let library: RssLibrary
      try {
        const response = await api.rss.load()
        library = parseRssLibrary(response.library).data ?? emptyLibrary()
        set({ savedAt: response.savedAt })
      }
      catch (error) {
        console.warn('[inkstone] RSS library could not be loaded', error)
        set({
          status: 'error',
          saveError: error instanceof Error && error.message ? error.message : t('rss.error.load_failed'),
        })
        return
      }
      const channel = parseChannelKey(library.lastChannel)
      set({ library, views: index.views, channel, status: 'ready' })
      await prepare(channel)
      // A feed this device holds no articles for is stale by definition: a second browser, a
      // cleared cache or an eviction all leave the subscription list intact and the reading empty,
      // and rss.no_articles is not an honest answer when the feed was never asked for.
      const missing = library.feeds.filter(feed => !feed.paused && !index.articles[feed.id])
      if (missing.length) void get().refresh(missing.map(feed => feed.id))
      const interval = useSession.getState().settings.rss.refreshIntervalMinutes * 60_000
      if (interval <= 0) return
      const now = Date.now()
      const due = library.feeds
        .filter(feed => !feed.paused)
        .filter(feed => now - Math.max(feed.updatedAt, feed.lastAttemptAt) >= Math.max(interval, refreshBackoffMs(feed.errorCount)))
      if (due.length) void get().refresh(due.map(feed => feed.id))
    },

    reset() {
      if (saveTimer) window.clearTimeout(saveTimer)
      saveTimer = 0
      dirty = false
      index = emptyIndex()
      loading.clear()
      set({
        status: 'idle',
        library: emptyLibrary(),
        articles: {},
        fetchedAt: {},
        cache: {},
        results: {},
        allCached: null,
        views: {},
        channel: { kind: 'all' },
        refreshing: [],
        progress: null,
        saveError: null,
        savedAt: 0,
      })
    },

    async open(channel) {
      const key = channelKey(channel)
      set(state => ({ channel, library: { ...state.library, lastChannel: key } }))
      scheduleSave()
      await prepare(channel)
    },

    setFilter(filter) {
      writeView(viewKey(), { filter })
    },

    setQuery(query) {
      writeView(viewKey(), { query })
    },

    setListTop(listTop) {
      writeView(viewKey(), { listTop })
    },

    setReaderTop(readerTop) {
      writeView(viewKey(), { readerTop })
    },

    setSort(sort) {
      writeView(viewKey(), { sort })
    },

    setPlatform(platform) {
      writeView(viewKey(), { platform })
    },

    setVersion(version) {
      writeView(viewKey(), { version })
    },

    rememberResult(entryId, kind, text) {
      const answer = text.trim()
      if (!entryId || !answer) return
      set((state) => {
        const current = state.results[entryId] ?? { at: 0 }
        const next: RssAiResult = { ...current, at: resultStamp(), [kind]: answer }
        return { results: trimResults({ ...state.results, [entryId]: next }) }
      })
      void localDb.saveRssResults(get().results)
    },

    forgetResult(entryId, kind) {
      set((state) => {
        const current = state.results[entryId]
        if (!current || !current[kind]) return state
        const next = { ...current }
        delete next[kind]
        const results = { ...state.results }
        if (next.summary || next.translation) results[entryId] = next
        else delete results[entryId]
        return { results: trimResults(results) }
      })
      void localDb.saveRssResults(get().results)
    },

    hideEntries(entryIds, hidden) {
      if (!entryIds.length) return
      set((state) => {
        const dropping = new Set(entryIds)
        const kept = state.library.hiddenIds.filter(id => !dropping.has(id))
        // Newest-first like the read marks, so the ceiling drops the oldest dismissals.
        const hiddenIds = hidden ? [...new Set([...entryIds, ...kept])].slice(0, RSS_LIMITS.hiddenIds) : kept
        return { library: { ...state.library, hiddenIds } }
      })
      scheduleSave()
    },

    setFeedTags(feedId, tags) {
      patchFeed(feedId, { tags: tags.slice(0, RSS_LIMITS.tagsPerFeed) })
      scheduleSave()
    },

    moveFeedTo(feedId, groupId, index = -1) {
      set((state) => {
        const feeds = state.library.feeds.map(feed => ({ ...feed }))
        const at = feeds.findIndex(feed => feed.id === feedId)
        if (at < 0) return {}
        const [moving] = feeds.splice(at, 1)
        moving.groupId = groupId
        // The array itself follows the shelf order, because a merged list reads the library in
        // array order: renumbering the field while the array stayed behind would sort two ways.
        const shelf: number[] = []
        feeds.forEach((feed, position) => {
          if (feed.groupId === groupId) shelf.push(position)
        })
        const wanted = index < 0 || index > shelf.length ? shelf.length : index
        const into = wanted >= shelf.length ? feeds.length : shelf[wanted]
        feeds.splice(into, 0, moving)
        feeds
          .filter(feed => feed.groupId === groupId)
          .forEach((feed, position) => { feed.order = position })
        return { library: { ...state.library, feeds } }
      })
      scheduleSave()
    },

    moveGroupTo(groupId, parentId, index = -1) {
      set((state) => {
        const groups = state.library.groups.map(group => ({ ...group }))
        const moving = groups.find(group => group.id === groupId)
        if (!moving) return {}
        if (parentId && (parentId === groupId || descendantGroupIds(groups, groupId).has(parentId))) return {}
        moving.parentId = parentId
        const siblings = groups.filter(group => (group.parentId ?? '') === (parentId ?? '') && group.id !== groupId).sort(byPosition)
        siblings.splice(index < 0 ? siblings.length : Math.min(index, siblings.length), 0, moving)
        const now = Date.now()
        siblings.forEach((group, position) => { group.position = position; group.updatedAt = now })
        return { library: { ...state.library, groups } }
      })
      scheduleSave()
    },

    setGroupAppearance(groupId, patch) {
      set(state => ({
        library: {
          ...state.library,
          groups: state.library.groups.map(group => (group.id === groupId ? { ...group, ...patch, updatedAt: Date.now() } : group)),
        },
      }))
      scheduleSave()
    },

    openEntry(entryId) {
      writeView(viewKey(), { entryId })
      get().markOpened(entryId)
      if (useSession.getState().settings.rss.markReadOnOpen) get().markRead([entryId], true)
    },

    view: () => readView(viewKey()),

    markRead(entryIds, read) {
      if (!entryIds.length) return
      set((state) => {
        const dropping = new Set(entryIds)
        const kept = state.library.readIds.filter(id => !dropping.has(id))
        // Read marks are kept newest-first so the ceiling drops the oldest history, not today's.
        const readIds = read ? [...new Set([...entryIds, ...kept])].slice(0, RSS_LIMITS.readIds) : kept
        return { library: { ...state.library, readIds } }
      })
      scheduleSave()
    },

    toggleFavorite(entryId) {
      set((state) => {
        const has = state.library.favorites.includes(entryId)
        const favorites = has
          ? state.library.favorites.filter(id => id !== entryId)
          : [entryId, ...state.library.favorites].slice(0, RSS_LIMITS.favorites)
        return { library: { ...state.library, favorites } }
      })
      scheduleSave()
    },

    toggleLater(entryId) {
      set((state) => {
        const has = state.library.readLater.includes(entryId)
        const readLater = has
          ? state.library.readLater.filter(id => id !== entryId)
          : [entryId, ...state.library.readLater].slice(0, RSS_LIMITS.readLater)
        return { library: { ...state.library, readLater } }
      })
      scheduleSave()
    },

    markOpened(entryId) {
      set(state => ({ library: { ...state.library, opened: { ...state.library.opened, [entryId]: Date.now() } } }))
      scheduleSave()
    },

    rememberSavedNote(entryId, kind, noteId) {
      set(state => ({
        library: { ...state.library, savedNotes: { ...state.library.savedNotes, [`${entryId}|${kind}`]: noteId } },
      }))
      scheduleSave()
    },

    async refresh(feedIds, options = {}) {
      const started = Date.now()
      const now = Date.now()
      const { feeds } = get().library
      const wanted = new Set(feedIds?.length ? feedIds : feeds.map(feed => feed.id))
      const candidates = orderByStaleness(feeds.filter(feed => wanted.has(feed.id)
      && feedWantsRefresh(feed, now, options.force === true, options.staleMs ?? 0)))
      if (!candidates.length) {
        return { refreshed: 0, changed: 0, unchanged: 0, failed: 0, skipped: 0, elapsedMs: 0 }
      }
      set({ refreshing: candidates.map(feed => feed.id), progress: { done: 0, total: candidates.length } })
      let changed = 0
      let unchanged = 0
      let failed = 0
      let done = 0
      try {
        for (let offset = 0; offset < candidates.length; offset += FETCH_BATCH) {
          const batch = candidates.slice(offset, offset + FETCH_BATCH)
          let results: Awaited<ReturnType<typeof api.rss.fetch>>['results'] = []
          try {
            results = (await api.rss.fetch(batch.map(feed => {
              // A validator is only worth sending to a device that has something to validate. The
              // library carries the etag across browsers, so a second device that asked anyway got
              // `304 Not Modified` for a list it did not have — and stayed empty forever.
              const holds = !!index.articles[feed.id]
              return {
                url: feed.url,
                etag: options.force || !holds ? undefined : feed.etag || undefined,
                lastModified: options.force || !holds ? undefined : feed.lastModified || undefined,
              }
            }))).results
          }
          catch (error) {
            // The whole batch is unreachable: keep each feed's old articles and count them failed.
            for (const feed of batch) markFeedFailed(feed, error instanceof Error && error.message ? error.message : t('rss.error.unreachable'))
            failed += batch.length
            done += batch.length
            set({ progress: { done, total: candidates.length } })
            continue
          }
          for (const feed of batch) {
            const result = results.find(item => canonicalFeedUrl(item.url) === canonicalFeedUrl(feed.url))
            if (!result) continue
            if (!result.ok) {
              failed++
              markFeedFailed(feed, result.reason ? reasonMessage(result.reason) : t('rss.error.unreachable'))
              continue
            }
            if (result.status === 304) {
              unchanged++
              patchFeed(feed.id, { updatedAt: Date.now(), lastAttemptAt: Date.now(), error: '', errorCount: 0, lastErrorAt: 0 })
              continue
            }
            const parsed = parseArticle(result.xml ?? '', feed.url)
            if (!parsed) {
              failed++
              markFeedFailed(feed, t('rss.error.not_a_feed'))
              continue
            }
            changed++
            patchFeed(feed.id, {
              title: parsed.title || feed.title,
              siteUrl: parsed.siteUrl || feed.siteUrl,
              imageUrl: parsed.imageUrl || feed.imageUrl,
              updatedAt: Date.now(),
              lastAttemptAt: Date.now(),
              error: '',
              errorCount: 0,
              lastErrorAt: 0,
              etag: result.etag ?? feed.etag,
              lastModified: result.lastModified ?? feed.lastModified,
            })
            await storeArticles(feed.id, parsed.entries)
          }
          done += batch.length
          set({ progress: { done, total: candidates.length } })
        }
      }
      finally {
        set({ refreshing: [], progress: null })
      }
      scheduleSave()
      await flushSave()
      return {
        refreshed: done,
        changed,
        unchanged,
        failed,
        skipped: candidates.length - done,
        elapsedMs: Date.now() - started,
      }
    },

    async addFeed(rawUrl, groupId = '') {
      // The address is fetched exactly as the reader wrote it and canonicalisation is only ever
      // a comparison: `www.` and a trailing slash are how a host is *named*, not what it answers to,
      // and asking for the folded form can get a refusal the written form never would.
      const written = safeHttpUrl((rawUrl || '').trim())
      if (!written) return { ok: false, error: t('rss.error.url_invalid') }
      const url = written.href
      if (get().library.feeds.some(feed => canonicalFeedUrl(feed.url) === canonicalFeedUrl(url))) {
        return { ok: false, error: t('rss.error.already_subscribed') }
      }
      if (get().library.feeds.length >= RSS_LIMITS.feeds) {
        return { ok: false, error: t('rss.error.feed_limit', { n: RSS_LIMITS.feeds }) }
      }
      let result
      try {
        result = (await api.rss.fetch([{ url }])).results[0]
      }
      catch (error) {
        return { ok: false, error: error instanceof Error && error.message ? error.message : t('rss.error.unreachable') }
      }
      if (!result?.ok || !result.xml) {
        return { ok: false, error: result?.reason ? reasonMessage(result.reason) : t('rss.error.unreachable') }
      }
      const parsed = parseArticle(result.xml, url)
      if (!parsed) return { ok: false, error: t('rss.error.not_a_feed') }
      const id = feedIdFor(url)
      const feed = newFeed(id, url, parsed.title || new URL(url).hostname, get().library.feeds.length)
      feed.groupId = groupId
      feed.siteUrl = parsed.siteUrl
      feed.imageUrl = parsed.imageUrl
      feed.updatedAt = Date.now()
      feed.lastAttemptAt = Date.now()
      feed.etag = result.etag ?? ''
      feed.lastModified = result.lastModified ?? ''
      set(state => ({ library: { ...state.library, feeds: [...state.library.feeds, feed] } }))
      await storeArticles(id, parsed.entries)
      scheduleSave()
      await get().open({ kind: 'feed', feedId: id })
      return { ok: true, feed }
    },

    async importFeeds(inputs) {
      const seen = new Set(get().library.feeds.map(feed => canonicalFeedUrl(feed.url)))
      let groups = get().library.groups
      const additions: RssFeed[] = []
      let order = get().library.feeds.length
      for (const input of inputs) {
        const written = safeHttpUrl((input.url || '').trim())
        if (!written) continue
        const url = written.href
        if (seen.has(canonicalFeedUrl(url))) continue
        if (additions.length + order >= RSS_LIMITS.feeds) break
        // An OPML outline chain becomes the same chain of folders here, so a reader who nests
        // their subscriptions gets them back nested instead of as one shelf with a slash in the name.
        let parentId: string | null = null
        for (const name of input.groupPath?.length ? input.groupPath : input.group ? [input.group] : []) {
          const next = groupForName(groups, name, parentId)
          if (!next.id) break
          groups = next.list
          parentId = next.id
        }
        const feed = newFeed(feedIdFor(url), url, input.title || new URL(url).hostname, order++)
        feed.groupId = parentId ?? ''
        additions.push(feed)
        seen.add(canonicalFeedUrl(url))
      }
      if (!additions.length) return 0
      set(state => ({ library: { ...state.library, feeds: [...state.library.feeds, ...additions], groups } }))
      scheduleSave()
      await flushSave()
      return additions.length
    },

    removeFeed(feedId) {
      set((state) => {
        const library: RssLibrary = {
          ...state.library,
          feeds: state.library.feeds.filter(feed => feed.id !== feedId),
        }
        const articles = { ...state.articles }
        const fetchedAt = { ...state.fetchedAt }
        delete articles[feedId]
        delete fetchedAt[feedId]
        return { library, articles, fetchedAt }
      })
      void localDb.dropRssArticles(feedId)
      const articles = { ...index.articles }
      delete articles[feedId]
      index = { ...index, articles }
      writeIndex()
      publishCache()
      scheduleSave()
    },

    renameFeed(feedId, title) {
      patchFeed(feedId, { title: title.trim().slice(0, RSS_LIMITS.nameChars) })
      scheduleSave()
    },

    moveFeed(feedId, groupId) {
      patchFeed(feedId, { groupId })
      scheduleSave()
    },

    setPaused(feedId, paused) {
      patchFeed(feedId, { paused, ...(paused ? {} : { errorCount: 0, lastErrorAt: 0 }) })
      scheduleSave()
    },

    addGroup(name, parentId = null) {
      const { list, id } = groupForName(get().library.groups, name, parentId)
      if (!id) return ''
      if (list !== get().library.groups) set(state => ({ library: { ...state.library, groups: list } }))
      scheduleSave()
      return id
    },

    renameGroup(groupId, name) {
      const trimmed = name.trim().slice(0, RSS_LIMITS.groupChars)
      if (!trimmed) return
      const folded = groupKey(trimmed)
      set((state) => {
        const library: RssLibrary = {
          ...state.library,
          groups: state.library.groups.map(group => ({ ...group })),
          feeds: state.library.feeds.map(feed => ({ ...feed })),
        }
        // Renaming onto a name that already exists *in the same parent* merges the two shelves
        // rather than leaving two folders the reader has to keep straight. Under a different
        // parent the same name is deliberate, so it stays its own shelf.
        const moved = library.groups.find(group => group.id === groupId)
        const clash = library.groups.find(group => group.id !== groupId
          && (group.parentId ?? '') === (moved?.parentId ?? '')
          && groupKey(group.name) === folded)
        if (clash) {
          library.groups = library.groups.filter(group => group.id !== groupId)
          for (const feed of library.feeds) if (feed.groupId === groupId) feed.groupId = clash.id
        }
        else {
          const group = library.groups.find(item => item.id === groupId)
          if (group) group.name = trimmed
        }
        return { library }
      })
      scheduleSave()
    },

    /** Delete a folder. Its subscriptions go to the parent that was removed from, not to the
     * unfiled pile: a reader pruning one shelf should not have everything under it dumped in
     * their lap, and the note folders the reader already knows follow the same rule.
     */
    removeGroup(groupId) {
      set((state) => {
        const gone = state.library.groups.find(group => group.id === groupId)
        const upInto = gone?.parentId ?? ''
        const library: RssLibrary = {
          ...state.library,
          groups: state.library.groups
            .filter(group => group.id !== groupId)
            .map(group => (group.parentId === groupId ? { ...group, parentId: upInto || null } : group)),
          feeds: state.library.feeds.map(feed => (feed.groupId === groupId ? { ...feed, groupId: upInto } : feed)),
        }
        return { library }
      })
      scheduleSave()
    },

    toggleGroupCollapsed(groupId) {
      set(state => ({
        library: {
          ...state.library,
          groups: state.library.groups.map(group => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)),
        },
      }))
      scheduleSave()
    },

    async loadAllCached() {
      const cached = get().allCached
      if (cached) return cached
      const out: RssEntry[] = []
      for (const feedId of Object.keys(index.articles)) {
        const stored = await localDb.loadRssArticles(feedId)
        if (!stored) continue
        // The index exists to be searched, and a search reads a title and a summary. Keeping the
        // bodies would hold a hundred megabytes of HTML for a lookup that never opens one.
        for (const entry of stored.entries) out.push({ ...entry, content: '' })
      }
      out.sort((a, b) => (b.publishedTs ?? 0) - (a.publishedTs ?? 0))
      set({ allCached: out })
      return out
    },

    /** Drop every article this device holds. The library keeps the subscriptions, so the
     * next refresh rebuilds the list from the feeds themselves.
     */
    async clearCache() {
      for (const feedId of Object.keys(index.articles)) await localDb.dropRssArticles(feedId)
      index = { ...index, articles: {} }
      writeIndex()
      publishCache()
      set({ articles: {}, fetchedAt: {}, allCached: null })
    },

    /**
     * Keep the rows, drop the bodies.
     *
     * The body is the whole cost of an article cache — a title and a summary are a few dozen
     * characters each — so this is the release valve for a device that wants to stay subscribed to a
     * few hundred feeds without carrying their text. Two things have to follow or the list would lie:
     * the validators go, because a feed that answers `304` would leave the bodies empty for good, and
     * the search index goes, because it was built from bodies this device no longer has.
     */
    async clearBodies() {
      let feeds = 0
      for (const feedId of Object.keys(index.articles)) {
        const stored = await localDb.loadRssArticles(feedId)
        if (!stored || !stored.entries.some(entry => entry.content)) continue
        const entries = stored.entries.map(entry => ({ ...entry, content: '' }))
        await localDb.saveRssArticles({ feedId, fetchedAt: stored.fetchedAt, entries })
        index = { ...index, articles: { ...index.articles, [feedId]: cacheMeta(entries, stored.fetchedAt) } }
        set(state => ({ articles: { ...state.articles, [feedId]: entries } }))
        patchFeed(feedId, { etag: '', lastModified: '' })
        feeds++
      }
      if (!feeds) return 0
      writeIndex()
      publishCache()
      set({ allCached: null })
      scheduleSave()
      return feeds
    },

    async flush() {
      if (saveTimer) window.clearTimeout(saveTimer)
      saveTimer = 0
      await flushSave()
    },

    retrySave() {
      void flushSave()
    },
  }
})

/**
 * The newest answers, inside the article and character ceilings.
 *
 * A summary is a paid, streamed answer, so it is worth keeping — and not worth keeping forever. The
 * budget is spent newest-first, and one article is always kept even if it is alone over the line, so
 * a reader who asked about exactly one enormous article still finds it there.
 */
function trimResults(results: Record<string, RssAiResult>): Record<string, RssAiResult> {
  const kept: Record<string, RssAiResult> = {}
  let chars = 0
  const ordered = Object.entries(results)
    .filter(([, result]) => Number.isFinite(result.at))
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, RESULT_ARTICLES)
  for (const [id, result] of ordered) {
    const size = (result.summary?.length ?? 0) + (result.translation?.length ?? 0)
    if (chars && chars + size > RESULT_CHARS) break
    kept[id] = result
    chars += size
  }
  return kept
}

/** Device data from an earlier build: keep what parses, drop the rest rather than half-trusting it. */
function normaliseResults(value: unknown): Record<string, RssAiResult> {
  const out: Record<string, RssAiResult> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const stored = item as Partial<RssAiResult>
    if (!stored || typeof stored !== 'object' || typeof stored.at !== 'number' || !Number.isFinite(stored.at)) continue
    const result: RssAiResult = { at: Math.max(0, Math.trunc(stored.at)) }
    for (const kind of ['summary', 'translation'] as const) {
      const text = stored[kind]
      if (typeof text === 'string' && text.trim()) result[kind] = text.slice(0, 20_000)
    }
    if (result.summary || result.translation) out[key.slice(0, 80)] = result
  }
  return trimResults(out)
}

function normaliseIndex(value: unknown): CacheIndex {
  const out = emptyIndex()
  if (!value || typeof value !== 'object') return out
  const source = value as { articles?: unknown, views?: unknown }
  if (source.articles && typeof source.articles === 'object') {
    for (const [key, item] of Object.entries(source.articles as Record<string, unknown>)) {
      const meta = item as { fetchedAt?: unknown, bytes?: unknown, body?: unknown, count?: unknown }
      if (typeof meta?.fetchedAt === 'number' && typeof meta.bytes === 'number') {
        out.articles[key.slice(0, 80)] = {
          fetchedAt: meta.fetchedAt,
          bytes: Math.max(0, meta.bytes),
          // An index an older build wrote measured neither, and a guessed split is worse than none:
          // the storage panel leaves those feeds out of the body line until the feed is read again.
          body: typeof meta.body === 'number' ? Math.max(0, Math.min(meta.body, meta.bytes)) : undefined,
          count: typeof meta.count === 'number' ? Math.max(0, Math.trunc(meta.count)) : undefined,
        }
      }
    }
  }
  if (source.views && typeof source.views === 'object') {
    for (const [key, item] of Object.entries(source.views as Record<string, unknown>)) {
      const stored = item as Partial<RssChannelView>
      if (!stored || typeof stored !== 'object') continue
      out.views[key.slice(0, 120)] = {
        entryId: typeof stored.entryId === 'string' ? stored.entryId.slice(0, 80) : '',
        filter: stored.filter === 'unread' || stored.filter === 'starred' || stored.filter === 'later' ? stored.filter : 'all',
        query: typeof stored.query === 'string' ? stored.query.slice(0, 200) : '',
        sort: stored.sort === 'oldest' || stored.sort === 'source' ? stored.sort : 'newest',
        version: stored.version === 'summary' || stored.version === 'translation' ? stored.version : 'original',
        platform: stored.platform === 'youtube' || stored.platform === 'bilibili' || stored.platform === 'wechat' || stored.platform === 'web' ? stored.platform : 'all',
        listTop: Number.isFinite(stored.listTop) ? Math.max(0, Math.trunc(Number(stored.listTop))) : 0,
        readerTop: Number.isFinite(stored.readerTop) ? Math.max(0, Math.trunc(Number(stored.readerTop))) : 0,
      }
    }
  }
  return out
}

/** The library as the rest of the feature reads it: the same object, plus what this device holds. */
export function rssView(state: Pick<RssState, 'library' | 'articles'>) {
  return { library: state.library, articles: state.articles }
}
