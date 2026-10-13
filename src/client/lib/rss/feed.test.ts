import { describe, expect, it } from 'vitest'
import { groupKey } from '@shared/rss/reading'
import {
  exportOpml,
  FeedParseError,
  parseFeed,
  parseFeedDate,
  parseOpml,
  plainText,
} from './feed'
import { canonicalFeedUrl, entryIdFor, feedIdFor, newFeed, parseFeedCache, parseRssLibrary, RSS_LIMITS, trimLibrary } from '@shared/rss/model'

const parser = new DOMParser()

function rss(body: string, channel = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${channel}${body}</channel></rss>`
}

describe('parseFeed', () => {
  it('reads an RSS 2.0 channel and its items', () => {
    const feed = parseFeed(rss(`
      <title>Notes from a small machine</title>
      <link>https://example.com/</link>
      <item>
        <title>First post</title>
        <link>https://example.com/first</link>
        <guid>first</guid>
        <pubDate>Tue, 02 Sep 2025 08:30:00 GMT</pubDate>
        <description>&lt;p&gt;Hello &lt;em&gt;world&lt;/em&gt;&lt;/p&gt;</description>
      </item>
    `, `<image><url>https://example.com/logo.png</url></image>`), 'https://example.com/feed.xml')
    expect(feed.title).toBe('Notes from a small machine')
    expect(feed.siteUrl).toBe('https://example.com/')
    expect(feed.imageUrl).toBe('https://example.com/logo.png')
    expect(feed.entries).toHaveLength(1)
    const entry = feed.entries[0]
    expect(entry.title).toBe('First post')
    expect(entry.link).toBe('https://example.com/first')
    expect(entry.summary).toBe('Hello world')
    expect(entry.content).toContain('<em>world</em>')
    expect(entry.publishedTs).toBe(Date.UTC(2025, 8, 2, 8, 30))
  })

  it('prefers content:encoded over description and takes the author from dc:creator', () => {
    const feed = parseFeed(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>Names</title><link>https://example.com/</link><item>
      <title>Long</title>
      <link>https://example.com/long</link>
      <dc:creator>Ada</dc:creator>
      <description>teaser</description>
      <content:encoded>&lt;p&gt;the whole article&lt;/p&gt;</content:encoded>
    </item></channel></rss>`, 'https://example.com/feed.xml')
    expect(feed.entries[0].content).toContain('the whole article')
    expect(feed.entries[0].author).toBe('Ada')
  })

  it('reads a feed that uses a prefix it never declared', () => {
    const feed = parseFeed(rss(`<item><title>Long</title><link>https://example.com/long</link>
      <content:encoded>&lt;p&gt;unbound namespace&lt;/p&gt;</content:encoded></item>`), 'https://example.com/feed.xml')
    expect(feed.entries[0].content).toContain('unbound namespace')
  })

  it('reads an Atom feed with xhtml content and a relative link', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atomly</title>
      <link href="https://example.com/blog/"/>
      <entry><title type="html">A &amp; B</title>
        <link rel="alternate" href="/posts/a-b"/>
        <id>tag:example.com,2025:a-b</id>
        <updated>2025-09-02T10:00:00Z</updated>
        <author><name>Ada</name></author>
        <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Body</p></div></content>
      </entry></feed>`
    const feed = parseFeed(xml, 'https://example.com/atom.xml')
    expect(feed.title).toBe('Atomly')
    expect(feed.siteUrl).toBe('https://example.com/blog/')
    expect(feed.entries[0].title).toBe('A & B')
    expect(feed.entries[0].link).toBe('https://example.com/posts/a-b')
    expect(feed.entries[0].content).toContain('<p>Body</p>')
    expect(feed.entries[0].author).toBe('Ada')
  })

  it('reads items that sit directly under an RDF root', () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
      <channel rdf:about="https://example.com/"><title>RDF</title><link>https://example.com/</link></channel>
      <item rdf:about="https://example.com/one"><title>One</title><link>https://example.com/one</link></item>
    </rdf:RDF>`
    const feed = parseFeed(xml, 'https://example.com/rdf.xml')
    expect(feed.entries.map(entry => entry.title)).toEqual(['One'])
  })

  it('keeps one entry per identity when a guid repeats', () => {
    const feed = parseFeed(rss(`
      <item><title>A</title><link>https://example.com/a</link><guid>same</guid></item>
      <item><title>A again</title><link>https://example.com/a2</link><guid>same</guid></item>
    `), 'https://example.com/feed.xml')
    expect(feed.entries).toHaveLength(1)
    expect(feed.skipped).toBe(1)
  })

  it('orders by date and drops what the byte ceiling cannot hold', () => {
    const items = Array.from({ length: 90 }, (_, index) => `<item>
      <title>Post ${index}</title>
      <link>https://example.com/${index}</link>
      <guid>${index}</guid>
      <pubDate>Tue, 0${(index % 8) + 1} Sep 2025 08:00:0${index % 9} GMT</pubDate>
      <description>${'x'.repeat(6000)}</description>
    </item>`).join('')
    const feed = parseFeed(rss(items), 'https://example.com/feed.xml')
    expect(feed.entries.length).toBeLessThanOrEqual(RSS_LIMITS.entriesPerFeed)
    expect(feed.entries.length).toBeGreaterThan(1)
    expect(feed.entries[0].publishedTs!).toBeGreaterThanOrEqual(feed.entries[1].publishedTs!)
  })

  it('resolves images and audio against the item, not the page', () => {
    const feed = parseFeed(rss(`<item xml:base="https://blog.example.org/posts/">
      <title>Media</title>
      <link>https://blog.example.org/posts/media</link>
      <enclosure url="https://cdn.example.org/e.mp3" length="1" type="audio/mpeg"/>
      <media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="cover.png"/>
    </item>`), 'https://blog.example.org/feed.xml')
    expect(feed.entries[0].audioUrl).toBe('https://cdn.example.org/e.mp3')
    expect(feed.entries[0].imageUrl).toBe('https://blog.example.org/posts/cover.png')
  })

  it('drops a plain-HTTP enclosure a mixed-content page could not play', () => {
    const feed = parseFeed(rss(`<item><title>Insecure</title><link>https://example.com/i</link>
      <enclosure url="http://cdn.example.com/e.mp3" type="audio/mpeg"/></item>`), 'https://example.com/feed.xml')
    expect(feed.entries[0].audioUrl).toBe('')
  })

  it('unwraps a body that was escaped twice, and leaves a body about escaping alone', () => {
    const twice = parseFeed(rss(`<item><title>T</title><link>https://example.com/t</link>
      <description>&amp;lt;p&amp;gt;Real&amp;lt;/p&amp;gt;</description></item>`), 'https://example.com/f')
    expect(twice.entries[0].content).toContain('<p>Real</p>')
    const aboutEscaping = parseFeed(rss(`<item><title>T</title><link>https://example.com/e</link>
      <description>Write &amp;lt;br&amp;gt; for a line break</description></item>`), 'https://example.com/f')
    expect(aboutEscaping.entries[0].content).toContain('&lt;br&gt;')
  })

  it('accepts a feed that writes HTML entities XML does not know', () => {
    const feed = parseFeed(rss(`<item><title>Café</title><link>https://example.com/c</link>
      <description>One&nbsp;two &mdash; three</description></item>`), 'https://example.com/feed.xml')
    expect(feed.entries[0].summary).toBe('One two — three')
  })

  it('refuses a document that is not a feed, and one that declares a DTD', () => {
    expect(() => parseFeed('<html><body>hello</body></html>', 'https://example.com/', parser))
      .toThrow(FeedParseError)
    expect(() => parseFeed('<!DOCTYPE a [<!ENTITY x "y">]><rss><channel>&x;</channel></rss>', 'https://example.com/', parser))
      .toThrow(/DTD/)
  })

  it('gives an undated entry no timestamp rather than today', () => {
    const feed = parseFeed(rss('<item><title>No date</title><link>https://example.com/n</link></item>'), 'https://example.com/f')
    expect(feed.entries[0].publishedTs).toBeNull()
  })
})

describe('parseFeedDate', () => {
  it('pins a zone-less RFC 822 date to UTC so two devices agree', () => {
    expect(parseFeedDate('Tue, 02 Sep 2025 08:30:00')).toBe(Date.UTC(2025, 8, 2, 8, 30))
    expect(parseFeedDate('Tue, 2 Sep 2025 8:30:00 +0200')).toBe(Date.UTC(2025, 8, 2, 6, 30))
  })

  it('reads an ISO date, with and without a time', () => {
    expect(parseFeedDate('2025-09-02T10:00:00+08:00')).toBe(Date.UTC(2025, 8, 2, 2, 0))
    expect(parseFeedDate('2025-09-02')).toBe(Date.UTC(2025, 8, 2))
  })

  it('returns null for anything that is not a date', () => {
    for (const value of ['', '   ', 'sometime last autumn', 'not-a-date']) expect(parseFeedDate(value)).toBeNull()
  })
})

describe('plainText', () => {
  it('strips markup, decodes what DOMParser left, and collapses runs', () => {
    expect(plainText('<p>One   two</p>\n<div>three</div>')).toBe('One two three')
    expect(plainText('a &amp; b')).toBe('a & b')
  })
})

describe('OPML', () => {
  const opml = `<opml version="2.0"><body>
    <outline text="Tech">
      <outline text="Feeds">
        <outline type="rss" text="A" xmlUrl="https://example.com/a.xml"/>
      </outline>
      <outline title="B" xmlUrl="https://example.com/b.xml"/>
    </outline>
    <outline text="Loose" xmlUrl="https://example.com/a.xml"/>
    <outline text="Not a feed"/>
  </body></opml>`

  it('flattens nested outlines into group paths and skips duplicate addresses', () => {
    const parsed = parseOpml(opml, parser)
    expect(parsed.feeds).toEqual([
      { url: 'https://example.com/a.xml', title: 'A', group: 'Tech / Feeds', groupPath: ['Tech', 'Feeds'] },
      { url: 'https://example.com/b.xml', title: 'B', group: 'Tech', groupPath: ['Tech'] },
    ])
    expect(parsed.skipped).toBe(1)
  })

  it('refuses a document that is not OPML', () => {
    expect(() => parseOpml('<rss><channel/></rss>', parser)).toThrow(FeedParseError)
  })

  it('round-trips through an export, nesting and all', () => {
    const xml = exportOpml([
      { url: 'https://example.com/a.xml', title: 'A & "B"', groupPath: ['Tech', 'Feeds'] },
      { url: 'https://example.com/c.xml', title: 'C', groupPath: [] },
    ], 'Inkstone subscriptions')
    // The nesting is the point: an export that flattens front-end/articles into one folder name
    // is a file that quietly rebuilds a reader's library wrong.
    expect(xml).toContain('<outline text="Tech" title="Tech">')
    expect(xml).toContain('<outline text="Feeds" title="Feeds">')
    const parsed = parseOpml(xml, parser)
    expect(parsed.feeds).toEqual([
      { url: 'https://example.com/c.xml', title: 'C', group: '', groupPath: [] },
      { url: 'https://example.com/a.xml', title: 'A & "B"', group: 'Tech / Feeds', groupPath: ['Tech', 'Feeds'] },
    ])
  })
})

describe('group names', () => {
  it('folds case, spacing and the aliases a reader types', () => {
    expect(groupKey('  Pod_Casts ')).toBe(groupKey('podcasts'))
    expect(groupKey('\u64ad\u5ba2')).toBe('podcasts')
    expect(groupKey('Blogs')).toBe('blogs')
    expect(groupKey('Reading list')).toBe('reading list')
  })
})

describe('the local article cache', () => {
  it('rebuilds what a device stored, inside the same ceilings', () => {
    const cache = parseFeedCache({
      feedId: 'f1',
      fetchedAt: 1234,
      entries: Array.from({ length: RSS_LIMITS.entriesPerFeed + 10 }, (_, index) => ({
        id: `e${index}`,
        title: `Post ${index}`,
        link: `https://example.com/${index}`,
        content: 'x'.repeat(9000),
      })),
    })
    expect(cache!.fetchedAt).toBe(1234)
    expect(cache!.entries.length).toBeGreaterThan(0)
    expect(cache!.entries.length).toBeLessThanOrEqual(RSS_LIMITS.entriesPerFeed)
    expect(cache!.entries[0].feedId).toBe('f1')
  })

  it('refuses a cache that is not one', () => {
    for (const value of [null, {}, { feedId: 'f1' }, { feedId: '', entries: [] }]) expect(parseFeedCache(value)).toBeNull()
  })
})

