/**
 * The store's own rules, tested without a browser.
 *
 * What is asserted here is the *decision*, not the copy: whether a device that holds no articles
 * asks for them, whether a device that does sends its validator, whether a refused save stays
 * pending. Each of those had a real failure behind it during the port, and a component test would
 * have watched the same symptom from too far away to name the cause.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelEntries } from '@shared/rss/reading'
import { RSS_LIMITS } from '@shared/rss/model'

const feed = {
  id: 'f1',
  url: 'https://example.com/feed.xml',
  title: 'Example',
  siteUrl: 'https://example.com/',
  imageUrl: '',
  groupId: '',
  order: 0,
  updatedAt: 1,
  lastAttemptAt: 1,
  error: '',
  errorCount: 0,
  lastErrorAt: 0,
  etag: '"v1"',
  lastModified: 'Tue, 02 Sep 2025 08:30:00 GMT',
  paused: false,
}

const saved = { version: 1, feeds: [feed], groups: [], readIds: [], favorites: [], readLater: [], opened: {}, savedNotes: {}, lastChannel: 'feed:f1' }

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title>
  <link href="https://example.com/"/><entry><title>First</title><link href="https://example.com/1"/>
  <id>urn:1</id><updated>2025-09-02T10:00:00Z</updated><content type="html">&lt;p&gt;Body one&lt;/p&gt;</content></entry>
  <entry><title>Second</title><link href="https://example.com/2"/><id>urn:2</id>
  <updated>2025-09-01T10:00:00Z</updated><content type="html">&lt;p&gt;Body two&lt;/p&gt;</content></entry></feed>`

const cache = new Map<string, unknown>()
const calls: Array<{ path: string, body?: unknown }> = []
let fetchResults: Array<{ url: string, status: number, ok: boolean, xml?: string, etag?: string, reason?: string }> = []
let saveFails = false

vi.mock('../../lib/db', () => ({
  localDb: {
    loadRssCacheIndex: () => Promise.resolve(cache.get('index') ?? null),
    saveRssCacheIndex: (value: unknown) => { cache.set('index', value); return Promise.resolve() },
    loadRssArticles: (id: string) => Promise.resolve(cache.get(`articles:${id}`) ?? null),
    saveRssArticles: (value: { feedId: string }) => { cache.set(`articles:${value.feedId}`, value); return Promise.resolve() },
    dropRssArticles: (id: string) => { cache.delete(`articles:${id}`); return Promise.resolve() },
    loadRssAi: () => Promise.resolve(null),
    saveRssAi: () => Promise.resolve(),
  },
}))

vi.mock('../../lib/api', () => ({
  api: {
    rss: {
      load: () => { calls.push({ path: 'load' }); return Promise.resolve({ savedAt: 1, library: cache.get('library') ?? null }) },
      save: (library: string) => {
        calls.push({ path: 'save', body: JSON.parse(library) })
        if (saveFails) return Promise.reject(new Error('The RSS library holds entries that cannot be stored'))
        cache.set('library', JSON.parse(library))
        return Promise.resolve({ savedAt: Date.now() })
      },
      fetch: (requests: Array<{ url: string, etag?: string, lastModified?: string }>) => {
        calls.push({ path: 'fetch', body: requests })
        return Promise.resolve({ results: fetchResults })
      },
      relayUrl: (url: string) => `/api/rss/relay?url=${encodeURIComponent(url)}`,
    },
  },
}))

vi.mock('../../store/session', () => ({
  useSession: Object.assign(() => ({ settings: { rss: RSS_SETTINGS } }), {
    getState: () => ({ settings: { rss: RSS_SETTINGS } }),
  }),
}))

const RSS_SETTINGS = {
  refreshIntervalMinutes: 0,
  defaultFilter: 'all',
  markReadOnOpen: true,
  images: 'relay',
  showThumbnails: true,
  readingFont: 'serif',
  fontSize: 17,
  lineHeight: 1.8,
  columnWidth: 36,
  sortOrder: 'newest',
  articleFolder: 'RSS',
  dailyNoteTitle: 'YYYY-MM-DD',
  aiEnabled: false,
  aiLanguage: 'interface',
}

const { useRss } = await import('./store')

function reset(): void {
  cache.clear()
  calls.length = 0
  saveFails = false
  fetchResults = []
  cache.set('library', JSON.parse(JSON.stringify(saved)))
  useRss.getState().reset()
}

beforeEach(reset)

/** Load, then wait for the refresh it starts so the assertions below are not racing it. */
async function boot(): Promise<void> {
  await useRss.getState().load()
  await vi.waitFor(() => expect(useRss.getState().refreshing).toHaveLength(0))
}

