import { describe, expect, it } from 'vitest'
import { emptyLibrary, newFeed, newGroup, type RssEntry } from './model'
import type { RssView } from './reading'
import {
  channelEntries,
  descendantGroupIds,
  channelKey,
  feedIsDue,
  feedShelfOrder,
  feedWantsRefresh,
  findEntry,
  groupIdFor,
  groupedFeeds,
  mergeEntries,
  orderByStaleness,
  groupKey,
  parseChannelKey,
  remoteContentKey,
  refreshBackoffMs,
  selectEntries,
  sortEntries,
  stepIndex,
  uniqueRemoteEntries,
  unreadCounts,
} from './reading'

function entry(feedId: string, id: string, publishedTs: number | null, title = id): RssEntry {
  return {
    id,
    feedId,
    title,
    link: `https://example.com/${id}`,
    author: '',
    publishedTs,
    summary: `${title} summary`,
    content: `<p>${title}</p>`,
    imageUrl: '',
    audioUrl: '',
  }
}

function library(): RssView {
  const a = newFeed('fa', 'https://a.example.com/feed', 'Alpha', 0)
  const b = newFeed('fb', 'https://b.example.com/feed', 'Beta', 1)
  a.groupId = 'g1'
  return {
    library: { ...emptyLibrary(), feeds: [a, b], groups: [newGroup('g1', 'Tech', 0)] },
    articles: {
      fa: [entry('fa', 'a1', 300), entry('fa', 'a2', 100)],
      fb: [entry('fb', 'b1', 200), entry('fb', 'b2', null)],
    },
  }
}

describe('channels', () => {
  it('round-trips a channel through its key', () => {
    for (const channel of [
      { kind: 'all' },
      { kind: 'feed', feedId: 'fa' },
      { kind: 'group', groupId: 'g1' },
      { kind: 'starred' },
      { kind: 'later' },
    ] as const) {
      expect(parseChannelKey(channelKey(channel))).toEqual(channel)
    }
    expect(parseChannelKey('nonsense')).toEqual({ kind: 'all' })
  })

  it('reads one feed whole and a merged channel by its newest slice', () => {
    const state = library()
    expect(channelEntries(state, { kind: 'feed', feedId: 'fa' }).map(item => item.id)).toEqual(['a1', 'a2'])
    expect(channelEntries(state, { kind: 'all' }).map(item => item.id)).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(channelEntries(state, { kind: 'group', groupId: 'g1' }).map(item => item.id)).toEqual(['a1', 'a2'])
  })

  it('keeps undated entries at the end of a merged list without inventing a date', () => {
    const ids = channelEntries(library(), { kind: 'all' }).map(item => item.id)
    expect(ids[ids.length - 1]).toBe('b2')
  })

  it('answers the saved views from the marks rather than the feeds', () => {
    const state = library()
    state.library.favorites = ['b1']
    state.library.readLater = ['a2']
    expect(channelEntries(state, { kind: 'starred' }).map(item => item.id)).toEqual(['b1'])
    expect(channelEntries(state, { kind: 'later' }).map(item => item.id)).toEqual(['a2'])
  })

  it('finds an entry by id across feeds', () => {
    const state = library()
    expect(findEntry(state, 'b1')?.title).toBe('b1')
    expect(findEntry(state, 'nope')).toBeUndefined()
    expect(findEntry(state, '')).toBeUndefined()
  })
})

