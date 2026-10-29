import { describe, expect, it } from 'vitest'
import type { YouTubeVideo } from '@shared/youtube/model'
import { filterPopular } from './popular-filter'

const now = new Date(2026, 4, 20, 12, 0, 0).getTime()
const todayStart = new Date(2026, 4, 20, 0, 0, 0).getTime()

function video(id: string, publishedAt: number, overrides: Partial<YouTubeVideo> = {}): YouTubeVideo {
  return {
    id,
    title: id,
    description: '',
    publishedAt: new Date(publishedAt).toISOString(),
    channelId: 'channel',
    channelTitle: 'Channel',
    thumbnailUrl: '',
    thumbnailHighUrl: '',
    duration: '',
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    tags: [],
    categoryId: '',
    isLive: false,
    ...overrides,
  }
}

describe('filterPopular', () => {
  it('uses local midnight for the today range', () => {
    const videos = [
      video('midnight', todayStart),
      video('just-before', todayStart - 1),
      video('yesterday-evening', todayStart - 3 * 60 * 60 * 1000),
    ]
    expect(filterPopular(videos, 'today', 'relevance', now).map((entry) => entry.id)).toEqual(['midnight'])
  })

  it('filters the week range against the same cutoff the chips name', () => {
    const day = 86_400_000
    const videos = [
      video('inside', now - 7 * day),
      video('outside', now - 7 * day - 1),
    ]
    expect(filterPopular(videos, 'week', 'relevance', now).map((entry) => entry.id)).toEqual(['inside'])
  })

  it('drops videos without a parseable published date even for all time', () => {
    const videos = [
      video('dated', now - 30 * 86_400_000),
      { ...video('missing', now), publishedAt: '' },
      { ...video('broken', now), publishedAt: 'not-a-date' },
    ]
    expect(filterPopular(videos, 'all', 'relevance', now).map((entry) => entry.id)).toEqual(['dated'])
  })

  it('keeps the upstream order for relevance', () => {
    const videos = [
      video('a', now - 86_400_000, { viewCount: 5, likeCount: 2 }),
      video('b', now, { viewCount: 30, likeCount: 1 }),
      video('c', now - 2 * 86_400_000, { viewCount: 20, likeCount: 9 }),
    ]
    expect(filterPopular(videos, 'all', 'relevance', now).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts views and likes descending and dates newest first', () => {
    const videos = [
      video('a', now - 86_400_000, { viewCount: 5, likeCount: 2 }),
      video('b', now, { viewCount: 30, likeCount: 1 }),
      video('c', now - 2 * 86_400_000, { viewCount: 20, likeCount: 9 }),
    ]
    expect(filterPopular(videos, 'all', 'viewCount', now).map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
    expect(filterPopular(videos, 'all', 'rating', now).map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
    expect(filterPopular(videos, 'all', 'date', now).map((entry) => entry.id)).toEqual(['b', 'a', 'c'])
  })
})