/** A device that has read this feed before: the blob and the index entry that vouches for it. */
function seedCachedArticles(): void {
  const entries = [{ id: 'kept', feedId: 'f1', title: 'Cached', link: 'https://example.com/kept', author: '', publishedTs: 1, summary: '', content: '', imageUrl: '', audioUrl: '' }]
  cache.set('articles:f1', { feedId: 'f1', fetchedAt: Date.now(), entries })
  cache.set('index', { articles: { f1: { fetchedAt: Date.now(), bytes: 100 } }, views: {} })
}

function fetchCalls(): Array<{ path: string, body?: unknown }> {
  return calls.filter(call => call.path === 'fetch')
}

describe('loading on a device', () => {
  it('asks a feed for its articles when this device holds none', async () => {
    fetchResults = [{ url: feed.url, status: 200, ok: true, xml: atom }]
    await boot()
    await vi.waitFor(() => expect(useRss.getState().articles.f1).toHaveLength(2))
    const sent = fetchCalls().at(-1)?.body as Array<{ url: string, etag?: string, lastModified?: string }>
    expect(sent[0].url).toBe(feed.url)
    // The stored etag belongs to the account, not to this browser: sending it here is what made a
    // second device settle for `304` and an empty list forever.
    expect(sent[0].etag).toBeUndefined()
    expect(sent[0].lastModified).toBeUndefined()
  })

  it('sends the validator once the device does hold a copy', async () => {
    seedCachedArticles()
    fetchResults = [{ url: feed.url, status: 304, ok: true, etag: '"v1"' }]
    await boot()
    await useRss.getState().refresh(['f1'])
    const sent = fetchCalls().at(-1)?.body as Array<{ url: string, etag?: string, lastModified?: string }>
    expect(sent[0].etag).toBe('"v1"')
    expect(useRss.getState().articles.f1.map(entry => entry.id)).toEqual(['kept'])
  })

  it('restores the channel the reader left, and remembers the one they move to', async () => {
    fetchResults = [{ url: feed.url, status: 304, ok: true }]
    await boot()
    expect(useRss.getState().channel).toEqual({ kind: 'feed', feedId: 'f1' })
    await useRss.getState().open({ kind: 'starred' })
    expect(useRss.getState().library.lastChannel).toBe('starred')
    await useRss.getState().flush()
    expect((calls.filter(call => call.path === 'save').at(-1)?.body as { lastChannel: string }).lastChannel).toBe('starred')
  })
})