describe('the list a reader sees', () => {
  const state = library()

  it('hides what the reader has opened once the unread filter is on', () => {
    const read = new Set(['a1'])
    const all = channelEntries(state, { kind: 'all' })
    expect(selectEntries(all, { filter: 'unread' }, state, { readIds: read }).map(item => item.id))
      .toEqual(['b1', 'a2', 'b2'])
  })

  it('filters before it searches, so a query never widens the filter on screen', () => {
    const all = channelEntries(state, { kind: 'all' })
    expect(selectEntries(all, { filter: 'all', terms: ['a1'] }, state).map(item => item.id)).toEqual(['a1'])
    const read = new Set(['a1'])
    expect(selectEntries(all, { filter: 'unread', terms: ['a1'] }, state, { readIds: read })).toHaveLength(0)
  })

  it('searches feed names only when asked to', () => {
    const all = channelEntries(state, { kind: 'all' })
    expect(selectEntries(all, { filter: 'all', terms: ['alpha'] }, state)).toHaveLength(0)
    expect(selectEntries(all, { filter: 'all', terms: ['alpha'], fields: 'entry-and-feed' }, state)).toHaveLength(2)
  })

  it('matches every term rather than any of them', () => {
    const all = channelEntries(state, { kind: 'all' })
    expect(selectEntries(all, { filter: 'all', terms: ['a1', 'summary'] }, state)).toHaveLength(1)
    expect(selectEntries(all, { filter: 'all', terms: ['a1', 'nothing'] }, state)).toHaveLength(0)
  })
})

describe('badges', () => {
  it('counts unread per feed, per group and in total, in one pass', () => {
    const state = library()
    state.library.readIds = ['a1']
    const counts = unreadCounts(state)
    expect(counts.feeds.get('fa')).toBe(1)
    expect(counts.feeds.get('fb')).toBe(2)
    expect(counts.groups.get('g1')).toBe(1)
    expect(counts.total).toBe(3)
  })
})

describe('groups', () => {
  it('keeps the group order and puts unfiled feeds last', () => {
    const state = library()
    const second = newGroup('g0', 'Reading', 0)
    state.library.groups = [newGroup('g1', 'Tech', 1), second]
    state.library.feeds.push(Object.assign(newFeed('fc', 'https://c.example.com/feed', 'Gamma', 0), { groupId: 'g0' }))
    const grouped = groupedFeeds(state.library)
    expect(grouped.map(item => item.group?.name ?? '')).toEqual(['Reading', 'Tech', ''])
    expect(grouped[1].feeds.map(feed => feed.title)).toEqual(['Alpha'])
    expect(grouped[2].feeds.map(feed => feed.title)).toEqual(['Beta'])
  })

  it('drops a group that holds nothing, and folds alias names onto one id', () => {
    const state = library()
    state.library.groups.push(newGroup('g9', 'Empty', 5))
    expect(groupedFeeds(state.library).some(item => item.group?.name === 'Empty')).toBe(false)
    expect(groupIdFor('Podcasts')).toBe(groupIdFor('podcast'))
    expect(groupIdFor('Reading list')).toBe('greading list')
  })
})

describe('refresh scheduling', () => {
  it('backs a failing feed off to an hour and no further', () => {
    expect(refreshBackoffMs(0)).toBe(0)
    expect(refreshBackoffMs(1)).toBe(5 * 60_000)
    expect(refreshBackoffMs(3)).toBe(20 * 60_000)
    expect(refreshBackoffMs(12)).toBe(60 * 60_000)
  })

  it('waits out the ceiling, respects a pause and honours a backoff', () => {
    const now = 10_000_000
    const feed = newFeed('fa', 'https://a.example.com/feed', 'Alpha', 0)
    feed.updatedAt = now - 4 * 60_000
    expect(feedIsDue(feed, now)).toBe(false)
    feed.updatedAt = now - 6 * 60_000
    expect(feedIsDue(feed, now)).toBe(true)
    feed.paused = true
    expect(feedIsDue(feed, now)).toBe(false)
    feed.paused = false
    feed.errorCount = 2
    feed.lastErrorAt = now - 11 * 60_000
    expect(feedIsDue(feed, now)).toBe(true)
    feed.lastErrorAt = now - 60_000
    expect(feedIsDue(feed, now)).toBe(false)
  })

  it('paints stale feeds first and failing ones last', () => {
    const fresh = newFeed('f1', 'https://1.example.com/feed', 'one', 0)
    fresh.updatedAt = 900
    const old = newFeed('f2', 'https://2.example.com/feed', 'two', 1)
    old.updatedAt = 100
    const broken = newFeed('f3', 'https://3.example.com/feed', 'three', 2)
    broken.updatedAt = 50
    broken.errorCount = 3
    expect(orderByStaleness([fresh, broken, old]).map(feed => feed.id)).toEqual(['f2', 'f1', 'f3'])
  })
})

