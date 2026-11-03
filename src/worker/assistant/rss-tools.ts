/**
 * The RSS tools the assistant can call.
 *
 * The subscription library lives beside the account, but the articles do not: they are rebuilt from
 * the network and stay in the device that fetched them. A tool running in the Worker therefore reads
 * two things it does not own — the library rows, through `loadRssLibrary`, and the bounded plain-text
 * snapshot the device uploaded, through `loadRssReading`. Every write goes back through the same
 * library store the RSS routes use, so a mark made here is a mark the reader's next load will see.
 *
 * Nothing here invents an article. When the account has no snapshot, the tool says so and the reader
 * is told to open the app once; a made-up summary of an article the model never received is the
 * failure this shape exists to prevent.
 */

import { dayBounds, parseLocalTime, toLocalMinute } from '@shared/assistant-time'
import { applyLibraryPatch, type RssPatch } from '@shared/rss/patch'
import type { RssMarkKind } from '@shared/rss/marks'
import { parseRssLibrary, type RssLibrary } from '@shared/rss/model'
import { loadRssLibrary, loadRssReading, storeRssLibrary, type RssReadingEntry, type RssReadingSnapshot } from '../lib/rss-store'
import { ApiError } from '../lib/errors'
import { ToolError, type FieldSpec, type ToolContext, type ToolDefinition } from './tools'

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/
const MINUTE_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/
const MAX_LISTED_ENTRIES = 100
const DEFAULT_LISTED_ENTRIES = 30
const MAX_READ_CHARS = 8000
const MAX_SUMMARY_CHARS = 240

const dateField = (description: string): FieldSpec => ({
  type: 'string',
  description: `${description} Local to the reader: YYYY-MM-DD, or YYYY-MM-DDTHH:MM.`,
  maxLength: 32,
  optional: true,
})

async function ask<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (error instanceof ApiError) throw new ToolError(error.message)
    throw error
  }
}

function timeZoneOf(ctx: ToolContext): string {
  return ctx.settings.timezone || ctx.timezone
}

function timeRange(args: Record<string, unknown>, zone: string): { fromMs?: number; toMs?: number } {
  const fromText = typeof args.from === 'string' ? args.from.trim() : ''
  const toText = typeof args.to === 'string' ? args.to.trim() : ''
  const fromMs = fromText ? instantOf(fromText, zone, 'from') : undefined
  const toMs = toText ? instantOf(toText, zone, 'to') : undefined
  if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs) {
    throw new ToolError('"to" must be after "from".')
  }
  return { fromMs, toMs }
}

/**
 * A local day or minute as an instant. A day covers the whole day, so "today" includes an article
 * published at 23:50 without the model having to write a second boundary.
 */
function instantOf(text: string, zone: string, field: string): number {
  if (DATE_TEXT.test(text)) {
    const bounds = dayBounds(text, zone)
    if (!bounds) throw new ToolError(`"${field}" must be a real local date.`)
    return field === 'from' ? bounds.start : bounds.end
  }
  if (MINUTE_TEXT.test(text)) {
    const parsed = parseLocalTime(text.replace(' ', 'T'), zone)
    if (parsed === null) throw new ToolError(`"${field}" must be a real local time.`)
    return parsed
  }
  throw new ToolError(`"${field}" must be YYYY-MM-DD or YYYY-MM-DDTHH:MM.`)
}

function publishedOf(entry: RssReadingEntry, zone: string): string {
  return entry.publishedTs ? toLocalMinute(entry.publishedTs, zone) : ''
}

function feedTitleOf(library: RssLibrary | null, feedId: string): string {
  return library?.feeds.find((feed) => feed.id === feedId)?.title || feedId
}

function entriesOf(snapshot: RssReadingSnapshot): RssReadingEntry[] {
  return Object.values(snapshot.feeds).flatMap((feed) => feed.entries)
}

function findEntry(snapshot: RssReadingSnapshot, id: string): RssReadingEntry | null {
  for (const feed of Object.values(snapshot.feeds)) {
    const found = feed.entries.find((entry) => entry.id === id)
    if (found) return found
  }
  return null
}