describe('refreshing', () => {
  it('keeps the old articles and names the failure when a feed does not answer', async () => {
    seedCachedArticles()
    fetchResults = [{ url: feed.url, status: 0, ok: false, reason: 'timeout' }]
    await boot()
    await useRss.getState().refresh(['f1'], { force: true })
    const after = useRss.getState().library.feeds[0]
    expect(after.error).toMatch(/超时|timeout/i)
    expect(after.errorCount).toBeGreaterThanOrEqual(1)
    expect(useRss.getState().articles.f1.map(entry => entry.id)).toEqual(['kept'])
  })

  it('waits out the backoff a failed refresh installed', async () => {
    fetchResults = [{ url: feed.url, status: 0, ok: false, reason: 'unreachable' }]
    await boot()
    await useRss.getState().refresh(['f1'], { force: true })
    const before = fetchCalls().length
    await useRss.getState().refresh(['f1'])
    expect(fetchCalls().length).toBe(before)
  })

  it('writes the parsed articles to the device cache', async () => {
    fetchResults = [{ url: feed.url, status: 200, ok: true, xml: atom, etag: '"v2"' }]
    await boot()
    await useRss.getState().refresh(['f1'], { force: true })
    const stored = cache.get('articles:f1') as { entries: Array<{ title: string, content: string }> }
    expect(stored.entries.map(entry => entry.title)).toEqual(['First', 'Second'])
    expect(stored.entries[0].content).toContain('<p>Body one</p>')
    expect(useRss.getState().library.feeds[0].etag).toBe('"v2"')
  })
})

describe('the library a reader edits', () => {
  it('refuses an address it already carries, comparing the folded form', async () => {
    await boot()
    const result = await useRss.getState().addFeed('https://EXAMPLE.com/feed.xml')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already_subscribed|already subscribed|已经订阅/)
  })

  it('stores the address as written, not as folded', async () => {
    await boot()
    fetchResults = [{ url: 'https://www.example.com/blog/feed/', status: 200, ok: true, xml: atom }]
    const result = await useRss.getState().addFeed('https://www.example.com/blog/feed/')
    expect(result.ok).toBe(true)
    expect(result.feed?.url).toBe('https://www.example.com/blog/feed/')
  })

  it('rejects something that is not a feed without touching the library', async () => {
    await boot()
    fetchResults = [{ url: 'https://nope.example/', status: 200, ok: false, reason: 'not-a-feed' }]
    const result = await useRss.getState().addFeed('https://nope.example/')
    expect(result.ok).toBe(false)
    expect(useRss.getState().library.feeds).toHaveLength(1)
  })

  it('imports OPML without duplicating and files by folded group name', async () => {
    await boot()
    const added = await useRss.getState().importFeeds([
      { url: 'https://a.example/feed', title: 'A', group: 'Podcasts' },
      { url: 'https://b.example/feed', title: 'B', group: 'podcast' },
      { url: feed.url, title: 'dupe', group: '' },
    ])
    expect(added).toBe(2)
    const groups = useRss.getState().library.groups
    expect(groups).toHaveLength(1)
    expect(useRss.getState().library.feeds.filter(item => item.groupId === groups[0].id)).toHaveLength(2)
  })

  it('merges a rename onto a group that already answers to that name', async () => {
    await boot()
    const id = useRss.getState().addGroup('Tech')
    const other = useRss.getState().addGroup('Reading')
    useRss.getState().moveFeed('f1', other)
    useRss.getState().renameGroup(other, 'tech')
    const library = useRss.getState().library
    expect(library.groups.filter(group => group.id === id || group.id === other)).toHaveLength(1)
    expect(library.feeds[0].groupId).toBe(id)
  })

  it('drops the device cache with the subscription', async () => {
    cache.set('articles:f1', { feedId: 'f1', fetchedAt: 1, entries: [] })
    await boot()
    useRss.getState().removeFeed('f1')
    expect(useRss.getState().library.feeds).toHaveLength(0)
    expect(cache.get('articles:f1')).toBeUndefined()
    expect(useRss.getState().articles.f1).toBeUndefined()
  })
})