describe('an explicit refresh', () => {
  it('overrides a pause and a backoff the reader did not ask to wait out', () => {
    const now = 10_000_000
    const feed = newFeed('fa', 'https://a.example.com/feed', 'Alpha', 0)
    feed.paused = true
    feed.errorCount = 4
    feed.lastErrorAt = now
    feed.updatedAt = now
    expect(feedWantsRefresh(feed, now, false, 0)).toBe(false)
    expect(feedWantsRefresh(feed, now, true, 0)).toBe(true)
  })
})

describe('list movement', () => {
  it('clamps at both ends and answers -1 for an empty list', () => {
    expect(stepIndex(0, -1, 5)).toBe(0)
    expect(stepIndex(4, 1, 5)).toBe(4)
    expect(stepIndex(-1, 1, 5)).toBe(0)
    expect(stepIndex(2, 1, 0)).toBe(-1)
  })

  it('puts a pinned subscription first, then leaves the arrangement alone', () => {
    const a = newFeed('fa', 'https://a.test/feed', 'A', 0)
    const b = newFeed('fb', 'https://b.test/feed', 'B', 1)
    const c = newFeed('fc', 'https://c.test/feed', 'C', 2)
    c.pinned = true
    b.pinned = true
    expect([a, b, c].sort(feedShelfOrder).map(feed => feed.id)).toEqual(['fb', 'fc', 'fa'])
    // Two rows that disagree about which is first still settle by the arrangement, not by name.
    a.order = 5
    expect([a, c].sort(feedShelfOrder).map(feed => feed.id)).toEqual(['fc', 'fa'])
  })

  it('merges lists without duplicating an id and keeps the first copy', () => {
    const merged = mergeEntries([entry('fa', 'x', 10)], [entry('fa', 'x', 10, 'first wins'), entry('fb', 'y', 20)])
    expect(merged.map(item => `${item.id}:${item.title}`)).toEqual(['y:y', 'x:x'])
  })
})