function noSnapshot(): never {
  throw new ToolError('No article text is synced to this account yet. Open the RSS app on the device that holds your feeds, wait for it to load, then try again.')
}

function viewEntry(entry: RssReadingEntry, library: RssLibrary | null, snapshot: RssReadingSnapshot, marks: { read: Set<string>; starred: Set<string>; later: Set<string> }, zone: string): Record<string, unknown> {
  return {
    id: entry.id,
    feed_id: entry.feedId,
    feed: feedTitleOf(library, entry.feedId),
    title: entry.title,
    author: entry.author,
    published: publishedOf(entry, zone),
    published_ms: entry.publishedTs,
    link: entry.link,
    unread: !marks.read.has(entry.id),
    starred: marks.starred.has(entry.id),
    later: marks.later.has(entry.id),
    has_text: entry.content.length > 0,
    summary: entry.summary.slice(0, MAX_SUMMARY_CHARS),
    synced_at: snapshot.capturedAt ? toLocalMinute(snapshot.capturedAt, zone) : '',
  }
}

function marksOf(library: RssLibrary | null): { read: Set<string>; starred: Set<string>; later: Set<string>; hidden: Set<string> } {
  return {
    read: new Set(library?.readIds ?? []),
    starred: new Set(library?.favorites ?? []),
    later: new Set(library?.readLater ?? []),
    hidden: new Set(library?.hiddenIds ?? []),
  }
}

function matchFeed(library: RssLibrary | null, args: Record<string, unknown>): string | null {
  const id = typeof args.feedId === 'string' ? args.feedId.trim() : ''
  if (id) {
    if (library && !library.feeds.some((feed) => feed.id === id)) {
      throw new ToolError('No subscription has that id. Call rss_list_feeds for the ids.')
    }
    return id
  }
  const words = typeof args.feed === 'string' ? args.feed.trim().toLowerCase() : ''
  if (!words) return null
  const matches = (library?.feeds ?? []).filter((feed) => feed.title.toLowerCase().includes(words))
  if (matches.length === 0) throw new ToolError(`No subscription matches "${words.slice(0, 60)}". Call rss_list_feeds to see them.`)
  if (matches.length > 1) {
    throw new ToolError(`More than one subscription matches "${words.slice(0, 60)}": ${matches.slice(0, 5).map((feed) => `${feed.title} id=${feed.id}`).join('; ')}`)
  }
  return matches[0]!.id
}

async function saveLibrary(ctx: ToolContext, library: RssLibrary, patch: RssPatch): Promise<void> {
  const merged = applyLibraryPatch(library, patch)
  const { data } = parseRssLibrary(merged)
  if (!data) throw new ToolError('The reading library could not be updated.')
  await ask(() => storeRssLibrary(ctx.env.DB, ctx.store.userId, data, Date.now()))
}

const MARK_STATES = ['read', 'unread', 'star', 'unstar', 'later', 'unlater'] as const
type MarkState = (typeof MARK_STATES)[number]

function markPatch(state: MarkState, entryId: string): RssPatch {
  const kind: RssMarkKind = state === 'read' || state === 'unread' ? 'read' : state === 'star' || state === 'unstar' ? 'star' : 'later'
  const add = state === 'read' || state === 'star' || state === 'later'
  return {
    feeds: { upsert: [], remove: [] },
    groups: { upsert: [], remove: [] },
    tags: { upsert: [], remove: [] },
    marks: add
      ? { upsert: [{ kind, entryId, value: '', at: 0 }], remove: [] }
      : { upsert: [], remove: [{ kind, entryId }] },
    state: null,
  }
}