describe('marks', () => {
  it('keeps the newest read marks when the ceiling cuts', async () => {
    await boot()
    const library = useRss.getState().library
    library.readIds = Array.from({ length: 5000 }, (_, index) => `old${index}`)
    useRss.getState().markRead(['new1', 'new2'], true)
    const readIds = useRss.getState().library.readIds
    expect(readIds).toHaveLength(5000)
    expect(readIds.slice(0, 2)).toEqual(['new1', 'new2'])
    expect(readIds).not.toContain('old4999')
  })

  it('un-reading removes the mark rather than adding a second one', async () => {
    await boot()
    useRss.getState().markRead(['a', 'b'], true)
    useRss.getState().markRead(['a'], false)
    expect(useRss.getState().library.readIds).toEqual(['b'])
  })

  it('opening an article marks it read when the setting says so', async () => {
    fetchResults = [{ url: feed.url, status: 200, ok: true, xml: atom }]
    await boot()
    await vi.waitFor(() => expect(useRss.getState().articles.f1).toHaveLength(2))
    const entry = useRss.getState().articles.f1[0]
    useRss.getState().openEntry(entry.id)
    expect(useRss.getState().library.readIds).toContain(entry.id)
    expect(useRss.getState().view().entryId).toBe(entry.id)
    expect(useRss.getState().library.opened[entry.id]).toBeTypeOf('number')
  })
})

describe('saving', () => {
  it('keeps a refused library pending and retries it with the next change', async () => {
    fetchResults = [{ url: feed.url, status: 304, ok: true }]
    await boot()
    saveFails = true
    useRss.getState().toggleFavorite('e1')
    await useRss.getState().flush()
    expect(String(useRss.getState().saveError)).toMatch(/cannot be stored/)
    saveFails = false
    useRss.getState().toggleLater('e2')
    await useRss.getState().flush()
    expect(useRss.getState().saveError).toBeNull()
    const library = (calls.filter(call => call.path === 'save').at(-1)?.body) as { favorites: string[], readLater: string[] }
    expect(library.favorites).toEqual(['e1'])
    expect(library.readLater).toEqual(['e2'])
  })

  it('batches several quick changes into one write', async () => {
    await boot()
    useRss.getState().toggleFavorite('a')
    useRss.getState().toggleFavorite('b')
    useRss.getState().toggleFavorite('c')
    await new Promise(resolve => window.setTimeout(resolve, 1200))
    await useRss.getState().flush()
    const writes = calls.filter(call => call.path === 'save')
    expect(writes.length).toBeLessThanOrEqual(2)
    expect((writes.at(-1)?.body as { favorites: string[] }).favorites).toEqual(['c', 'b', 'a'])
  })
})