describe('identities', () => {
  it('derives a feed id from the canonical address', () => {
    expect(feedIdFor('https://Example.com/blog/')).toBe(feedIdFor('https://example.com/blog'))
    expect(feedIdFor('https://example.com/blog')).toBe(feedIdFor('https://www.example.com/blog'))
    expect(feedIdFor('https://example.com/a')).not.toBe(feedIdFor('https://example.com/b'))
  })

  it('keeps an entry id stable for the same feed and identity', () => {
    expect(entryIdFor('f1', 'abc')).toBe(entryIdFor('f1', 'abc'))
    expect(entryIdFor('f1', 'abc')).not.toBe(entryIdFor('f2', 'abc'))
    expect(entryIdFor('f1', 'abc')).toMatch(/^e[0-9a-f]{16}$/)
  })
})

describe('canonicalFeedUrl', () => {
  it('drops tracking parameters, the www prefix and a trailing slash', () => {
    expect(canonicalFeedUrl('https://WWW.Example.com/blog/?utm_source=x&fbclid=1')).toBe('https://example.com/blog')
    expect(canonicalFeedUrl('http://example.com/feed.xml#top')).toBe('http://example.com/feed.xml')
  })

  it('refuses a non-http scheme and embedded credentials', () => {
    expect(canonicalFeedUrl('file:///etc/passwd')).toBe('')
    expect(canonicalFeedUrl('https://user:pw@example.com/feed')).toBe('')
    expect(canonicalFeedUrl('not a url')).toBe('')
  })
})