export const RSS_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'rss_list_feeds',
    description: 'List the RSS subscriptions this account follows, with ids, folder, tags and how many of the synced articles are unread. Call this before filtering by feed, because the feed id is what the other RSS tools take.',
    permission: 'read',
    fields: {},
    async run(_args, ctx) {
      const library = (await ask(() => loadRssLibrary(ctx.env.DB, ctx.store.userId))).library
      const snapshot = await ask(() => loadRssReading(ctx.env.DB, ctx.store.userId))
      const marks = marksOf(library)
      const unread = new Map<string, number>()
      for (const entry of snapshot ? entriesOf(snapshot) : []) {
        if (marks.hidden.has(entry.id) || marks.read.has(entry.id)) continue
        unread.set(entry.feedId, (unread.get(entry.feedId) ?? 0) + 1)
      }
      return {
        feeds: (library?.feeds ?? []).map((feed) => ({
          id: feed.id,
          title: feed.title,
          url: feed.url,
          group: library?.groups.find((group) => group.id === feed.groupId)?.name ?? '',
          tags: [...feed.tags],
          unread: unread.get(feed.id) ?? 0,
          paused: feed.paused,
          ...(feed.error ? { error: feed.error } : {}),
        })),
        total: library?.feeds.length ?? 0,
        synced: Boolean(snapshot),
        ...(snapshot ? { synced_articles: entriesOf(snapshot).length, synced_at: toLocalMinute(snapshot.capturedAt, timeZoneOf(ctx)) } : {}),
      }
    },
  },
  {
    name: 'rss_list_entries',
    description: 'List articles from the reading snapshot this device synced, filtered by unread, starred, saved-for-later, one feed, a local date range, or words in the title and text. Use it whenever the reader asks what came in today, what is unread, or which articles are about a subject.',
    permission: 'read',
    fields: {
      filter: { type: 'string', enum: ['all', 'unread', 'starred', 'later'], description: 'Which articles to include. Default all.', optional: true },
      feedId: { type: 'string', description: 'Only this subscription, from rss_list_feeds.', maxLength: 80, optional: true },
      feed: { type: 'string', description: 'Subscription title words, when the id is unknown. Must match one feed.', maxLength: 120, optional: true },
      from: dateField('Keep articles published on or after this local day.'),
      to: dateField('Keep articles published on or before this local day.'),
      query: { type: 'string', description: 'Words that must appear in the title, summary, text or author.', maxLength: 120, optional: true },
      limit: { type: 'integer', description: 'Maximum articles to return, 1–100. Default 30.', minimum: 1, maximum: MAX_LISTED_ENTRIES, optional: true },
      withText: { type: 'boolean', description: 'Also return each article text, so a summary across a few articles needs one call instead of a read per article. Ten articles at most in this mode.', optional: true },
    },
    async run(args, ctx) {
      const zone = timeZoneOf(ctx)
      const snapshot = await ask(() => loadRssReading(ctx.env.DB, ctx.store.userId))
      if (!snapshot) noSnapshot()
      const library = (await ask(() => loadRssLibrary(ctx.env.DB, ctx.store.userId))).library
      const marks = marksOf(library)
      const filter = typeof args.filter === 'string' ? args.filter : 'all'
      const feedId = matchFeed(library, args)
      const { fromMs, toMs } = timeRange(args, zone)
      const terms = typeof args.query === 'string' && args.query.trim() ? args.query.trim().toLowerCase().split(/\s+/).slice(0, 6) : []
      const withText = args.withText === true
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED_ENTRIES, Math.max(1, args.limit)) : DEFAULT_LISTED_ENTRIES
      // A list carrying text is no longer a list: ten full articles is already a substantial prompt,
      // and a hundred would spend the turn's context on the one question nobody asked.
      const shown = withText ? Math.min(limit, 10) : limit
      // A snapshot outlives a subscription: the reader may have unsubscribed since the device
      // uploaded it, and an article from a feed this account no longer follows is not "unread".
      const followed = library ? new Set(library.feeds.map((feed) => feed.id)) : null
      const matched = entriesOf(snapshot)
        .filter((entry) => !followed || followed.has(entry.feedId))
        .filter((entry) => !marks.hidden.has(entry.id))
        .filter((entry) => (feedId ? entry.feedId === feedId : true))
        .filter((entry) => {
          if (filter === 'unread') return !marks.read.has(entry.id)
          if (filter === 'starred') return marks.starred.has(entry.id)
          if (filter === 'later') return marks.later.has(entry.id)
          return true
        })
        .filter((entry) => {
          if (fromMs === undefined && toMs === undefined) return true
          if (entry.publishedTs === null) return false
          if (fromMs !== undefined && entry.publishedTs < fromMs) return false
          if (toMs !== undefined && entry.publishedTs > toMs) return false
          return true
        })
        .filter((entry) => {
          if (!terms.length) return true
          const haystack = `${entry.title} ${entry.summary} ${entry.content} ${entry.author}`.toLowerCase()
          return terms.every((term) => haystack.includes(term))
        })
        .sort((left, right) => (right.publishedTs ?? 0) - (left.publishedTs ?? 0))
      return {
        entries: matched.slice(0, shown).map((entry) => ({
          ...viewEntry(entry, library, snapshot, marks, zone),
          ...(withText ? { content: (entry.content || entry.summary).slice(0, MAX_READ_CHARS) } : {}),
        })),
        total: matched.length,
        ...(matched.length > shown ? { truncated: true, note: `Only ${shown} of ${matched.length} articles are shown; narrow the range or raise the limit.` } : {}),
        filter,
        time_zone: zone,
      }
    },
  },
  {
    name: 'rss_read_entry',
    description: 'Read one synced article in full: its text, summary, author, feed and link. Call it before summarising or translating an article, and after rss_list_entries when the id is known. A feed that publishes only headlines leaves the text empty; the answer then says so and points at fetch_url, which is the way to read the page itself.',
    permission: 'read',
    fields: {
      id: { type: 'string', description: 'Article id from rss_list_entries.', minLength: 1, maxLength: 80 },
    },
    async run(args, ctx) {
      const zone = timeZoneOf(ctx)
      const id = String(args.id)
      const snapshot = await ask(() => loadRssReading(ctx.env.DB, ctx.store.userId))
      if (!snapshot) noSnapshot()
      const library = (await ask(() => loadRssLibrary(ctx.env.DB, ctx.store.userId))).library
      const entry = findEntry(snapshot, id)
      if (!entry) throw new ToolError('No synced article has that id. Call rss_list_entries for the ids this account holds.')
      const marks = marksOf(library)
      const text = entry.content || entry.summary
      return {
        ...viewEntry(entry, library, snapshot, marks, zone),
        content: text.slice(0, MAX_READ_CHARS),
        ...(text.length > MAX_READ_CHARS ? { truncated: true, note: `The article text is ${text.length} characters; the first ${MAX_READ_CHARS} are shown.` } : {}),
        ...(entry.content.length === 0
          ? { note: 'This feed synced only the title and summary, not the article body. Call fetch_url with this link to read the page itself before summarising or translating it.' }
          : {}),
      }
    },
  },
  {
    name: 'rss_mark',
    description: 'Change one article state: read or unread, starred or unstarred, saved for later or not. It writes the account row the reader’s own reader syncs, so the unread badge moves. The article id must come from rss_list_entries.',
    permission: 'write',
    fields: {
      id: { type: 'string', description: 'Article id from rss_list_entries.', minLength: 1, maxLength: 80 },
      state: { type: 'string', enum: [...MARK_STATES], description: 'The state to set: read, unread, star, unstar, later, unlater.' },
    },
    async run(args, ctx) {
      const id = String(args.id)
      const state = args.state as MarkState
      if (!MARK_STATES.includes(state)) throw new ToolError('"state" must be read, unread, star, unstar, later or unlater.')
      const snapshot = await ask(() => loadRssReading(ctx.env.DB, ctx.store.userId))
      if (!snapshot) noSnapshot()
      const entry = findEntry(snapshot, id)
      if (!entry) throw new ToolError('No synced article has that id. Call rss_list_entries for the ids this account holds.')
      const stored = await ask(() => loadRssLibrary(ctx.env.DB, ctx.store.userId))
      const library = stored.library
      if (!library) throw new ToolError('This account has no reading library yet. Open the RSS app once, then try again.')
      await saveLibrary(ctx, library, markPatch(state, id))
      const updated = await ask(() => loadRssLibrary(ctx.env.DB, ctx.store.userId))
      const marks = marksOf(updated.library)
      return {
        marked: true,
        id,
        state,
        unread: !marks.read.has(id),
        starred: marks.starred.has(id),
        later: marks.later.has(id),
      }
    },
  },
]