describe('nested folders, tags and the saved channels', () => {
  function shelf(): RssView {
    const a = newFeed('fa', 'https://a.example.com/feed', 'Alpha', 0)
    const b = newFeed('fb', 'https://b.example.com/feed', 'Beta', 1)
    const c = newFeed('fc', 'https://c.example.com/feed', 'Gamma', 2)
    a.groupId = 'g1'
    b.groupId = 'g2'
    c.groupId = ''
    a.tags = ['tech/rss']
    b.tags = ['Tech']
    const groups = [
      newGroup('g1', 'Tech', 0),
      newGroup('g2', 'Feeds', 1, 'g1'),
      newGroup('g3', 'Orphan', 2, 'g4'),
    ]
    return {
      library: {
        ...emptyLibrary(),
        feeds: [a, b, c],
        groups,
        readIds: ['b1'],
        hiddenIds: ['a2'],
        opened: { b1: 900, a1: 800, b2: 700 },
      },
      articles: {
        fa: [entry('fa', 'a1', 300), entry('fa', 'a2', 100)],
        fb: [entry('fb', 'b1', 200), entry('fb', 'b2', 150)],
      },
    }
  }

  it('reads a folder as its whole subtree', () => {
    const view = shelf()
    const ids = channelEntries(view, { kind: 'group', groupId: 'g1' }).map(item => item.id)
    expect([...ids].sort()).toEqual(['a1', 'b1', 'b2'])
    const nested = channelEntries(view, { kind: 'group', groupId: 'g2' }).map(item => item.id)
    expect(nested.sort()).toEqual(['b1', 'b2'])
  })

  it('stops at a folder that is its own ancestor', () => {
    const view = shelf()
    view.library.groups.push({ ...newGroup('g4', 'Ring', 3, 'g3') })
    expect(() => descendantGroupIds(view.library.groups, 'g3')).not.toThrow()
    expect([...descendantGroupIds(view.library.groups, 'g3')]).toEqual(['g4'])
  })

  it('keeps two folders of one name apart when they hang under different parents', () => {
    expect(groupIdFor('Articles', null)).not.toBe(groupIdFor('Articles', 'g1'))
    expect(groupIdFor('Articles')).toBe(groupIdFor('articles '))
  })

  it('matches a tag and everything below it, and nothing that merely starts the same way', () => {
    const view = shelf()
    const tech = channelEntries(view, { kind: 'tag', tag: 'tech' }).map(item => item.id)
    expect(tech.sort()).toEqual(['a1', 'b1', 'b2'])
    expect(channelEntries(view, { kind: 'tag', tag: 'tech/rss' }).map(item => item.id)).toEqual(['a1'])
    expect(channelEntries(view, { kind: 'tag', tag: 'techx' })).toEqual([])
  })

  it('keeps a dismissed article out of every channel', () => {
    const view = shelf()
    view.library.favorites = ['a2']
    view.library.readLater = ['a2']
    for (const channel of [{ kind: 'all' }, { kind: 'unread' }, { kind: 'starred' }, { kind: 'later' }, { kind: 'feed', feedId: 'fa' }] as const) {
      expect(channelEntries(view, channel).map(item => item.id), channel.kind).not.toContain('a2')
    }
  })

  it('answers the unread channel with what is neither read nor hidden', () => {
    const view = shelf()
    expect(channelEntries(view, { kind: 'unread' }).map(item => item.id).sort()).toEqual(['a1', 'b2'])
  })

  it('answers the recent channel in the order things were opened', () => {
    const view = shelf()
    expect(channelEntries(view, { kind: 'recent' }).map(item => item.id)).toEqual(['b1', 'a1', 'b2'])
  })

  it('sorts by the reader\u2019s choice, and keeps undated rows in feed order', () => {
    const view = shelf()
    const all = channelEntries(view, { kind: 'all' })
    expect(sortEntries(all, 'newest', view.library.feeds).map(item => item.id)[0]).toBe('a1')
    expect(sortEntries(all, 'oldest', view.library.feeds).map(item => item.id)[0]).toBe('b2')
    const bySource = sortEntries(all, 'source', view.library.feeds)
    expect(bySource[0].feedId).toBe('fa')
    expect(bySource.filter(item => item.feedId === 'fb')[0].id).toBe('b1')
  })

  it('rolls a folder\u2019s unread count up through its parents', () => {
    const counts = unreadCounts(shelf())
    expect(counts.groups.get('g2')).toBe(1)
    expect(counts.groups.get('g1')).toBe(2)
    expect(counts.tags.get('tech')).toBe(2)
    expect(counts.tags.get('tech/rss')).toBe(1)
    // a1 and b2: b1 is read, a2 is hidden, and feed c has nothing cached.
    expect(counts.total).toBe(2)
  })

  it('round-trips a channel key for every kind', () => {
    for (const channel of [
      { kind: 'all' }, { kind: 'unread' }, { kind: 'recent' }, { kind: 'starred' }, { kind: 'later' },
      { kind: 'group', groupId: 'g1' }, { kind: 'feed', feedId: 'fa' }, { kind: 'tag', tag: 'tech/rss' },
    ] as const) {
      expect(parseChannelKey(channelKey(channel))).toEqual(channel)
    }
  })
})