describe('folders, tags and dismissals', () => {
  /** Read through this: an action's own `library` is the value the store held when it was taken. */
  const s = () => useRss.getState()

  it('hides an article and brings it back', async () => {
    await boot()
    s().hideEntries(['e1'], true)
    expect(s().library.hiddenIds).toEqual(['e1'])
    s().hideEntries(['e1'], false)
    expect(s().library.hiddenIds).toEqual([])
  })

  it('refuses to put a folder inside one of its own children', async () => {
    await boot()
    const parent = s().addGroup('Parent')
    const child = s().addGroup('Child', parent)
    expect(s().library.groups.find(group => group.id === child)?.parentId).toBe(parent)
    const before = JSON.stringify(s().library.groups)
    s().moveGroupTo(parent, child)
    expect(JSON.stringify(s().library.groups)).toBe(before)
    s().moveGroupTo(child, parent)
    expect(s().library.groups.find(group => group.id === child)?.parentId).toBe(parent)
  })

  it('gives a nested folder its own id when the name is already taken at the top', async () => {
    await boot()
    const top = s().addGroup('Articles')
    const nested = s().addGroup('Articles', top)
    expect(nested).not.toBe(top)
    expect(s().library.groups).toHaveLength(2)
    s().moveFeedTo(feed.id, nested)
    expect(s().library.feeds[0].groupId).toBe(nested)
  })

  it('moves a deleted folder contents up one level, not out to the unfiled pile', async () => {
    await boot()
    const outer = s().addGroup('Outer')
    const inner = s().addGroup('Inner', outer)
    s().moveFeedTo(feed.id, inner)
    s().removeGroup(inner)
    expect(s().library.feeds[0].groupId).toBe(outer)
    expect(s().library.groups.find(group => group.id === outer)?.parentId).toBeNull()
  })

  it('reorders the shelf a feed was dropped into', async () => {
    await boot()
    fetchResults = [{ url: 'https://b.example.com/feed', status: 200, ok: true, xml: atom }]
    const added = await s().addFeed('https://b.example.com/feed', '')
    expect(added.ok).toBe(true)
    const second = added.feed!
    s().moveFeedTo(second.id, '', 0)
    const shelf = s().library.feeds.map(item => item.id)
    expect(shelf).toEqual([second.id, feed.id])
    expect(s().library.feeds.map(item => item.order)).toEqual([0, 1])
    s().moveFeedTo(second.id, '', 1)
    expect(s().library.feeds.map(item => item.id)).toEqual([feed.id, second.id])
    expect(s().library.feeds.map(item => item.order)).toEqual([0, 1])
  })

  it('truncates the tags a feed may carry', async () => {
    await boot()
    s().setFeedTags(feed.id, Array.from({ length: 40 }, (_, index) => `tag${index}`))
    expect(s().library.feeds[0].tags).toHaveLength(RSS_LIMITS.tagsPerFeed)
  })

  it('remembers a sort order per channel and falls back to the setting', async () => {
    await boot()
    expect(s().view().sort).toBe('newest')
    s().setSort('source')
    expect(s().view().sort).toBe('source')
    await s().open({ kind: 'starred' })
    expect(s().view().sort).toBe('newest')
  })

  it('keeps a dismissed article out of the channel it was hidden from', async () => {
    fetchResults = [{ url: feed.url, status: 200, ok: true, xml: atom }]
    await boot()
    await s().open({ kind: 'feed', feedId: feed.id })
    const shown = channelEntries({ library: s().library, articles: s().articles }, s().channel)
    expect(shown.length).toBeGreaterThan(0)
    s().hideEntries([shown[0].id], true)
    const after = channelEntries({ library: s().library, articles: s().articles }, s().channel)
    expect(after.map(entry => entry.id)).not.toContain(shown[0].id)
  })
})

describe('importing a library', () => {
  it('rebuilds an OPML outline chain as nested folders', async () => {
    await boot()
    const added = await useRss.getState().importFeeds([
      { url: 'https://one.example.com/feed', title: 'One', group: 'Front end / Reading', groupPath: ['Front end', 'Reading'] },
      { url: 'https://two.example.com/feed', title: 'Two', group: 'Front end', groupPath: ['Front end'] },
      { url: 'https://three.example.com/feed', title: 'Three', group: '', groupPath: [] },
    ])
    expect(added).toBe(3)
    const library = useRss.getState().library
    const outer = library.groups.find(group => group.name === 'Front end')
    const inner = library.groups.find(group => group.name === 'Reading')
    expect(outer?.parentId).toBeNull()
    expect(inner?.parentId).toBe(outer?.id)
    const byUrl = new Map(library.feeds.map(feed => [feed.url, feed]))
    expect(byUrl.get('https://one.example.com/feed')?.groupId).toBe(inner?.id)
    expect(byUrl.get('https://two.example.com/feed')?.groupId).toBe(outer?.id)
    expect(byUrl.get('https://three.example.com/feed')?.groupId).toBe('')
  })

  it('reuses one folder when two outlines share a level', async () => {
    await boot()
    await useRss.getState().importFeeds([
      { url: 'https://a.example.com/feed', title: 'A', group: 'Tech', groupPath: ['Tech'] },
      { url: 'https://b.example.com/feed', title: 'B', group: 'tech ', groupPath: ['tech '] },
    ])
    expect(useRss.getState().library.groups).toHaveLength(1)
    const shelf = useRss.getState().library.groups[0].id
    const wanted = new Set(['https://a.example.com/feed', 'https://b.example.com/feed'])
    const imported = useRss.getState().library.feeds.filter(feed => wanted.has(feed.url))
    expect(imported).toHaveLength(2)
    expect(imported.every(feed => feed.groupId === shelf)).toBe(true)
  })
})
