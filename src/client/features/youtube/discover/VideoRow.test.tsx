import { act } from 'react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SavedYouTubeVideo, YouTubeTag, YouTubeVideo } from '@shared/youtube/model'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../lib/test-render'
import { useYoutubeStore } from '../store'
import { VideoRow } from './VideoRow'

const video: YouTubeVideo = {
  id: 'video-one',
  title: 'A video title',
  description: 'Description',
  publishedAt: '2026-05-01T00:00:00.000Z',
  channelId: 'channel',
  channelTitle: 'Channel title',
  thumbnailUrl: 'https://example.test/fallback.jpg',
  thumbnailHighUrl: 'https://example.test/high.jpg',
  duration: 'PT1M2S',
  viewCount: 1234,
  likeCount: 5,
  commentCount: 2,
  tags: [],
  categoryId: '',
  isLive: false,
}

const tag: YouTubeTag = {
  id: 'tag',
  name: 'Watch later',
  color: '#64748b',
  parentId: null,
  sortOrder: 0,
  pinned: false,
  createdAt: 1,
}

const saved: SavedYouTubeVideo = {
  id: video.id,
  title: video.title,
  thumbnailUrl: video.thumbnailUrl,
  channelId: video.channelId,
  channelTitle: video.channelTitle,
  data: video,
  tagIds: [tag.id],
  pinned: true,
  favorited: false,
  notes: '',
  createdAt: 1,
  updatedAt: 1,
}

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  useYoutubeStore.setState({
    library: { tags: [tag], videos: [saved], channels: [], playlists: [], truncated: false },
    libraryStatus: 'ready',
    libraryError: null,
  })
})

describe('VideoRow', () => {
  it('keeps row actions outside the selection button and names them', () => {
    const rendered = renderElement(
      <ul>
        <VideoRow video={video} saved={saved} allTags={[tag]} selected onSelect={() => {}} />
      </ul>,
    )
    const select = rendered.container.querySelector(
      `button[aria-label="${t('youtube.video.select', { title: video.title })}"]`,
    )
    const pin = rendered.container.querySelector(`button[aria-label="${t('youtube.video.unpin')}"]`)
    const favorite = rendered.container.querySelector(`button[aria-label="${t('youtube.video.favorite')}"]`)

    expect(select).not.toBeNull()
    expect(select?.getAttribute('aria-current')).toBe('true')
    expect(select?.querySelectorAll('button')).toHaveLength(0)
    expect(pin?.getAttribute('aria-pressed')).toBe('true')
    expect(favorite?.getAttribute('aria-pressed')).toBe('false')
    expect(rendered.container.textContent).toContain(tag.name)
    expect(rendered.container.querySelector('img')?.getAttribute('src')).toBe('/api/youtube/media/thumbnail/video-one')

    rendered.unmount()
  })

  it('selects the row through its overlay button', () => {
    let selected: YouTubeVideo | null = null
    const rendered = renderElement(
      <ul>
        <VideoRow video={video} saved={saved} allTags={[tag]} selected={false} onSelect={(entry) => {
          selected = entry
        }} />
      </ul>,
    )
    const select = rendered.container.querySelector(
      `button[aria-label="${t('youtube.video.select', { title: video.title })}"]`,
    )
    act(() => {
      select?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(selected).toBe(video)

    rendered.unmount()
  })
})
