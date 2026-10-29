/** The YouTube tab's one store: the saved library, its writes, and the layout the reader chose. */
import { create } from 'zustand'
import {
  shouldDeleteSavedVideo,
  tagSubtreeIds,
  type SavedYouTubeChannel,
  type SavedYouTubePlaylist,
  type SavedYouTubeVideo,
  type YouTubeChannel,
  type YouTubeLibrary,
  type YouTubePlaylist,
  type YouTubeTag,
  type YouTubeVideo,
} from '@shared/youtube/model'
import {
  createTag,
  deleteChannel as apiDeleteChannel,
  deletePlaylist as apiDeletePlaylist,
  deleteTag as apiDeleteTag,
  deleteVideo as apiDeleteVideo,
  fetchLibrary,
  putChannel,
  putPlaylist,
  putVideo,
  reorderChannels as apiReorderChannels,
  reorderPlaylists as apiReorderPlaylists,
  reorderTags as apiReorderTags,
  updateTag,
} from './api'
import {
  defaultYouTubeUiPrefs,
  loadYouTubeUiPrefs,
  saveYouTubeUiPrefs,
  type YouTubeSection,
  type YouTubeUiPrefs,
} from './prefs'

type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

const EMPTY_LIBRARY: YouTubeLibrary = { tags: [], videos: [], channels: [], playlists: [], truncated: false }

interface VideoPatch {
  pinned?: boolean
  favorited?: boolean
  tagIds?: string[]
  notes?: string
}

export interface YouTubeState extends YouTubeUiPrefs {
  library: YouTubeLibrary
  libraryStatus: LibraryStatus
  libraryError: string | null
  pending: string[]
  reloadLibrary: () => Promise<void>
  ensureLibrary: () => void
  setPrefs: (patch: Partial<YouTubeUiPrefs>) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setSplitRatio: (ratio: number) => void
  toggleSection: (section: YouTubeSection) => void
  toggleTagExpanded: (tagId: string) => void
  expandTag: (tagId: string) => void
  setExpandedTags: (ids: string[]) => void
  saveVideo: (video: YouTubeVideo, patch: VideoPatch) => Promise<void>
  saveChannel: (channel: YouTubeChannel) => Promise<void>
  updateChannel: (channel: SavedYouTubeChannel) => Promise<void>
  removeChannel: (id: string) => Promise<void>
  savePlaylist: (playlist: YouTubePlaylist) => Promise<void>
  updatePlaylist: (playlist: SavedYouTubePlaylist) => Promise<void>
  removePlaylist: (id: string) => Promise<void>
  addTag: (input: { name: string; color: string; parentId: string | null }) => Promise<YouTubeTag>
  editTag: (id: string, patch: Partial<Pick<YouTubeTag, 'name' | 'color' | 'parentId' | 'sortOrder' | 'pinned'>>) => Promise<void>
  reorderChannels: (ids: string[]) => Promise<void>
  reorderPlaylists: (ids: string[]) => Promise<void>
  reorderTags: (ids: string[]) => Promise<void>
  removeTag: (id: string) => Promise<void>
}

const initialPrefs = loadYouTubeUiPrefs()

