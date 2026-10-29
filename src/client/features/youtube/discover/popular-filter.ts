import {
  rangeCutoff,
  type SortKey,
  type TimeRange,
  type YouTubeVideo,
} from '@shared/youtube/model'

export function filterPopular(
  videos: readonly YouTubeVideo[],
  range: TimeRange,
  sort: SortKey,
  now: number = Date.now(),
): YouTubeVideo[] {
  const cutoff = rangeCutoff(range, now)
  const inRange = videos.filter((video) => {
    const published = Date.parse(video.publishedAt)
    if (!Number.isFinite(published)) return false
    return cutoff === null || published >= cutoff
  })
  if (sort === 'relevance') return inRange
  return inRange.slice().sort((left, right) => {
    if (sort === 'viewCount') return right.viewCount - left.viewCount
    if (sort === 'rating') return right.likeCount - left.likeCount
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
  })
}