function libraryFixture(): unknown {
  const feed = newFeed('f1', 'https://example.com/feed.xml', 'Example', 0)
  feed.groupId = 'g1'
  feed.updatedAt = 5
  return {
    version: 1,
    groups: [{ id: 'g1', name: 'Tech', collapsed: false, order: 0 }],
    feeds: [feed],
    readIds: ['e0', 'e0', 'e1'],
    favorites: ['e2'],
    readLater: [],
    opened: { e0: 1, e1: 2 },
    savedNotes: { 'e2|note': 'n1' },
    lastChannel: 'feed:f1',
  }
}
describe('parseRssLibrary', () => {
  it('rebuilds a stored library field by field', () => {
    const { data, dropped, truncated } = parseRssLibrary(libraryFixture())
    expect(truncated).toBe(false)
    expect(dropped).toBe(0)
    expect(data!.feeds[0].updatedAt).toBe(5)
    expect(data!.readIds).toEqual(['e0', 'e1'])
    expect(data!.feeds[0].title).toBe('Example')
    expect(data!.lastChannel).toBe('feed:f1')
  })

  it('drops feeds without a usable address and entries without either field', () => {
    const value = libraryFixture() as Record<string, unknown>
    const feeds = value.feeds as Array<Record<string, unknown>>
    feeds.push({ url: 'javascript:alert(1)', title: 'Bad' })
    feeds.push({ url: 'https://other.example.com/feed', title: 'Ok' })
    const { data, dropped } = parseRssLibrary(value)
    expect(dropped).toBeGreaterThan(0)
    expect(data!.feeds.map(feed => feed.url)).toEqual([
      'https://example.com/feed.xml',
      'https://other.example.com/feed',
    ])
    expect(data!.feeds[1].title).toBe('Ok')
  })

  it('clears a group id that names no group, so no feed points at thin air', () => {
    const value = libraryFixture() as Record<string, unknown>
    ;(value.feeds as Array<Record<string, unknown>>)[0].groupId = 'g-missing'
    expect(parseRssLibrary(value).data!.feeds[0].groupId).toBe('')
  })

  it('refuses anything not shaped like a library, including an empty object', () => {
    for (const value of [null, undefined, 'text', 7, [], {}, { feeds: 'nope' }, { feeds: [] }]) {
      expect(parseRssLibrary(value).data).toBeNull()
    }
    const empty = parseRssLibrary({ feeds: [], groups: [] })
    expect(empty.data).toEqual(expect.objectContaining({ feeds: [], groups: [], readIds: [] }))
    expect(empty.dropped).toBe(0)
  })

  it('caps feeds and read marks', () => {
    const value = libraryFixture() as Record<string, unknown>
    value.feeds = Array.from({ length: RSS_LIMITS.feeds + 50 }, (_, index) => ({
      url: `https://example.com/f${index}`,
      title: `Feed ${index}`,
    }))
    value.readIds = Array.from({ length: RSS_LIMITS.readIds + 500 }, (_, index) => `e${index}`)
    const { data, truncated } = parseRssLibrary(value)
    expect(truncated).toBe(true)
    expect(data!.feeds).toHaveLength(RSS_LIMITS.feeds)
    expect(data!.readIds).toHaveLength(RSS_LIMITS.readIds)
  })

  it('trims marks that a hand-edited library smuggled past the parse', () => {
    const data = parseRssLibrary(libraryFixture()).data!
    data.readIds = Array.from({ length: RSS_LIMITS.readIds + 10 }, (_, index) => `x${index}`)
    data.favorites = Array.from({ length: RSS_LIMITS.favorites + 10 }, (_, index) => `f${index}`)
    trimLibrary(data)
    expect(data.readIds).toHaveLength(RSS_LIMITS.readIds)
    expect(data.favorites).toHaveLength(RSS_LIMITS.favorites)
  })
})