export const useYoutubeStore = create<YouTubeState>((set, get) => {
  const persist = (patch: Partial<YouTubeUiPrefs>) => {
    const next = { ...readPrefs(get()), ...patch }
    saveYouTubeUiPrefs(next)
    set(patch as Partial<YouTubeState>)
  }

  return {
    ...initialPrefs,
    library: EMPTY_LIBRARY,
    libraryStatus: 'idle',
    libraryError: null,
    pending: [],

    async reloadLibrary() {
      set({ libraryStatus: 'loading', libraryError: null })
      try {
        const library = normalizeLibrary(await fetchLibrary())
        set({ library, libraryStatus: 'ready', libraryError: null })
      } catch (error) {
        set({ libraryStatus: 'error', libraryError: messageOf(error) })
        throw error
      }
    },

    ensureLibrary() {
      const status = get().libraryStatus
      if (status === 'idle' || status === 'error') {
        void get().reloadLibrary().catch(() => {
          // reloadLibrary already stored libraryError, which the sidebar and list render; this is a boot kick, not a second reporter.
        })
      }
    },

    setPrefs(patch) {
      persist(patch)
    },

    toggleSidebar() {
      persist({ sidebarCollapsed: !get().sidebarCollapsed })
    },

    setSidebarWidth(width) {
      persist({ sidebarWidth: width })
    },

    setSplitRatio(ratio) {
      persist({ splitRatio: ratio })
    },

    toggleSection(section) {
      const current = get().expandedSections
      persist({
        expandedSections: current.includes(section)
          ? current.filter((entry) => entry !== section)
          : [...current, section],
      })
    },

    toggleTagExpanded(tagId) {
      const current = get().expandedTags
      persist({
        expandedTags: current.includes(tagId)
          ? current.filter((entry) => entry !== tagId)
          : [...current, tagId],
      })
    },

    expandTag(tagId) {
      if (get().expandedTags.includes(tagId)) return
      persist({ expandedTags: [...get().expandedTags, tagId] })
    },

    setExpandedTags(ids) {
      persist({ expandedTags: [...new Set(ids)] })
    },

    async saveVideo(video, patch) {
      const previous = get().library
      const existing = previous.videos.find((entry) => entry.id === video.id)
      const now = Date.now()
      const next: SavedYouTubeVideo = {
        id: video.id,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        channelId: video.channelId,
        channelTitle: video.channelTitle,
        data: video,
        tagIds: existing?.tagIds ?? [],
        pinned: existing?.pinned ?? false,
        favorited: existing?.favorited ?? false,
        notes: existing?.notes ?? '',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...patch,
      }
      const remove = shouldDeleteSavedVideo(next)
      const optimistic = remove
        ? previous.videos.filter((entry) => entry.id !== video.id)
        : upsert(previous.videos, next, (entry) => entry.id)
      set({ library: { ...previous, videos: optimistic } })
      try {
        if (remove) {
          await apiDeleteVideo(video.id)
        } else {
          const saved = await putVideo(next)
          set({ library: { ...get().library, videos: upsert(get().library.videos, saved.video, (entry) => entry.id) } })
        }
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async saveChannel(channel) {
      const previous = get().library
      const now = Date.now()
      const existing = previous.channels.find((entry) => entry.id === channel.id)
      const next: SavedYouTubeChannel = existing ?? {
        id: channel.id,
        data: channel,
        tagIds: [],
        pinned: false,
        sortOrder: 0,
        notes: '',
        createdAt: now,
        updatedAt: now,
      }
      set({ library: { ...previous, channels: upsert(previous.channels, next, (entry) => entry.id) } })
      try {
        const saved = await putChannel(next)
        set({ library: { ...get().library, channels: upsert(get().library.channels, saved.channel, (entry) => entry.id) } })
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async updateChannel(channel) {
      const previous = get().library
      set({ library: { ...previous, channels: upsert(previous.channels, channel, (entry) => entry.id) } })
      try {
        const saved = await putChannel(channel)
        set({ library: { ...get().library, channels: upsert(get().library.channels, saved.channel, (entry) => entry.id) } })
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async removeChannel(id) {
      const previous = get().library
      set({ library: { ...previous, channels: previous.channels.filter((entry) => entry.id !== id) } })
      try {
        await apiDeleteChannel(id)
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async savePlaylist(playlist) {
      const previous = get().library
      const now = Date.now()
      const existing = previous.playlists.find((entry) => entry.id === playlist.id)
      const next: SavedYouTubePlaylist = existing ?? {
        id: playlist.id,
        data: playlist,
        tagIds: [],
        pinned: false,
        favorited: false,
        sortOrder: 0,
        notes: '',
        createdAt: now,
        updatedAt: now,
      }
      set({ library: { ...previous, playlists: upsert(previous.playlists, next, (entry) => entry.id) } })
      try {
        const saved = await putPlaylist(next)
        set({ library: { ...get().library, playlists: upsert(get().library.playlists, saved.playlist, (entry) => entry.id) } })
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async updatePlaylist(playlist) {
      const previous = get().library
      set({ library: { ...previous, playlists: upsert(previous.playlists, playlist, (entry) => entry.id) } })
      try {
        const saved = await putPlaylist(playlist)
        set({ library: { ...get().library, playlists: upsert(get().library.playlists, saved.playlist, (entry) => entry.id) } })
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async removePlaylist(id) {
      const previous = get().library
      set({ library: { ...previous, playlists: previous.playlists.filter((entry) => entry.id !== id) } })
      try {
        await apiDeletePlaylist(id)
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async addTag(input) {
      const { tag } = await createTag(input)
      const library = get().library
      set({ library: { ...library, tags: [...library.tags, tag] } })
      return tag
    },

    async editTag(id, patch) {
      const { tag } = await updateTag(id, patch)
      const library = get().library
      set({ library: { ...library, tags: library.tags.map((entry) => (entry.id === id ? tag : entry)) } })
    },

    async reorderChannels(ids) {
      const previous = get().library
      const order = new Map(ids.map((id, index) => [id, index]))
      set({
        library: {
          ...previous,
          channels: previous.channels.map((channel) => (
            order.has(channel.id) ? { ...channel, sortOrder: order.get(channel.id)! } : channel
          )),
        },
      })
      try {
        await apiReorderChannels(ids)
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async reorderPlaylists(ids) {
      const previous = get().library
      const order = new Map(ids.map((id, index) => [id, index]))
      set({
        library: {
          ...previous,
          playlists: previous.playlists.map((playlist) => (
            order.has(playlist.id) ? { ...playlist, sortOrder: order.get(playlist.id)! } : playlist
          )),
        },
      })
      try {
        await apiReorderPlaylists(ids)
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async reorderTags(ids) {
      const previous = get().library
      const order = new Map(ids.map((id, index) => [id, index]))
      set({
        library: {
          ...previous,
          tags: previous.tags.map((tag) => (
            order.has(tag.id) ? { ...tag, sortOrder: order.get(tag.id)! } : tag
          )),
        },
      })
      try {
        await apiReorderTags(ids)
      } catch (error) {
        set({ library: previous })
        throw error
      }
    },

    async removeTag(id) {
      const { removedTagIds } = await apiDeleteTag(id)
      const removed = new Set(removedTagIds.length ? removedTagIds : [...tagSubtreeIds(get().library.tags, id)])
      const library = get().library
      const strip = (tagIds: string[]) => tagIds.filter((tagId) => !removed.has(tagId))
      const videos = library.videos
        .map((video) => ({ ...video, tagIds: strip(video.tagIds) }))
        .filter((video) => !shouldDeleteSavedVideo(video))
      set({
        library: {
          ...library,
          tags: library.tags.filter((tag) => !removed.has(tag.id)),
          videos,
          channels: library.channels.map((channel) => ({ ...channel, tagIds: strip(channel.tagIds) })),
          playlists: library.playlists.map((playlist) => ({ ...playlist, tagIds: strip(playlist.tagIds) })),
        },
      })
    },
  }
})

function readPrefs(state: YouTubeState): YouTubeUiPrefs {
  return {
    sort: state.sort,
    range: state.range,
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    splitRatio: state.splitRatio,
    showComments: state.showComments,
    expandedSections: state.expandedSections,
    expandedTags: state.expandedTags,
  }
}

function normalizeLibrary(value: YouTubeLibrary): YouTubeLibrary {
  return {
    tags: Array.isArray(value.tags) ? value.tags : [],
    videos: Array.isArray(value.videos) ? value.videos : [],
    channels: Array.isArray(value.channels) ? value.channels : [],
    playlists: Array.isArray(value.playlists) ? value.playlists : [],
    truncated: Boolean(value.truncated),
  }
}

function upsert<T>(list: T[], item: T, key: (value: T) => string): T[] {
  const id = key(item)
  const index = list.findIndex((entry) => key(entry) === id)
  if (index < 0) return [...list, item]
  const next = list.slice()
  next[index] = item
  return next
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/** The same defaults the persisted loader starts from, for tests and a reset button. */
export function resetYouTubeUiPrefs(): YouTubeUiPrefs {
  return defaultYouTubeUiPrefs()
}
