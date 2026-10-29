import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedYouTubeVideo, YouTubeTag, YouTubeVideo } from '@shared/youtube/model'
import * as api from './api'
import { useYoutubeStore } from './store'

vi.mock('./api', () => ({
  createTag: vi.fn(),
  deleteChannel: vi.fn(),
  deletePlaylist: vi.fn(),
  deleteTag: vi.fn(),
  deleteVideo: vi.fn(),
  fetchLibrary: vi.fn(),
  putChannel: vi.fn(),
  putPlaylist: vi.fn(),
  putVideo: vi.fn(),
  reorderChannels: vi.fn(),
  reorderPlaylists: vi.fn(),
  reorderTags: vi.fn(),
  updateTag: vi.fn(),
}))

const video: YouTubeVideo = {
  id: 'vid00000001',
  title: 'A video',
  description: '',
  publishedAt: '2026-10-01T00:00:00Z',
  channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
  channelTitle: 'A channel',
  thumbnailUrl: 'https://example.com/t.jpg',
  thumbnailHighUrl: 'https://example.com/h.jpg',
  duration: '1:00',
  viewCount: 1,
  likeCount: 1,
  commentCount: 1,
  tags: [],
  categoryId: '',
  isLive: false,
}

function saved(patch: Partial<SavedYouTubeVideo> = {}): SavedYouTubeVideo {
  return {
    id: video.id,
    title: video.title,
    thumbnailUrl: video.thumbnailUrl,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    data: video,
    tagIds: [],
    pinned: false,
    favorited: false,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function tag(id: string, parentId: string | null = null): YouTubeTag {
  return { id, name: id, color: '#64748b', parentId, sortOrder: 0, pinned: false, createdAt: 1 }
}

function reset(library: Partial<ReturnType<typeof useYoutubeStore.getState>['library']> = {}): void {
  useYoutubeStore.setState({
    library: { tags: [], videos: [], channels: [], playlists: [], truncated: false, ...library },
    libraryStatus: 'ready',
    libraryError: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  vi.mocked(api.putVideo).mockImplementation(async (row) => ({ video: row }))
  vi.mocked(api.deleteVideo).mockResolvedValue(undefined)
  vi.mocked(api.reorderChannels).mockResolvedValue(undefined)
})

describe('saving a video', () => {
  it('creates a row on the first pin and keeps it through a favourite', async () => {
    await useYoutubeStore.getState().saveVideo(video, { pinned: true })
    expect(useYoutubeStore.getState().library.videos).toHaveLength(1)
    expect(useYoutubeStore.getState().library.videos[0]!.pinned).toBe(true)

    await useYoutubeStore.getState().saveVideo(video, { favorited: true })
    const row = useYoutubeStore.getState().library.videos[0]!
    expect(row.pinned).toBe(true)
    expect(row.favorited).toBe(true)
  })

  it('deletes the row when the last marker is removed', async () => {
    await useYoutubeStore.getState().saveVideo(video, { pinned: true })
    await useYoutubeStore.getState().saveVideo(video, { pinned: false })
    expect(api.deleteVideo).toHaveBeenCalledWith(video.id)
    expect(useYoutubeStore.getState().library.videos).toHaveLength(0)
  })

  it('keeps a tagged row after both toggles are off', async () => {
    await useYoutubeStore.getState().saveVideo(video, { pinned: true, tagIds: ['tag1'] })
    await useYoutubeStore.getState().saveVideo(video, { pinned: false })
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(useYoutubeStore.getState().library.videos).toHaveLength(1)
  })

  it('rolls back an optimistic write the api refused', async () => {
    const existing = saved({ favorited: true })
    reset({ videos: [existing] })
    vi.mocked(api.putVideo).mockRejectedValueOnce(new Error('offline'))
    await expect(
      useYoutubeStore.getState().saveVideo(video, { pinned: true }),
    ).rejects.toThrow('offline')
    expect(useYoutubeStore.getState().library.videos).toEqual([existing])
  })
})

describe('reordering the sidebar', () => {
  it('applies the new order optimistically and persists it', async () => {
    reset({
      channels: [
        { id: 'UC1', data: {} as never, tagIds: [], pinned: false, sortOrder: 0, notes: '', createdAt: 1, updatedAt: 1 },
        { id: 'UC2', data: {} as never, tagIds: [], pinned: false, sortOrder: 1, notes: '', createdAt: 2, updatedAt: 2 },
      ],
    })
    await useYoutubeStore.getState().reorderChannels(['UC2', 'UC1'])
    const channels = useYoutubeStore.getState().library.channels
    expect(channels.find((channel) => channel.id === 'UC2')?.sortOrder).toBe(0)
    expect(channels.find((channel) => channel.id === 'UC1')?.sortOrder).toBe(1)
    expect(api.reorderChannels).toHaveBeenCalledWith(['UC2', 'UC1'])
  })

  it('rolls the order back when the server refuses it', async () => {
    const before = [
      { id: 'UC1', data: {} as never, tagIds: [], pinned: false, sortOrder: 0, notes: '', createdAt: 1, updatedAt: 1 },
      { id: 'UC2', data: {} as never, tagIds: [], pinned: false, sortOrder: 1, notes: '', createdAt: 2, updatedAt: 2 },
    ]
    reset({ channels: before })
    vi.mocked(api.reorderChannels).mockRejectedValueOnce(new Error('offline'))
    await expect(useYoutubeStore.getState().reorderChannels(['UC2', 'UC1'])).rejects.toThrow('offline')
    expect(useYoutubeStore.getState().library.channels).toEqual(before)
  })
})

describe('removing a tag', () => {
  it('strips the subtree from rows and deletes a video left with no marker', async () => {
    const parent = tag('parent')
    const child = tag('child', 'parent')
    reset({
      tags: [parent, child],
      videos: [saved({ tagIds: ['child'] })],
      channels: [{ id: 'UC1', data: {} as never, tagIds: ['parent'], pinned: false, sortOrder: 0, notes: '', createdAt: 1, updatedAt: 1 }],
      playlists: [],
    })
    vi.mocked(api.deleteTag).mockResolvedValue({ removedTagIds: ['parent', 'child'] })

    await useYoutubeStore.getState().removeTag('parent')

    const state = useYoutubeStore.getState().library
    expect(state.tags).toHaveLength(0)
    expect(state.videos).toHaveLength(0)
    expect(state.channels[0]!.tagIds).toHaveLength(0)
  })
})