describe('WeChat and Xiaoyuzhou duplicates', () => {
  const wx = (query: string) => `https://mp.weixin.qq.com/s?${query}`
  const article = (id: string, link: string, publishedTs: number): RssEntry => ({
    ...entry('fw', id, publishedTs, `Post ${id}`),
    link,
  })
  const copyA = 'chksm=8f1&scene=27&devicemeta=1'
  const copyB = 'chksm=9a2&from=timeline&isappinstalled=0'
  const triple = '__biz=MzA5NjI4MzIyNQ%3D%3D&mid=2650&idx=1&sn=7c1d'

  function bridge(): RssView {
    const feed = newFeed('fw', 'https://wechat2rss.example/feed', '公众号「公路商店」', 0)
    return {
      library: { ...emptyLibrary(), feeds: [feed] },
      articles: {
        fw: [
          article('e-old', wx(`${triple}&${copyA}`), 100),
          article('e-new', wx(`${triple}&${copyB}`), 200),
          article('e-other', wx(`__biz=MzA5NjI4MzIyNQ%3D%3D&mid=2651&idx=1&sn=9z&${copyA}`), 150),
          article('e-plain', 'https://blog.example.com/post', 120),
        ],
      },
    }
  }

  it('reads the identity out of the link and nothing else', () => {
    expect(remoteContentKey(wx(`${triple}&${copyA}`))).toBe('wx:MzA5NjI4MzIyNQ==/2650/1')
    expect(remoteContentKey(wx(`${triple}&${copyB}`))).toBe(remoteContentKey(wx(`${triple}&${copyA}`)))
    expect(remoteContentKey(wx('__biz=MzA5Nj&mid=2650&sn=x'))).toBe('')
    expect(remoteContentKey(wx('mid=2650&idx=1&sn=x'))).toBe('')
    expect(remoteContentKey('http://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1')).toBe('')
    expect(remoteContentKey('https://mp.weixin.qq.com/profile?__biz=a&mid=1&idx=1')).toBe('')
    expect(remoteContentKey('https://blog.example.com/s?__biz=a&mid=1&idx=1')).toBe('')
    expect(remoteContentKey('')).toBe('')
  })

  it('reads a podcast episode id, with or without the share suffix', () => {
    expect(remoteContentKey('https://www.xiaoyuzhoufm.com/episode/64f1a2b3c4d5e6f7a8b9c0d1')).toBe('xyz:64f1a2b3c4d5e6f7a8b9c0d1')
    expect(remoteContentKey('https://www.xiaoyuzhoufm.com/episode/64F1A2B3C4D5E6F7A8B9C0D1/?share_medium=iphone')).toBe('xyz:64f1a2b3c4d5e6f7a8b9c0d1')
    expect(remoteContentKey('https://www.xiaoyuzhoufm.com/podcast/64f1a2')).toBe('')
  })

  it('shows one row per article and keeps the newer copy', () => {
    const list = uniqueRemoteEntries(bridge().articles.fw)
    expect(list.map(item => item.id)).toEqual(['e-new', 'e-other', 'e-plain'])
  })

  it('never swaps the article the reader is looking at', () => {
    const list = uniqueRemoteEntries(bridge().articles.fw, 'e-old')
    expect(list.map(item => item.id)).toEqual(['e-old', 'e-other', 'e-plain'])
  })

  it('collapses the duplicates in a channel, not only in a helper', () => {
    expect(channelEntries(bridge(), { kind: 'feed', feedId: 'fw' }).map(item => item.id)).toEqual(['e-new', 'e-other', 'e-plain'])
  })

  it('keeps a read article read when the bridge hands out a new id for it', () => {
    const view = bridge()
    // The reader finished the article when the only copy the feed had was `e-old`.
    view.library.readIds = ['e-old']
    const unread = selectEntries(channelEntries(view, { kind: 'feed', feedId: 'fw' }), { filter: 'unread' }, view)
    expect(unread.map(item => item.id)).toEqual(['e-other', 'e-plain'])
  })

  it('counts the badge on the list it labels', () => {
    expect(unreadCounts(bridge()).feeds.get('fw')).toBe(3)
  })

  it('folds the WeChat shelf names onto one group', () => {
    expect(groupKey('公众号')).toBe('wechat')
    expect(groupKey('微信公众号')).toBe('wechat')
    expect(groupKey('WeChat')).toBe('wechat')
    expect(groupKey('前端')).toBe('前端'.normalize('NFKC').toLowerCase())
  })
})
