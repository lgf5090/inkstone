import { beforeEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  SavedYouTubeChannel,
  SavedYouTubePlaylist,
  SavedYouTubeVideo,
  YouTubeLibrary,
  YouTubeTag,
  YouTubeVideo,
} from '@shared/youtube/model'
import { act } from 'react'
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
  { id: 'root', name: 'Root', color: '#64748b', parentId: null, sortOrder: 0, pinned: false, createdAt: 1 },
  { id: 'child', name: 'Child', color: '#64748b', parentId: 'root', sortOrder: 0, pinned: false, createdAt: 2 },
  { id: 'other', name: 'Other', color: '#64748b', parentId: null, sortOrder: 1, pinned: false, createdAt: 3 },
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
  sortOrder: 0,
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
  sortOrder: 0,
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
    const aside = rendered.container.querySelector('[data-collapsed]')
    const all = rendered.container.querySelector('a[href="/youtube/all"]')

    expect(aside?.getAttribute('data-collapsed')).toBe('true')
    expect(all?.getAttribute('aria-label')).toBe(t('youtube.sidebar.all'))
    expect(all?.textContent?.trim()).toBe('')
    expect(all?.getAttribute('aria-current')).toBe('page')

    rendered.unmount()
  })

  it('puts the expand button in the collapsed header and calls it', () => {
    const onCollapse = vi.fn()
    const rendered = renderElement(
      <YoutubeSidebar collapsed activeView={{ kind: 'explore' }} sort="viewCount" range="week" onCollapse={onCollapse} />,
    )
    const button = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('youtube.sidebar.expand')}"]`)
    expect(button).not.toBeNull()
    expect(button!.closest('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('true')
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onCollapse).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })

  it('filters the tag forest without losing the indent', async () => {
    const rendered = renderElement(
      <YoutubeSidebar activeView={{ kind: 'explore' }} sort="viewCount" range="week" />,
    )
    const input = rendered.container.querySelector<HTMLInputElement>(`input[placeholder="${t('tags.filter_placeholder')}"]`)
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Chi')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const links = Array.from(rendered.container.querySelectorAll('a[href^="/youtube/tags/"]'))
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/youtube/tags/child'])
    expect((rendered.container.querySelector('[data-tag-depth="1"]') as HTMLElement | null)?.style.paddingLeft)
      .toBe(`${treeIndent(1)}px`)
    rendered.unmount()
  })

  it('says so when the tag filter matches nothing and lets the reader clear it', async () => {
    const rendered = renderElement(
      <YoutubeSidebar activeView={{ kind: 'explore' }} sort="viewCount" range="week" />,
    )
    const input = rendered.container.querySelector<HTMLInputElement>(`input[placeholder="${t('tags.filter_placeholder')}"]`)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'zzz-no-tag')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rendered.container.querySelectorAll('[data-tag-id]')).toHaveLength(0)
    expect(rendered.container.textContent).toContain(t('tags.no_match'))
    const clear = Array.from(rendered.container.querySelectorAll('button')).find((button) => button.textContent === t('common.clear'))
    expect(clear).toBeTruthy()
    await act(async () => { clear!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(rendered.container.textContent).not.toContain(t('tags.no_match'))
    rendered.unmount()
  })

  it('draws pinned tags before their unpinned siblings', () => {
    useYoutubeStore.setState({
      library: {
        ...library,
        tags: [
          { ...tags[0]!, pinned: false },
          { ...tags[1]!, pinned: false },
          { ...tags[2]!, pinned: true },
        ],
      },
    })
    const rendered = renderElement(
      <YoutubeSidebar activeView={{ kind: 'explore' }} sort="viewCount" range="week" />,
    )
    const ids = Array.from(rendered.container.querySelectorAll('[data-tag-depth]')).map((row) => (row as HTMLElement).dataset.tagId)
    expect(ids[0]).toBe('other')
    rendered.unmount()
  })
})
