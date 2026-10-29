import { beforeEach, beforeAll, describe, expect, it } from 'vitest'
import type {
  SavedYouTubeChannel,
  SavedYouTubePlaylist,
  SavedYouTubeVideo,
  YouTubeLibrary,
  YouTubeTag,
  YouTubeVideo,
} from '@shared/youtube/model'
import { initI18n, t } from '../../../lib/i18n'
import { treeIndent } from '../../../lib/tree/indent'
import { installTestGlobals, renderElement } from '../../../lib/test-render'
import { useYoutubeStore } from '../store'
import { YoutubeSidebar } from './YoutubeSidebar'

function video(id: string): YouTubeVideo {
  return {
    id,
    title: `Video ${id}`,
    description: '',
    publishedAt: '2026-05-01T00:00:00.000Z',
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
  }
}

function saved(id: string, overrides: Partial<SavedYouTubeVideo> = {}): SavedYouTubeVideo {
  return {
    id,
    title: `Video ${id}`,
    thumbnailUrl: '',
    channelId: 'channel',
    channelTitle: 'Channel',
    data: video(id),
    tagIds: [],
    pinned: false,
    favorited: false,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const tags: YouTubeTag[] = [
  { id: 'root', name: 'Root', color: '#64748b', parentId: null, sortOrder: 0, createdAt: 1 },
  { id: 'child', name: 'Child', color: '#64748b', parentId: 'root', sortOrder: 0, createdAt: 2 },
  { id: 'other', name: 'Other', color: '#64748b', parentId: null, sortOrder: 1, createdAt: 3 },
]

const savedChannel: SavedYouTubeChannel = {
  id: 'channel',
  data: {
    id: 'channel',
    title: 'Saved channel',
    description: '',
    customUrl: null,
    thumbnailUrl: '',
    subscriberCount: 0,
    videoCount: 1,
    uploadsPlaylistId: 'uploads',
    publishedAt: '',
  },
  tagIds: [],
  pinned: false,
  notes: '',
  createdAt: 1,
  updatedAt: 1,
}

const savedPlaylist: SavedYouTubePlaylist = {
  id: 'playlist',
  data: {
    id: 'playlist',
    title: 'Saved playlist',
    description: '',
    channelId: 'channel',
    channelTitle: 'Channel',
    thumbnailUrl: '',
    itemCount: 1,
    publishedAt: '',
  },
  tagIds: [],
  pinned: false,
  favorited: false,
  notes: '',
  createdAt: 1,
  updatedAt: 1,
}

const library: YouTubeLibrary = {
  tags,
  videos: [
    saved('one', { pinned: true, tagIds: ['root'] }),
    saved('two', { favorited: true, tagIds: ['root', 'child'] }),
    saved('three', { tagIds: ['child'] }),
  ],
  channels: [savedChannel],
  playlists: [savedPlaylist],
  truncated: false,
}

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  useYoutubeStore.setState({
    library,
    libraryStatus: 'ready',
    libraryError: null,
    expandedSections: ['channels', 'playlists'],
    expandedTags: ['root'],
  })
})

describe('YoutubeSidebar', () => {
  it('shows library counts, hides zero counts and marks the active view', () => {
    const rendered = renderElement(
      <YoutubeSidebar activeView={{ kind: 'explore' }} sort="viewCount" range="week" />,
    )
    const all = rendered.container.querySelector('a[href="/youtube/all"]')
    const pinned = rendered.container.querySelector('a[href="/youtube/pinned"]')
    const favorites = rendered.container.querySelector('a[href="/youtube/favorites"]')
    const otherTag = rendered.container.querySelector('a[href="/youtube/tags/other"]')

    expect(all?.textContent).toContain('3')
    expect(pinned?.textContent).toContain('1')
    expect(favorites?.textContent).toContain('1')
    expect(otherTag?.textContent).not.toContain('0')
    expect(rendered.container.querySelector('a[href="/youtube"][aria-current="page"]')).not.toBeNull()

    rendered.unmount()
  })

  it('renders the tag forest in tree order with one indent step per depth', () => {
    const rendered = renderElement(
      <YoutubeSidebar activeView={{ kind: 'tag', tagId: 'child' }} sort="viewCount" range="week" />,
    )
    const links = Array.from(rendered.container.querySelectorAll('a[href^="/youtube/tags/"]'))
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/youtube/tags/root',
      '/youtube/tags/child',
      '/youtube/tags/other',
    ])
    expect(rendered.container.querySelector('a[href="/youtube/tags/child"]')?.getAttribute('aria-current')).toBe('page')

    const rootRow = rendered.container.querySelector('[data-tag-depth="0"]') as HTMLElement | null
    const childRow = rendered.container.querySelector('[data-tag-depth="1"]') as HTMLElement | null
    expect(rootRow?.style.paddingLeft).toBe(`${treeIndent(0)}px`)
    expect(childRow?.style.paddingLeft).toBe(`${treeIndent(1)}px`)

    rendered.unmount()
  })

  it('collapses to icon-only links with accessible names', () => {
    const rendered = renderElement(
      <YoutubeSidebar collapsed activeView={{ kind: 'library', filter: 'all' }} sort="viewCount" range="week" />,
    )
    const aside = rendered.container.querySelector('aside')
    const all = rendered.container.querySelector('a[href="/youtube/all"]')

    expect(aside?.getAttribute('data-collapsed')).toBe('true')
    expect(all?.getAttribute('aria-label')).toBe(t('youtube.sidebar.all'))
    expect(all?.textContent?.trim()).toBe('')
    expect(all?.getAttribute('aria-current')).toBe('page')

    rendered.unmount()
  })
})
