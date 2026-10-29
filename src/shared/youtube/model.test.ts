import { describe, expect, it } from 'vitest'
import {
  DEFAULT_YOUTUBE_PREFS,
  buildTagTree,
  formatCount,
  formatPublished,
  parseDuration,
  parseYouTubeAddress,
  rangeCutoff,
  shouldDeleteSavedVideo,
  startOfLocalDay,
  tagDepth,
  tagSubtreeIds,
  wouldCreateTagCycle,
  youtubeSearchParams,
  youtubeViewPath,
  type YouTubeTag,
} from './model'

const tag = (id: string, parentId: string | null = null, sortOrder = 0, createdAt = 1): YouTubeTag => ({
  id,
  name: id,
  color: '#64748b',
  parentId,
  sortOrder,
  pinned: false,
  createdAt,
})

describe('the YouTube address', () => {
  it('names every view the tab publishes', () => {
    expect(parseYouTubeAddress('/youtube', '').view).toEqual({ kind: 'explore' })
    expect(parseYouTubeAddress('/youtube/all', '').view).toEqual({ kind: 'library', filter: 'all' })
    expect(parseYouTubeAddress('/youtube/pinned/', '').view).toEqual({ kind: 'library', filter: 'pinned' })
    expect(parseYouTubeAddress('/youtube/favorites', '').view).toEqual({ kind: 'library', filter: 'favorites' })
    expect(parseYouTubeAddress('/youtube/tags/abc', '').view).toEqual({ kind: 'tag', tagId: 'abc' })
    expect(parseYouTubeAddress('/youtube/channels/UC123', '').view).toEqual({ kind: 'channel', channelId: 'UC123' })
    expect(parseYouTubeAddress('/youtube/playlists/PL1', '').view).toEqual({ kind: 'playlist', playlistId: 'PL1' })
  })

  it('fallen back to discover for a path it does not name', () => {
    expect(parseYouTubeAddress('/youtube/whatever/deep', '').view).toEqual({ kind: 'explore' })
    expect(parseYouTubeAddress('/somewhere-else', '').view).toEqual({ kind: 'explore' })
  })

  it('keeps the query on the address and drops an invalid one', () => {
    const address = parseYouTubeAddress('/youtube', '?q=dune&sort=date&range=month&v=abcDEF12345')
    expect(address).toEqual({
      view: { kind: 'explore' },
      q: 'dune',
      sort: 'date',
      range: 'month',
      videoId: 'abcDEF12345',
    })
    expect(parseYouTubeAddress('/youtube', '?sort=nope&range=nope&v=x').sort).toBe(DEFAULT_YOUTUBE_PREFS.sort)
    expect(parseYouTubeAddress('/youtube', '?sort=nope&range=nope&v=x').range).toBe(DEFAULT_YOUTUBE_PREFS.range)
    expect(parseYouTubeAddress('/youtube', '?sort=nope&range=nope&v=x').videoId).toBeNull()
  })

  it('writes a path back for every view', () => {
    expect(youtubeViewPath({ kind: 'explore' })).toBe('/youtube')
    expect(youtubeViewPath({ kind: 'library', filter: 'pinned' })).toBe('/youtube/pinned')
    expect(youtubeViewPath({ kind: 'tag', tagId: 'a b' })).toBe('/youtube/tags/a%20b')
    expect(youtubeViewPath({ kind: 'channel', channelId: 'UC1' })).toBe('/youtube/channels/UC1')
  })

  it('only writes the discover parameters that differ from the defaults', () => {
    expect(youtubeSearchParams({ q: 'x', sort: 'viewCount', range: 'week' })).toBe('q=x')
    expect(youtubeSearchParams({ sort: 'date', range: 'all', videoId: 'v1' })).toBe('sort=date&range=all&v=v1')
  })
})

describe('the pure formatting rules', () => {
  it('formats compact counts the way the reference does', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1_000)).toBe('1K')
    expect(formatCount(1_250)).toBe('1.3K')
    expect(formatCount(2_000_000)).toBe('2M')
    expect(formatCount(3_400_000_000)).toBe('3.4B')
  })

  it('parses an ISO duration and rejects anything else', () => {
    expect(parseDuration('PT1H2M3S')).toBe('1:02:03')
    expect(parseDuration('PT12M3S')).toBe('12:03')
    expect(parseDuration('PT45S')).toBe('0:45')
    expect(parseDuration('')).toBe('')
    expect(parseDuration('1:02:03')).toBe('')
  })

  it('reads a published time in the reader locale', () => {
    const now = new Date('2026-10-29T12:00:00Z').getTime()
    expect(formatPublished('2200-01-01T00:00:00Z', 'en-US', now)).toBe('now')
    expect(formatPublished('2026-10-29T09:00:00Z', 'en-US', now)).toBe('3 hours ago')
    expect(formatPublished('2026-10-20T09:00:00Z', 'en-US', now)).toBe('10/20/2026')
    expect(formatPublished('', 'en-US', now)).toBe('')
    expect(formatPublished('not a date', 'en-US', now)).toBe('')
  })
})

describe('the time-range cutoff', () => {
  it('starts today at the reader own midnight, not at now', () => {
    const now = new Date(2026, 9, 29, 15, 30, 0, 0).getTime()
    expect(rangeCutoff('today', now)).toBe(new Date(2026, 9, 29, 0, 0, 0, 0).getTime())
    expect(rangeCutoff('today', now)).toBe(startOfLocalDay(now))
    expect(rangeCutoff('week', now)).toBe(now - 7 * 86_400_000)
    expect(rangeCutoff('all', now)).toBeNull()
  })
})

describe('the save invariant', () => {
  it('holds a saved video only while one marker remains', () => {
    const cases: [boolean, boolean, string[], boolean][] = [
      [false, false, [], true],
      [true, false, [], false],
      [false, true, [], false],
      [false, false, ['t'], false],
      [true, true, [], false],
      [true, false, ['t'], false],
      [false, true, ['t'], false],
      [true, true, ['t'], false],
    ]
    for (const [pinned, favorited, tagIds, deleted] of cases) {
      expect(shouldDeleteSavedVideo({ pinned, favorited, tagIds })).toBe(deleted)
    }
  })
})

describe('the tag forest', () => {
  it('nests children, orders siblings and keeps orphans at the root', () => {
    const tree = buildTagTree([
      tag('b', null, 1),
      tag('a', null, 0),
      tag('a1', 'a', 1),
      tag('a0', 'a', 0),
      tag('orphan', 'missing', 2),
    ])
    expect(tree.map((node) => node.id)).toEqual(['a', 'b', 'orphan'])
    expect(tree[0]!.children.map((node) => node.id)).toEqual(['a0', 'a1'])
  })

  it('shows a row whose parent chain loops instead of dropping it', () => {
    const tree = buildTagTree([tag('a', 'b'), tag('b', 'a'), tag('c', null)])
    expect(tree.map((node) => node.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('measures depth, collects a subtree and refuses a cycle', () => {
    const tags = [tag('a'), tag('b', 'a'), tag('c', 'b'), tag('d')]
    expect(tagDepth(tags, 'c')).toBe(2)
    expect([...tagSubtreeIds(tags, 'a')].sort()).toEqual(['a', 'b', 'c'])
    expect(wouldCreateTagCycle(tags, 'a', 'c')).toBe(true)
    expect(wouldCreateTagCycle(tags, 'a', 'a')).toBe(true)
    expect(wouldCreateTagCycle(tags, 'a', 'd')).toBe(false)
    expect(wouldCreateTagCycle(tags, 'a', null)).toBe(false)
  })
})
