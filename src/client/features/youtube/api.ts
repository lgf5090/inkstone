/** The client half of `/api/youtube`: one typed function per route, no fetch calls elsewhere. */
import { request } from '../../lib/api'
import type {
  SavedYouTubeChannel,
  SavedYouTubePlaylist,
  SavedYouTubeVideo,
  YouTubeChannel,
  YouTubeComment,
  YouTubeCommentList,
  YouTubeDiscoverResult,
  YouTubeLibrary,
  YouTubeListResult,
  YouTubePlaylist,
  YouTubePrefs,
  YouTubeQuotaData,
  YouTubeTag,
  YouTubeVideo,
} from '@shared/youtube/model'
import type { YouTubeSettingsPatch, YouTubeSettingsView } from '@shared/youtube/settings'

export type {
  YouTubeCommentList,
  YouTubeDiscoverResult,
  YouTubeLibrary,
  YouTubeListResult,
  YouTubePrefs,
  YouTubeQuotaData,
}

export function fetchDiscover(
  input: { q: string; sort: YouTubePrefs['sort']; range: YouTubePrefs['range']; pageToken?: string },
  signal?: AbortSignal,
): Promise<YouTubeDiscoverResult> {
  const params = new URLSearchParams()
  if (input.q) params.set('q', input.q)
  if (input.q) params.set('order', input.sort)
  if (input.q) params.set('range', input.range)
  if (input.pageToken) params.set('pageToken', input.pageToken)
  const query = params.toString()
  return request<YouTubeDiscoverResult>(`/api/youtube/discover${query ? `?${query}` : ''}`, { signal })
}

export function fetchChannel(id: string, signal?: AbortSignal): Promise<{ channel: YouTubeChannel }> {
  return request(`/api/youtube/channels/${encodeURIComponent(id)}`, { signal })
}

export function fetchChannelVideos(id: string, pageToken?: string, signal?: AbortSignal): Promise<YouTubeListResult<YouTubeVideo>> {
  return request(`/api/youtube/channels/${encodeURIComponent(id)}/videos${page(pageToken)}`, { signal })
}

export function fetchChannelPlaylists(id: string, pageToken?: string, signal?: AbortSignal): Promise<YouTubeListResult<YouTubePlaylist>> {
  return request(`/api/youtube/channels/${encodeURIComponent(id)}/playlists${page(pageToken)}`, { signal })
}

export function fetchPlaylist(id: string, signal?: AbortSignal): Promise<{ playlist: YouTubePlaylist }> {
  return request(`/api/youtube/playlists/${encodeURIComponent(id)}`, { signal })
}

export function fetchPlaylistVideos(id: string, pageToken?: string, signal?: AbortSignal): Promise<YouTubeListResult<YouTubeVideo>> {
  return request(`/api/youtube/playlists/${encodeURIComponent(id)}/videos${page(pageToken)}`, { signal })
}

export function fetchVideo(id: string, signal?: AbortSignal): Promise<{ video: YouTubeVideo }> {
  return request(`/api/youtube/videos/${encodeURIComponent(id)}`, { signal })
}

export function fetchComments(id: string, pageToken?: string, signal?: AbortSignal): Promise<YouTubeCommentList> {
  return request(`/api/youtube/videos/${encodeURIComponent(id)}/comments${page(pageToken)}`, { signal })
}

export function fetchYouTubeSettings(signal?: AbortSignal): Promise<YouTubeSettingsView> {
  return request('/api/youtube/settings', { signal })
}

export function updateYouTubeSettings(patch: YouTubeSettingsPatch): Promise<YouTubeSettingsView> {
  return request('/api/youtube/settings', {
    method: 'PUT',
    body: patch as Record<string, unknown>,
  })
}

export function fetchQuota(signal?: AbortSignal): Promise<YouTubeQuotaData> {
  return request('/api/youtube/quota', { signal })
}

export function fetchLibrary(signal?: AbortSignal): Promise<YouTubeLibrary> {
  return request('/api/youtube/library', { signal })
}

export function putVideo(video: SavedYouTubeVideo): Promise<{ video: SavedYouTubeVideo }> {
  return request(`/api/youtube/library/videos/${encodeURIComponent(video.id)}`, {
    method: 'PUT',
    body: {
      data: video.data,
      pinned: video.pinned,
      favorited: video.favorited,
      tagIds: video.tagIds,
      notes: video.notes,
    },
  })
}

export function deleteVideo(id: string): Promise<void> {
  return request(`/api/youtube/library/videos/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function putChannel(channel: SavedYouTubeChannel): Promise<{ channel: SavedYouTubeChannel }> {
  return request(`/api/youtube/library/channels/${encodeURIComponent(channel.id)}`, {
    method: 'PUT',
    body: { data: channel.data, pinned: channel.pinned, sortOrder: channel.sortOrder, tagIds: channel.tagIds, notes: channel.notes },
  })
}

export function deleteChannel(id: string): Promise<void> {
  return request(`/api/youtube/library/channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function putPlaylist(playlist: SavedYouTubePlaylist): Promise<{ playlist: SavedYouTubePlaylist }> {
  return request(`/api/youtube/library/playlists/${encodeURIComponent(playlist.id)}`, {
    method: 'PUT',
    body: {
      data: playlist.data,
      pinned: playlist.pinned,
      favorited: playlist.favorited,
      sortOrder: playlist.sortOrder,
      tagIds: playlist.tagIds,
      notes: playlist.notes,
    },
  })
}

export function deletePlaylist(id: string): Promise<void> {
  return request(`/api/youtube/library/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function createTag(input: { name: string; color: string; parentId: string | null }): Promise<{ tag: YouTubeTag }> {
  return request('/api/youtube/library/tags', { method: 'POST', body: input })
}

export function updateTag(id: string, patch: Partial<Pick<YouTubeTag, 'name' | 'color' | 'parentId' | 'sortOrder' | 'pinned'>>): Promise<{ tag: YouTubeTag }> {
  return request(`/api/youtube/library/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
}

export function reorderTags(ids: string[]): Promise<void> {
  return request('/api/youtube/library/tags/order', { method: 'PATCH', body: { ids } })
}

export function reorderChannels(ids: string[]): Promise<void> {
  return request('/api/youtube/library/channels/order', { method: 'PATCH', body: { ids } })
}

export function reorderPlaylists(ids: string[]): Promise<void> {
  return request('/api/youtube/library/playlists/order', { method: 'PATCH', body: { ids } })
}

export function deleteTag(id: string): Promise<{ removedTagIds: string[] }> {
  return request(`/api/youtube/library/tags/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function thumbnailUrl(videoId: string): string {
  return `/api/youtube/media/thumbnail/${encodeURIComponent(videoId)}`
}

export function channelIconUrl(channelId: string): string {
  return `/api/youtube/media/channel/${encodeURIComponent(channelId)}`
}

function page(token?: string): string {
  return token ? `?pageToken=${encodeURIComponent(token)}` : ''
}

export type { YouTubeComment }
